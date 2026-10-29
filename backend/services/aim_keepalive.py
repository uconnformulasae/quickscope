"""UDP ``aim-ka`` keep-alive for the primary AiM TCP session.

The EVO5 closes the port-2000 TCP connection ~30 s after the later of
(TCP connect, last ``aim-ka`` UDP datagram). Race Studio never hits that
watchdog because it sends ``aim-ka`` from UDP 36002 -> 36002 roughly every
1.09 s for as long as it is connected (RS3-9-22-26-long, RS3_live_1min,
RS3-5-47). Without it, QuickScope was dropped every 30.8 s and paid a full
reconnect + handshake each time (long-working.pcapng, max_buffer_timeout.pcapng).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from services.aim_device_cache import record_from_parsed
from services.aim_discovery import DISCOVERY_MAGIC, DISCOVERY_PORT, parse_discovery_text

logger = logging.getLogger(__name__)

KEEPALIVE_INTERVAL_S = 1.0


class _KeepaliveProtocol(asyncio.DatagramProtocol):
    def __init__(self, owner: "AimKeepalive") -> None:
        self._owner = owner

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        self._owner._on_reply(data, addr[0])

    def error_received(self, exc: Exception) -> None:
        # ICMP port-unreachable etc. while the logger reboots; the send loop keeps going.
        logger.debug("AiM keepalive: UDP error %s", exc)


class AimKeepalive:
    """Periodically send ``aim-ka`` to the device and track its replies."""

    def __init__(
        self,
        host: str,
        *,
        interval_s: float = KEEPALIVE_INTERVAL_S,
        device_port: int = DISCOVERY_PORT,
        local_port: int = DISCOVERY_PORT,
    ) -> None:
        self.host = host
        self.interval_s = interval_s
        self.device_port = device_port
        self.local_port = local_port
        self.bound_port: Optional[int] = None
        self.sent_count = 0
        self.reply_count = 0
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._last_reply_monotonic: Optional[float] = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def last_reply_age_s(self) -> Optional[float]:
        if self._last_reply_monotonic is None:
            return None
        return time.monotonic() - self._last_reply_monotonic

    async def start(self) -> None:
        if self.running:
            return
        self._transport = await self._open_transport()
        self._task = asyncio.create_task(self._send_loop(), name="aim-keepalive")
        logger.info(
            "AiM keepalive: sending aim-ka to %s:%d every %.2fs from UDP port %d",
            self.host,
            self.device_port,
            self.interval_s,
            self.bound_port or 0,
        )

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        logger.info(
            "AiM keepalive: stopped (sent=%d replies=%d)", self.sent_count, self.reply_count
        )

    async def _open_transport(self) -> asyncio.DatagramTransport:
        loop = asyncio.get_running_loop()
        try:
            transport, _ = await loop.create_datagram_endpoint(
                lambda: _KeepaliveProtocol(self), local_addr=("0.0.0.0", self.local_port)
            )
        except OSError as exc:
            # Race Studio (or another QuickScope) may already own 36002; the
            # device replies to whatever source port it sees, so ephemeral works.
            logger.warning(
                "AiM keepalive: UDP port %d unavailable (%s); using an ephemeral port",
                self.local_port,
                exc,
            )
            transport, _ = await loop.create_datagram_endpoint(
                lambda: _KeepaliveProtocol(self), local_addr=("0.0.0.0", 0)
            )
        self.bound_port = transport.get_extra_info("sockname")[1]
        return transport

    async def _send_loop(self) -> None:
        while True:
            if self._transport is not None:
                try:
                    self._transport.sendto(DISCOVERY_MAGIC, (self.host, self.device_port))
                    self.sent_count += 1
                except OSError as exc:
                    logger.debug("AiM keepalive: send failed: %s", exc)
            await asyncio.sleep(self.interval_s)

    def _on_reply(self, data: bytes, ip: str) -> None:
        if not data:
            return
        self.reply_count += 1
        self._last_reply_monotonic = time.monotonic()
        record_from_parsed(parse_discovery_text(ip, data))
