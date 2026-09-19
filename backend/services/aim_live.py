"""
Live-data client for AiM EVO5 (and likely other AiM Race Studio devices).

**Ground truth:** Race Studio 3 Wireshark captures (verify every handshake change):

- ``c:\\Users\\jesse\\Downloads\\Live.pcapng`` (tcp.stream 1 — connect + live)
- ``c:\\Users\\jesse\\Downloads\\live_pedal.pcapng`` (tcp.stream 45 — live + TPS)

Repo fixtures: ``docs/protocol/captures/fixtures/`` · spec notes: ``docs/protocol/captures/SOURCE_CAPTURES.md``

QuickScope JSONL under ``backend/data/logs/aim_live/`` is for debugging our client, not the protocol spec.

Speaks the protocol documented in `docs/protocol/aim-live-protocol.md`. The
flow:

1. UDP discovery probe (port 36002) — optional when a recent device cache exists from session browser / pull.
2. TCP connect to port 2000.
3. 8-byte STCP "hello" exchange.
4. RS3 enumeration (3× STNC 0x00010010, extra 0x00010006, one-shot setup STNCs).
5. Steady-state live poll: RS3 pair ``0x00020003`` / ``0x00020053`` + one micro
   each (~125 ms). UConn 113-channel logger uses **707 B** ``Syst`` frames
   (``Q:703``), not only 691 B (``RS3-5-47.pcapng``).

This module is intentionally separate from `aim_connector.py`. That file
implements the **session-list-download** flow (different STNC sub-cmds,
different lifecycle) and we keep it untouched. Live streaming is purely
read-only — we never tell the device to start/stop logging, and we never
write anything to its filesystem.

Field-level decoding uses the channel-layout frame from setup (see ``aim_live_layout``).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import struct
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, AsyncIterator, Optional

if TYPE_CHECKING:
    from services.aim_live_trace import AimLiveTrace

from services.aim_discovery import (
    DATA_PORT,
    DEFAULT_DEVICE_IP,
    DISCOVERY_PORT,
    candidate_device_ips,
    configured_device_ip,
    probe_device_ips,
)
from services.aim_device_cache import get_cached, record_identity
from services.aim_live_layout import (
    ChannelField,
    decode_live_channels,
    is_layout_blob,
    parse_channel_layout,
)

logger = logging.getLogger(__name__)

# 103-channel legacy vs 113-channel UConn EVO5 (RS3-5-47 / live_pedal use Q:703 → 707 B).
LIVE_FRAME_SIZE_LEGACY = 547
LIVE_FRAME_SIZE_113CH = 707
POLL_INTERVAL_S = 0.125  # RS3 steady poll step (RS3-5-47.pcapng)
POLL_STNC_DRAIN_S = 0.4
SETUP_DRAIN_IDLE_S = 0.35

_ENUM_BLOB_MIN_LEN = 3400


def user_visible_error(exc: BaseException) -> str:
    """Human-readable message for UI/logs when str(exc) is empty."""
    text = str(exc).strip()
    if text:
        return text
    if isinstance(exc, TimeoutError):
        return (
            "Timed out waiting for the AiM device on TCP port 2000. "
            "UDP discovery can succeed while live TCP is blocked — close Race Studio "
            "live view, confirm you are on the logger WiFi, and retry."
        )
    return f"{type(exc).__name__} (no detail — see backend/data/logs/aim_live/)"


# ── Outer envelope helpers (see docs/protocol/aim-live-protocol.md §3) ──


def _checksum(payload: bytes) -> int:
    """Trailer u16 = sum of payload bytes mod 0x10000."""
    return sum(payload) & 0xFFFF


def encode_frame(cmd: bytes, payload: bytes, flag: int = 0) -> bytes:
    """Encode an outer envelope. `cmd` must be 4 ASCII bytes."""
    if len(cmd) != 4:
        raise ValueError("cmd must be exactly 4 bytes")
    header = b"<h" + cmd + struct.pack("<I", len(payload)) + bytes([flag]) + b">"
    trailer = b"<" + cmd + struct.pack("<H", _checksum(payload)) + b">"
    return header + payload + trailer


@dataclass
class Frame:
    cmd: bytes
    flag: int
    payload: bytes
    trailer: int


def decode_frame(buf: bytes, offset: int = 0) -> tuple[Optional[Frame], int]:
    """Try to decode one frame starting at buf[offset].

    Returns (frame_or_none, bytes_consumed). If there is not enough data
    yet, returns (None, 0). Raises ValueError on truly invalid bytes.
    """
    if len(buf) - offset < 12:
        return None, 0
    if buf[offset : offset + 2] != b"<h":
        raise ValueError(f"bad header magic at offset {offset}")
    cmd = buf[offset + 2 : offset + 6]
    if not all(0x20 <= b < 0x7F for b in cmd):
        raise ValueError(f"non-ASCII cmd code at offset {offset}: {cmd!r}")
    length = int.from_bytes(buf[offset + 6 : offset + 10], "little")
    flag = buf[offset + 10]
    if buf[offset + 11 : offset + 12] != b">":
        raise ValueError(f"bad header end at offset {offset}")
    total = 12 + length + 8
    if len(buf) - offset < total:
        return None, 0
    ps = offset + 12
    pe = ps + length
    if buf[pe : pe + 1] != b"<":
        raise ValueError(f"bad trailer start at offset {pe}")
    cmd2 = buf[pe + 1 : pe + 5]
    if cmd2 != cmd:
        raise ValueError(f"cmd mismatch: {cmd!r} != {cmd2!r}")
    trailer = int.from_bytes(buf[pe + 5 : pe + 7], "little")
    if buf[pe + 7 : pe + 8] != b">":
        raise ValueError(f"bad trailer end at offset {pe + 7}")
    return Frame(cmd=cmd, flag=flag, payload=buf[ps:pe], trailer=trailer), total


# ── Protocol payload constants captured from Race Studio ────────────────────


_STCP_HELLO = b"\x00\x00\x00\x00\x06\x08\x00\x00"
_STCP_4BYTE_ACK = b"\x00\x00\x00\x00"
_STCP_OP_A = ord("A")
_STCP_OP_H = ord("H")  # device asks for enum date follow-up (same response as 'A')
_STCP_OP_I = ord("I")
_STCP_OP_Q = ord("Q")
_STCP_OP_E = ord("E")


def _stnc_payload(sub_cmd: int) -> bytes:
    """Build a 64-byte STNC payload with the given sub-cmd at offset 8."""
    p = bytearray(64)
    p[8:12] = struct.pack("<I", sub_cmd)
    # Race Studio layout (Live.pcapng / QuickScope_live.pcapng): enum STNCs also
    # set payload[16]=0x40 ('@'); every STNC uses payload[24]=0x41 ('A').
    if sub_cmd in (STNC_SYSTEM, STNC_ENUM_AUX):
        p[16] = 0x40
    p[24] = 0x41
    return bytes(p)


STNC_SYSTEM = 0x00010010
STNC_ENUM_AUX = 0x00010006
STNC_LIVE_POLL_A = 0x00020003
STNC_LIVE_POLL_B = 0x00020053
# Session list on primary TCP (connect.pcapng / 116 stream 37 after live handshake)
STNC_PREP_SESSIONS = 0x00020051
STNC_GET_SESSIONS = 0x00020024
STNC_SETUP_FINAL = 0x00020008  # Live.pcapng: no driver micro after this STNC before steady poll
STNC_SETUP_SELECTORS = (
    0x00060024,
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    0x00060028,
    0x00020002,
    STNC_SETUP_FINAL,
)


# 68-byte STCP date follow-up: two identical 34-byte blocks (see Live.pcapng stream 1).


def _stcp_date_followup(now: datetime | None = None) -> bytes:
    """68-byte STCP payload with host date/time (Race Studio enumeration follow-up).

    Layout (two 34-byte blocks): year u16@+12, month u32@+16, day u32@+20,
    hour u32@+28, minute u16@+32 within each block — from Live.pcapng 2026.
    """
    now = now or datetime.now()
    buf = bytearray(68)
    for base in (0, 34):
        struct.pack_into("<H", buf, base + 12, now.year)
        struct.pack_into("<I", buf, base + 16, now.month)
        struct.pack_into("<I", buf, base + 20, now.day)
        struct.pack_into("<I", buf, base + 28, now.hour)
        struct.pack_into("<H", buf, base + 32, now.minute)
    return bytes(buf)


def _is_live_snapshot_payload(payload: bytes) -> bool:
    """547 / 691 / 707 B telemetry (113ch EVO5 steady state is often 707 B ``Syst``)."""
    if len(payload) not in (LIVE_FRAME_SIZE_LEGACY, 691, LIVE_FRAME_SIZE_113CH):
        return False
    if payload[:4] != b"\x00\x00\x00\x00":
        return False
    tag = payload[4:8]
    if tag.startswith(b"hhh"):
        return False
    return True


def _q_hint_live_payload_size(hint: int) -> int | None:
    """Next STCP payload length after Q-ack when the device will send a live snapshot."""
    next_len = hint + 4
    if next_len in (LIVE_FRAME_SIZE_LEGACY, 691, LIVE_FRAME_SIZE_113CH):
        return next_len
    return None


def _describe_frame(frame: Frame) -> str:
    """One-line summary for debug logs (no payload dump)."""
    cmd = frame.cmd.decode("ascii", errors="replace")
    pl = frame.payload
    if frame.cmd == b"STNC" and len(pl) >= 12:
        sub = int.from_bytes(pl[8:12], "little")
        return f"STNC sub=0x{sub:08x}"
    if frame.cmd != b"STCP":
        return f"{cmd} len={len(pl)}"
    n = len(pl)
    if n == 64 and n > 24:
        op = chr(pl[24]) if 32 <= pl[24] < 127 else f"0x{pl[24]:02x}"
        hint = struct.unpack("<I", pl[16:20])[0]
        return f"STCP len=64 op={op} next_len_hint={hint} (->{hint + 4}B payload)"
    if n == 12:
        tag = pl[4:8].decode("ascii", errors="replace").rstrip("\x00")
        return f"STCP len=12 heartbeat tag={tag!r}"
    if _is_live_snapshot_payload(pl):
        tag = pl[4:8].decode("ascii", errors="replace").rstrip("\x00")
        return f"STCP LIVE len={n} tag={tag!r}"
    return f"STCP len={n}"


# ── Identity (UDP discovery reply parsing) ──────────────────────────────────


@dataclass
class Identity:
    ip: str
    model: str = ""
    serial: str = ""
    vehicle: str = ""
    raw: bytes = field(default_factory=bytes, repr=False)


def parse_identity(addr_ip: str, data: bytes) -> Identity:
    """Parse a 244-byte UDP discovery reply into an Identity."""
    import re

    ident = Identity(ip=addr_ip, raw=data)
    text = data.decode("ascii", errors="replace")
    m = re.search(r"AiM-([A-Za-z0-9_]+)-(\d+)-([^\x00]+)", text)
    if m:
        ident.model = m.group(1)
        ident.serial = m.group(2)
        ident.vehicle = m.group(3).rstrip("\x00").rstrip()
    return ident


async def discover(timeout: float = 2.0, ip: str | None = None) -> Optional[Identity]:
    """UDP probe across candidate IPs (or a single IP if `ip` is set)."""
    if ip is not None:
        logger.info("AiM live discovery: probing single IP %s (timeout=%.1fs)", ip, timeout)
    else:
        candidates = candidate_device_ips()
        logger.info(
            "AiM live discovery: probing candidates %s (timeout=%.1fs)",
            candidates,
            timeout,
        )
    loop = asyncio.get_running_loop()

    def _probe() -> Optional[tuple[str, bytes]]:
        if ip is not None:
            from services.aim_discovery import udp_probe

            data = udp_probe(ip, timeout=timeout)
            return (ip, data) if data else None
        return probe_device_ips(timeout=timeout)

    result = await loop.run_in_executor(None, _probe)
    if not result:
        logger.warning(
            "AiM live discovery: no UDP reply on port %d (check WiFi / hotspot / Settings IP)",
            DISCOVERY_PORT,
        )
        return None
    ident = parse_identity(*result)
    record_identity(
        ident.ip,
        model=ident.model,
        serial=ident.serial,
        vehicle=ident.vehicle,
    )
    logger.info(
        "AiM live discovery: device at %s model=%s serial=%s vehicle=%s",
        ident.ip,
        ident.model or "?",
        ident.serial or "?",
        ident.vehicle or "?",
    )
    return ident


# ── Live snapshot ───────────────────────────────────────────────────────────


@dataclass
class LiveSnapshot:
    timestamp_ms: int
    subsystem: str
    raw_b64: str
    channels: dict[str, float] = field(default_factory=dict)


def parse_live_snapshot(
    payload: bytes,
    channel_fields: list[ChannelField] | None = None,
) -> LiveSnapshot:
    """Pull stable fields out of a live snapshot frame (547+ bytes)."""
    if len(payload) < 12:
        raise ValueError(f"live frame too short: {len(payload)}")
    subsystem = payload[4:8].decode("ascii", errors="replace").rstrip("\x00")
    timestamp_ms = int.from_bytes(payload[8:12], "little")
    channels: dict[str, float] = {}
    if channel_fields:
        channels = decode_live_channels(payload, channel_fields)
    return LiveSnapshot(
        timestamp_ms=timestamp_ms,
        subsystem=subsystem,
        raw_b64=base64.b64encode(payload).decode("ascii"),
        channels=channels,
    )


# ── Client ──────────────────────────────────────────────────────────────────


class AimLiveClient:
    """Async client for the AiM Live-data wire protocol."""

    def __init__(
        self,
        host: str = DEFAULT_DEVICE_IP,
        port: int = DATA_PORT,
        *,
        trace: Optional[AimLiveTrace] = None,
    ):
        self.host = host
        self.port = port
        self.identity: Optional[Identity] = None
        self._session_trace = trace
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._buf = bytearray()
        self._closed = False
        self._pending_live_size: Optional[int] = None
        self._handshake_done = False
        self._poll_a_timeouts = 0
        self._snapshots_yielded = 0
        self._decode_resync_bytes = 0
        self._channel_fields: list[ChannelField] = []
        self._frame_stash: deque[Frame] = deque()

    def _emit_trace(self, event: str, **fields: object) -> None:
        if self._session_trace is not None:
            self._session_trace.log(event, **fields)

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    async def connect(self, *, discover_first: bool = True, timeout: float = 15.0) -> None:
        configured = self.host
        self._emit_trace("connect_begin", configured_host=configured, timeout_s=timeout)
        cached = None
        # When the session browser already found the logger, skip redundant UDP.
        if discover_first:
            cached_fresh = get_cached()
            if cached_fresh is not None:
                discover_first = False
                cached = cached_fresh
                self._emit_trace(
                    "discover_skipped",
                    reason="recent_cache",
                    ip=cached_fresh.ip,
                    cache_age_s=round(cached_fresh.age_s(), 2),
                )
        if discover_first:
            self.identity = await discover()
            if self.identity is None:
                self._emit_trace("discover_failed")
                raise ConnectionError(
                    "AiM device not reachable via UDP discovery. "
                    "Connect to the device WiFi hotspot and check Settings."
                )
            self.host = self.identity.ip
            self._emit_trace(
                "discover_ok",
                ip=self.identity.ip,
                model=self.identity.model,
                serial=self.identity.serial,
                vehicle=self.identity.vehicle,
            )
        else:
            if cached is not None:
                self.host = cached.ip
                self.identity = Identity(
                    ip=cached.ip,
                    model=cached.model,
                    serial=cached.serial,
                    vehicle=cached.vehicle,
                )
                self._emit_trace(
                    "using_cached_device",
                    ip=cached.ip,
                    cache_age_s=round(cached.age_s(), 2),
                )
            else:
                self.host = configured or configured_device_ip()
                self.identity = Identity(ip=self.host)
                self._emit_trace("using_configured_host", ip=self.host)
        logger.info(
            "AiM live connect: TCP %s:%d (configured=%s discover_first=%s timeout=%.1fs)",
            self.host,
            self.port,
            configured,
            discover_first,
            timeout,
        )
        self._emit_trace("tcp_begin", host=self.host, port=self.port)
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port), timeout=timeout
            )
        except TimeoutError as exc:
            msg = (
                f"Timed out after {timeout:.0f}s opening TCP to {self.host}:{self.port}. "
                "Close Race Studio live view and run: Test-NetConnection "
                f"{self.host} -Port {self.port}"
            )
            logger.warning("AiM live connect: %s", msg)
            self._emit_trace("tcp_failed", reason="timeout", message=msg)
            raise ConnectionError(msg) from exc
        except OSError as exc:
            logger.warning("AiM live connect: TCP open failed: %s", exc)
            self._emit_trace("tcp_failed", reason="oserror", message=str(exc))
            raise ConnectionError(f"TCP connect to {self.host}:{self.port} failed: {exc}") from exc
        logger.info("AiM live connect: TCP open ok, sending STCP hello")
        self._emit_trace("tcp_ok")
        await self._send_stcp(_STCP_HELLO)
        self._emit_trace("hello_sent")
        try:
            hello_ack = await self._expect(b"STCP", min_payload_len=8, timeout=timeout)
        except TimeoutError as exc:
            msg = (
                f"Timed out after {timeout:.0f}s waiting for STCP hello-ack from {self.host}. "
                "TCP connected but the logger did not answer — another app may hold port 2000."
            )
            logger.warning("AiM live connect: %s", msg)
            self._emit_trace("hello_ack_timeout", message=msg)
            raise ConnectionError(msg) from exc
        self._emit_trace("hello_ack", payload_hex=hello_ack.payload.hex())
        logger.debug(
            "AiM live connect: hello-ack payload=%s",
            hello_ack.payload.hex(),
        )
        await self._run_live_handshake(timeout=timeout)
        self._handshake_done = True
        # Layout / enum Q-hints (e.g. 15584→15588) must not carry into the poll loop.
        self._pending_live_size = None
        self._emit_trace("handshake_complete", pending_live_size=None)
        logger.info(
            "AiM live connect: handshake complete on %s:%d",
            self.host,
            self.port,
        )

    async def _send_stnc(self, sub_cmd: int) -> None:
        assert self._writer is not None
        logger.debug("AiM live TX: STNC sub=0x%08x", sub_cmd)
        self._writer.write(encode_frame(b"STNC", _stnc_payload(sub_cmd)))
        await self._writer.drain()

    async def _respond_stcp64(
        self,
        payload: bytes,
        *,
        phase: str,
        post_date_ack: bool = True,
    ) -> None:
        """Handle 64-byte server STCP ack/control payloads during handshake/stream."""
        op = payload[24]
        if op in (_STCP_OP_A, _STCP_OP_H):
            follow = _stcp_date_followup()
            await self._send_stcp(follow)
            self._emit_trace(
                "tx_date_followup",
                phase=phase,
                trigger_op=chr(op),
                payload_hex=follow.hex(),
            )
            # Live.pcapng stream 1: after 68 B date, RS3 always sends 4 B STCP ack
            # before the device continues with Q + enum blob (except STNC 0x00010006 aux).
            if post_date_ack:
                await self._send_stcp(_STCP_4BYTE_ACK)
                self._emit_trace("tx_micro_ack", phase=phase, after="date_followup")
            return
        if op in (_STCP_OP_Q, _STCP_OP_E, _STCP_OP_I):
            if op == _STCP_OP_Q:
                hint = struct.unpack("<I", payload[16:20])[0]
                live_len = _q_hint_live_payload_size(hint)
                if live_len is not None:
                    self._pending_live_size = live_len
            await self._send_stcp(_STCP_4BYTE_ACK)
            return
        logger.warning(
            "AiM live: unhandled STCP-64 opcode %r in phase %s",
            chr(op) if 32 <= op < 127 else op,
            phase,
        )
        self._emit_trace("unhandled_stcp64_op", phase=phase, op=op)

    async def _send_stcp(self, payload: bytes) -> None:
        assert self._writer is not None
        if len(payload) == 68:
            logger.debug("AiM live TX: STCP enum date follow-up (68 bytes)")
        elif len(payload) == 8:
            logger.debug("AiM live TX: STCP hello (8 bytes)")
        elif len(payload) == 4:
            logger.debug("AiM live TX: STCP micro-ack (4 bytes)")
        else:
            logger.debug("AiM live TX: STCP payload len=%d", len(payload))
        self._writer.write(encode_frame(b"STCP", payload))
        await self._writer.drain()

    async def _run_live_handshake(self, *, timeout: float) -> None:
        """Mimic Race Studio post-hello setup from 2026 Live.pcapng captures."""
        logger.info("AiM live handshake: starting RS3 enumeration + setup STNCs")
        await self._run_enum_pass(STNC_SYSTEM, wait_blob=True, timeout=timeout)
        await self._run_enum_pass(STNC_ENUM_AUX, wait_blob=False, timeout=timeout)
        await self._run_enum_pass(STNC_SYSTEM, wait_blob=True, timeout=timeout)
        await self._run_enum_pass(STNC_SYSTEM, wait_blob=True, timeout=timeout)
        for sub_cmd in STNC_SETUP_SELECTORS:
            logger.debug("AiM live handshake: setup STNC sub=0x%08x", sub_cmd)
            await self._send_stnc(sub_cmd)
            if sub_cmd != STNC_SETUP_FINAL:
                await self._send_stcp(_STCP_4BYTE_ACK)
            await self._autorespond_drain(
                idle_s=SETUP_DRAIN_IDLE_S,
                overall_timeout=timeout,
                label=f"setup-0x{sub_cmd:08x}",
                respond_stcp_control=False,
            )
        await self._autorespond_drain(
            idle_s=0.5,
            overall_timeout=timeout,
            label="post-setup",
            respond_stcp_control=False,
        )
        logger.info("AiM live handshake: setup STNCs complete")

    async def _run_enum_pass(
        self,
        sub_cmd: int,
        *,
        wait_blob: bool,
        timeout: float,
    ) -> None:
        logger.info(
            "AiM live enum: STNC 0x%08x begin (wait_blob=%s timeout=%.1fs)",
            sub_cmd,
            wait_blob,
            timeout,
        )
        await self._send_stnc(sub_cmd)
        blob_seen = not wait_blob
        blob_len = 0
        sent_followup = False
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if wait_blob and blob_seen:
                logger.info(
                    "AiM live enum: STNC 0x%08x complete (device blob %d bytes)",
                    sub_cmd,
                    blob_len,
                )
                return
            if not wait_blob and sent_followup:
                await self._autorespond_drain(
                    idle_s=0.25,
                    overall_timeout=1.5,
                    label=f"enum-aux-0x{sub_cmd:08x}",
                    respond_stcp_control=False,
                )
                logger.info("AiM live enum: STNC 0x%08x complete (aux pass)", sub_cmd)
                return
            remaining = deadline - asyncio.get_running_loop().time()
            try:
                frame = await asyncio.wait_for(self._read_one_frame(), timeout=min(remaining, 2.0))
            except TimeoutError:
                if not wait_blob and sent_followup:
                    logger.info("AiM live enum: STNC 0x%08x complete (aux, idle timeout)", sub_cmd)
                    return
                logger.debug(
                    "AiM live enum: STNC 0x%08x waiting (wait_blob=%s sent_followup=%s)",
                    sub_cmd,
                    wait_blob,
                    sent_followup,
                )
                continue
            self._log_rx_frame(frame, phase=f"enum-0x{sub_cmd:08x}")
            if frame.cmd != b"STCP":
                continue
            pl = frame.payload
            # Live.pcapng enum: date (+ micro on system passes) only; no micro on 4 B / Q before blob.
            if len(pl) == 4:
                continue
            if len(pl) == 64 and len(pl) > 24:
                op = pl[24]
                if op in (_STCP_OP_A, _STCP_OP_H):
                    await self._respond_stcp64(
                        pl,
                        phase=f"enum-0x{sub_cmd:08x}",
                        post_date_ack=(sub_cmd != STNC_ENUM_AUX),
                    )
                    sent_followup = True
                continue
            if is_layout_blob(pl):
                self._ingest_channel_layout(pl, phase=f"enum-0x{sub_cmd:08x}")
            elif wait_blob and len(pl) >= _ENUM_BLOB_MIN_LEN:
                blob_seen = True
                blob_len = len(pl)
        if wait_blob and not blob_seen:
            logger.error(
                "AiM live enum: STNC 0x%08x timed out without device blob (>=%d bytes)",
                sub_cmd,
                _ENUM_BLOB_MIN_LEN,
            )
            self._emit_trace(
                "enum_failed",
                sub_cmd=f"0x{sub_cmd:08x}",
                wait_blob=wait_blob,
                reason="no_blob",
            )
            raise TimeoutError(f"enumeration pass 0x{sub_cmd:08x} did not receive device blob")

    async def _autorespond_drain(
        self,
        *,
        idle_s: float = 0.4,
        overall_timeout: float = 5.0,
        label: str = "drain",
        respond_stcp_control: bool = True,
    ) -> None:
        """Read and auto-ack server frames until the stream goes idle."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + overall_timeout
        last_frame_at = loop.time()
        frames_seen = 0
        while loop.time() < deadline:
            if loop.time() - last_frame_at >= idle_s:
                logger.debug(
                    "AiM live drain [%s]: idle %.2fs after %d frame(s)",
                    label,
                    idle_s,
                    frames_seen,
                )
                return
            try:
                frame = await asyncio.wait_for(
                    self._read_one_frame(),
                    timeout=min(idle_s, deadline - loop.time()),
                )
            except TimeoutError:
                continue
            last_frame_at = loop.time()
            frames_seen += 1
            self._log_rx_frame(frame, phase=label)
            if frame.cmd != b"STCP":
                continue
            pl = frame.payload
            if not respond_stcp_control:
                if await self._ingest_stcp_control_frame(frame):
                    continue
                if is_layout_blob(pl):
                    self._ingest_channel_layout(pl, phase=label)
                elif len(pl) >= _ENUM_BLOB_MIN_LEN or len(pl) in (
                    LIVE_FRAME_SIZE_113CH,
                    324,
                    68,
                ):
                    logger.debug("AiM live drain [%s]: absorbed blob len=%d", label, len(pl))
                continue
            if len(pl) == 4:
                await self._send_stcp(_STCP_4BYTE_ACK)
            elif len(pl) == 64 and len(pl) > 24:
                await self._respond_stcp64(pl, phase=label)
            elif is_layout_blob(pl):
                self._ingest_channel_layout(pl, phase=label)
            elif len(pl) >= _ENUM_BLOB_MIN_LEN:
                logger.debug("AiM live drain [%s]: absorbed blob len=%d", label, len(pl))

    async def _expect(
        self,
        cmd: bytes,
        *,
        min_payload_len: int = 0,
        timeout: float = 5.0,
    ) -> Frame:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                logger.warning("AiM live: timed out waiting for %r (min_payload_len=%d)", cmd, min_payload_len)
                raise TimeoutError(f"timed out waiting for {cmd!r}")
            frame = await asyncio.wait_for(self._read_one_frame(), timeout=remaining)
            if frame.cmd == cmd and len(frame.payload) >= min_payload_len:
                return frame

    def _log_rx_frame(self, frame: Frame, *, phase: str) -> None:
        summary = _describe_frame(frame)
        if not self._handshake_done:
            logger.debug("AiM live RX [%s]: %s", phase, summary)
            self._emit_trace("rx", phase=phase, summary=summary)

    async def _read_one_frame(self) -> Frame:
        if self._frame_stash:
            return self._frame_stash.popleft()
        assert self._reader is not None
        while True:
            try:
                frame, consumed = decode_frame(self._buf)
            except ValueError as exc:
                self._decode_resync_bytes += 1
                if self._decode_resync_bytes in (1, 100, 1000):
                    logger.warning(
                        "AiM live: frame decode resync (%s); dropped %d byte(s) so far",
                        exc,
                        self._decode_resync_bytes,
                    )
                self._buf.pop(0)
                continue
            if frame is not None:
                del self._buf[:consumed]
                return frame
            chunk = await self._reader.read(4096)
            if not chunk:
                logger.warning("AiM live: device closed TCP (decode_resync_bytes=%d)", self._decode_resync_bytes)
                raise ConnectionError("AiM device closed the connection")
            self._buf.extend(chunk)

    async def stream(self) -> AsyncIterator[LiveSnapshot]:
        """Drive the live-poll loop and yield each live snapshot (RS3-5-47 pair cadence)."""
        if not self.connected:
            raise RuntimeError("call connect() first")
        assert self._writer is not None

        logger.info(
            "AiM live stream: poll loop starting (RS3 pair 0x20003/0x20053 + micro, %.0fms step)",
            POLL_INTERVAL_S * 1000,
        )
        await self._autorespond_drain(idle_s=0.15, overall_timeout=1.0, label="pre-poll-sync")
        while not self._closed:
            try:
                await self._send_rs3_poll_stnc(STNC_LIVE_POLL_A)
                await asyncio.sleep(POLL_INTERVAL_S)
                await self._send_rs3_poll_stnc(STNC_LIVE_POLL_B)
                await asyncio.sleep(POLL_INTERVAL_S)
                try:
                    snap = await self._wait_for_live_frame(timeout=2.0)
                    self._poll_a_timeouts = 0
                    self._snapshots_yielded += 1
                    if self._snapshots_yielded == 1:
                        raw_len = len(base64.b64decode(snap.raw_b64))
                        self._emit_trace(
                            "first_snapshot",
                            subsystem=snap.subsystem,
                            timestamp_ms=snap.timestamp_ms,
                            payload_bytes=raw_len,
                            channel_count=len(snap.channels),
                        )
                        logger.info(
                            "AiM live stream: first snapshot subsystem=%r ts=%d "
                            "payload=%d bytes channels=%d",
                            snap.subsystem,
                            snap.timestamp_ms,
                            raw_len,
                            len(snap.channels),
                        )
                    elif self._snapshots_yielded % 100 == 0:
                        logger.info(
                            "AiM live stream: %d snapshots yielded",
                            self._snapshots_yielded,
                        )
                    yield snap
                    await self._send_stcp(_STCP_4BYTE_ACK)
                except TimeoutError:
                    self._poll_a_timeouts += 1
                    self._pending_live_size = None
                    msg = (
                        "AiM live stream: no live snapshot within 2s after poll pair "
                        "(pending_live_size=%s, poll_pair_timeouts=%d)."
                    )
                    if self._poll_a_timeouts == 1 or self._poll_a_timeouts % 10 == 0:
                        logger.warning(
                            msg,
                            self._pending_live_size,
                            self._poll_a_timeouts,
                        )
                    else:
                        logger.debug(
                            msg,
                            self._pending_live_size,
                            self._poll_a_timeouts,
                        )
            except ConnectionError:
                logger.info("AiM live stream: device closed connection during poll")
                break

    async def _send_rs3_poll_stnc(self, sub_cmd: int) -> None:
        """RS3 steady poll: STNC then immediate micro (RS3-5-47.pcapng)."""
        await self._send_stnc(sub_cmd)
        await self._send_stcp(_STCP_4BYTE_ACK)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + POLL_STNC_DRAIN_S
        last_frame_at = loop.time()
        while loop.time() < deadline:
            if loop.time() - last_frame_at >= 0.12:
                break
            try:
                frame = await asyncio.wait_for(
                    self._read_one_frame(),
                    timeout=min(0.08, deadline - loop.time()),
                )
            except TimeoutError:
                continue
            last_frame_at = loop.time()
            if frame.cmd == b"STCP":
                pl = frame.payload
                if _is_live_snapshot_payload(pl):
                    self._frame_stash.append(frame)
                    continue
                if len(pl) == 12:
                    self._frame_stash.append(frame)
                    continue
                if len(pl) in (LIVE_FRAME_SIZE_113CH, 324, 68) and not _is_live_snapshot_payload(pl):
                    logger.debug(
                        "AiM live poll: absorbed non-telemetry %d B during STNC 0x%08x",
                        len(pl),
                        sub_cmd,
                    )
                    continue
            if await self._ingest_stcp_control_frame(frame):
                continue
            logger.debug(
                "AiM live poll: stashing unexpected %s during STNC 0x%08x",
                _describe_frame(frame),
                sub_cmd,
            )
            self._frame_stash.append(frame)

    async def _ingest_stcp_control_frame(self, frame: Frame) -> bool:
        """Consume I/Q/E/4B during poll-pair drain without extra micro (driver micro already sent)."""
        if frame.cmd != b"STCP":
            return False
        pl = frame.payload
        if len(pl) == 4:
            return True
        if len(pl) == 64 and len(pl) > 24:
            op = pl[24]
            if op == _STCP_OP_Q:
                hint = struct.unpack("<I", pl[16:20])[0]
                live_len = _q_hint_live_payload_size(hint)
                if live_len is not None:
                    self._pending_live_size = live_len
                return True
            if op in (_STCP_OP_I, _STCP_OP_E):
                return True
        return False

    def _ingest_channel_layout(self, blob: bytes, *, phase: str) -> None:
        fields = parse_channel_layout(blob, live_frame_len=691)
        if not fields:
            logger.warning("AiM live: channel layout parse returned 0 fields (%s)", phase)
            return
        self._channel_fields = fields
        self._emit_trace("channel_layout", phase=phase, blob_bytes=len(blob), field_count=len(fields))
        logger.info(
            "AiM live: channel layout loaded (%d fields, %d bytes, phase=%s)",
            len(fields),
            len(blob),
            phase,
        )

    async def stop_streaming(self) -> None:
        """Stop the live poll loop but keep the TCP socket open (RS3 primary session)."""
        self._closed = True
        await asyncio.sleep(0)
        self._closed = False

    async def fetch_session_list(self, *, timeout: float = 15.0) -> list[dict]:
        """Session CSV over the primary TCP after live handshake (connect.pcapng)."""
        from services.aim_connector import _extract_session_csv, parse_aim_session_csv_rows

        if not self._handshake_done:
            raise RuntimeError("live handshake must complete before session list")
        logger.info("AiM primary: session list STNCs on existing TCP to %s", self.host)
        self._emit_trace("session_list_begin")
        await self._send_stnc(STNC_PREP_SESSIONS)
        await self._send_stnc(STNC_PREP_SESSIONS)
        await self._send_stnc(STNC_GET_SESSIONS)
        await self._send_stcp(_STCP_4BYTE_ACK)

        collected = bytearray()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if b"name,size,date,hour," in collected and loop.time() > deadline - 2.0:
                break
            try:
                frame = await asyncio.wait_for(
                    self._read_one_frame(),
                    timeout=min(2.0, max(0.1, deadline - loop.time())),
                )
            except TimeoutError:
                if b"name,size,date,hour," in collected:
                    break
                continue
            collected.extend(frame.payload)
            if frame.cmd != b"STCP":
                continue
            pl = frame.payload
            if len(pl) == 4:
                await self._send_stcp(_STCP_4BYTE_ACK)
            elif len(pl) == 64 and len(pl) > 24:
                await self._respond_stcp64(
                    pl,
                    phase="session-list",
                    post_date_ack=False,
                )

        csv_text = _extract_session_csv(bytes(collected))
        if csv_text is None:
            self._emit_trace("session_list_failed", reason="no_csv")
            logger.error("AiM primary: no session CSV in response (%d bytes collected)", len(collected))
            return []
        rows = parse_aim_session_csv_rows(csv_text)
        self._emit_trace("session_list_ok", session_count=len(rows))
        logger.info("AiM primary: session list ok (%d sessions)", len(rows))
        return rows

    async def _wait_for_heartbeat(self, *, timeout: float) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("no heartbeat")
            frame = await asyncio.wait_for(self._read_one_frame(), timeout=remaining)
            if await self._handle_stcp_control_frame(frame):
                continue
            if frame.cmd == b"STCP" and len(frame.payload) == 12:
                return

    async def _wait_for_live_frame(self, *, timeout: float) -> LiveSnapshot:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                logger.warning(
                    "AiM live snapshot wait: timeout (pending_live_size=%s)",
                    self._pending_live_size,
                )
                raise TimeoutError("no live frame")
            frame = await asyncio.wait_for(self._read_one_frame(), timeout=remaining)
            if await self._ingest_stcp_control_frame(frame):
                continue
            if frame.cmd != b"STCP":
                logger.debug("AiM live snapshot wait: skipping %s", _describe_frame(frame))
                continue
            pl = frame.payload
            if len(pl) in (12, 324, 68):
                logger.debug("AiM live snapshot wait: absorbed %d B (waiting for live)", len(pl))
                continue
            expected = self._pending_live_size
            if expected and len(pl) == expected:
                self._pending_live_size = None
                if _is_live_snapshot_payload(pl):
                    return parse_live_snapshot(pl, self._channel_fields or None)
                logger.debug(
                    "AiM live snapshot wait: size %d matched pending but not telemetry (tag=%r)",
                    len(pl),
                    pl[4:8],
                )
                continue
            elif expected and len(pl) > 64:
                logger.debug(
                    "AiM live snapshot wait: payload len=%d (expected %d): %s",
                    len(pl),
                    expected,
                    _describe_frame(frame),
                )
            if _is_live_snapshot_payload(pl):
                return parse_live_snapshot(pl, self._channel_fields or None)

    async def _handle_stcp_control_frame(self, frame: Frame) -> bool:
        """Auto-respond to control frames. Returns True if consumed."""
        if frame.cmd != b"STCP":
            return False
        pl = frame.payload
        assert self._writer is not None
        # Server 4 B STCP during live poll is not echoed by RS3; client drives acks after each STNC.
        if len(pl) == 4:
            return True
        if len(pl) == 64 and len(pl) > 24:
            op = pl[24]
            if op in (_STCP_OP_Q, _STCP_OP_E, _STCP_OP_I):
                await self._respond_stcp64(pl, phase="stream", post_date_ack=False)
                return True
            return False
        return False

    async def close(self) -> None:
        self._closed = True
        if self._snapshots_yielded or self._poll_a_timeouts:
            logger.info(
                "AiM live close: host=%s snapshots=%d poll_a_timeouts=%d resync_bytes=%d",
                self.host,
                self._snapshots_yielded,
                self._poll_a_timeouts,
                self._decode_resync_bytes,
            )
        self._emit_trace(
            "client_close",
            snapshots=self._snapshots_yielded,
            poll_a_timeouts=self._poll_a_timeouts,
            decode_resync_bytes=self._decode_resync_bytes,
        )
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None
