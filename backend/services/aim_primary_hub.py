"""Shared primary TCP session to the AiM device (Race Studio model).

Wireshark reference: ``connect.pcapng`` stream 29 — one TCP socket for connect,
live enumeration, live polling, and session list. Log file download uses a
**second** TCP (``116CaptureWireshark.pcapng`` stream 38) via ``aim_connector.download_aim_session``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from services.aim_device_cache import get_cached
from services.aim_discovery import DEFAULT_DEVICE_IP, configured_device_ip
from services.aim_live import AimLiveClient
from services.aim_live_trace import AimLiveTrace
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

_hub: Optional[AimPrimaryHub] = None


def get_aim_primary_hub() -> AimPrimaryHub:
    global _hub
    if _hub is None:
        _hub = AimPrimaryHub()
    return _hub


class AimPrimaryHub:
    """One primary ``AimLiveClient`` TCP; exclusive lock for live vs list."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = asyncio.Lock()
        self._client: AimLiveClient | None = None
        self._live_active = False

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def can_run_async(self) -> bool:
        return self._loop is not None and self._loop.is_running()

    def run_sync(self, coro):  # noqa: ANN001
        if self._loop is None:
            raise RuntimeError("AiM primary hub has no event loop")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=120)

    def _resolve_host(self, host: str | None) -> str:
        if host:
            return host
        cached = get_cached()
        if cached is not None:
            return cached.ip
        return load_settings().get("aim_device_ip", configured_device_ip() or DEFAULT_DEVICE_IP)

    async def ensure_primary(
        self,
        host: str | None = None,
        *,
        trace: AimLiveTrace | None = None,
    ) -> AimLiveClient:
        """Connect + live handshake on primary TCP if not already up."""
        target = self._resolve_host(host)
        if (
            self._client is not None
            and self._client.connected
            and getattr(self._client, "_handshake_done", False)
            and self._client.host == target
        ):
            return self._client

        await self.close_primary()
        logger.info("AiM primary hub: opening TCP to %s (live handshake)", target)
        client = AimLiveClient(host=target, trace=trace)
        await client.connect()
        self._client = client
        return client

    async def list_sessions(self, host: str | None = None) -> list[dict]:
        async with self._lock:
            if self._live_active:
                raise ConnectionError(
                    "Cannot list AiM sessions while live view is active. "
                    "Close live view first."
                )
            client = await self.ensure_primary(host)
            return await client.fetch_session_list()

    async def acquire_for_live(
        self,
        host: str | None = None,
        *,
        trace: AimLiveTrace | None = None,
    ) -> AimLiveClient:
        await self._lock.acquire()
        try:
            self._live_active = True
            return await self.ensure_primary(host, trace=trace)
        except Exception:
            self._live_active = False
            self._lock.release()
            raise

    async def release_live(self) -> None:
        try:
            self._live_active = False
            if self._client is not None:
                await self._client.stop_streaming()
            logger.info("AiM primary hub: live released, TCP kept open")
        finally:
            if self._lock.locked():
                self._lock.release()

    async def release_for_download(self) -> None:
        """Close primary TCP so ``download_aim_session`` can open the second RS3 socket."""
        if self._live_active:
            raise ConnectionError(
                "Close live view before downloading logs from the AiM device."
            )
        await self.close_primary()
        logger.info("AiM primary hub: released primary TCP for file download")

    async def close_primary(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
        self._live_active = False
