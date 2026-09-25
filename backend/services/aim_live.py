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
# RS3 sends its next steady-poll STNC every 150-190 ms without waiting for a
# snapshot (RS3-5-47.pcapng). The pump task below reproduces that instead of
# the old fixed lockstep "send, sleep, send, sleep, block for snapshot" loop.
PUMP_PERIOD_S = 0.16
# RS3 acks the device's Q frame ~0.4 ms after it arrives (410.3ms Q -> 410.7ms
# micro in the capture) rather than blindly right after sending the poll STNC.
# The reader task pays the ack immediately when Q/I/E is seen; this fallback
# only fires if, for some reason, none of them showed up after a poll STNC.
PUMP_FALLBACK_MICRO_DELAY_S = 0.07
# Setup STNCs are 100-160 ms apart in Race Studio's own capture; the previous
# 0.35s / 0.5s fixed idle drains were a large multiple of that, on every one
# of the 6 setup commands plus the post-setup wait -- most of the ~10s
# reconnect-to-first-snapshot gap.
SETUP_DRAIN_IDLE_S = 0.16
POST_SETUP_DRAIN_IDLE_S = 0.2

# The EVO5 does not keep a live TCP session open forever: RS3-9-22-26-long.pcapng
# shows Race Studio itself cycling a fresh TCP connection to port 2000 every
# ~40-90s (device sends the FIN in working-dropped-6-50.pcapng after ~16 live
# frames / ~30s), and Race Studio just reconnects immediately so the operator
# never notices. We do the same here instead of ending the stream.
RECONNECT_MAX_ATTEMPTS = 10
RECONNECT_BACKOFF_S = 1.0

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
        # Guards the physical socket write so the reader task's immediate
        # Q-ack and the pump task's STNC/fallback-ack never interleave.
        self._write_lock = asyncio.Lock()
        # "Is a micro-ack owed for the STNC the pump most recently sent?" The
        # reader pays it the instant Q/I/E arrives; the pump pays it itself
        # as a fallback if nothing arrived within PUMP_FALLBACK_MICRO_DELAY_S.
        self._micro_lock = asyncio.Lock()
        self._micro_owed = False
        self._snapshot_gaps_ms: deque[float] = deque(maxlen=64)
        self._last_snapshot_at: float | None = None

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
        async with self._write_lock:
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
        async with self._write_lock:
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
            idle_s=POST_SETUP_DRAIN_IDLE_S,
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
                    idle_s=0.15,
                    overall_timeout=0.5,
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

    async def _ingest_stcp_control_frame(self, frame: Frame) -> bool:
        """Consume a Q/I/E/4B control frame during handshake drains without
        acking it (`_autorespond_drain(respond_stcp_control=False)` -- setup
        STNCs, aux enum pass, pre/post-poll sync). Steady-state polling uses
        `_reader_loop`/`_pay_micro_if_owed` instead; this is handshake-only.
        """
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

    async def _pay_micro_if_owed(self) -> None:
        """Send the micro-ack owed for the last poll STNC, if not already paid."""
        async with self._micro_lock:
            if not self._micro_owed:
                return
            self._micro_owed = False
        await self._send_stcp(_STCP_4BYTE_ACK)

    async def _pump_loop(self) -> None:
        """Alternate STNC A/B on a fixed period. Never waits for a snapshot.

        RS3 does not wait for the previous LIVE frame before sending the next
        poll command (RS3-5-47.pcapng), which is what makes its rate 2.5-3x
        ours. This task's only job is to keep that cadence; the reader task
        (below) is what actually acks the device and produces snapshots.
        """
        toggle = STNC_LIVE_POLL_A
        loop = asyncio.get_running_loop()
        while True:
            cycle_start = loop.time()
            await self._send_stnc(toggle)
            async with self._micro_lock:
                self._micro_owed = True
            # Give the reader a chance to ack in response to the device's Q
            # (typically <10ms). Only pay it ourselves if nothing showed up.
            await asyncio.sleep(PUMP_FALLBACK_MICRO_DELAY_S)
            await self._pay_micro_if_owed()
            toggle = STNC_LIVE_POLL_B if toggle == STNC_LIVE_POLL_A else STNC_LIVE_POLL_A
            elapsed = loop.time() - cycle_start
            await asyncio.sleep(max(0.0, PUMP_PERIOD_S - elapsed))

    async def _reader_loop(self, queue: "asyncio.Queue[LiveSnapshot]") -> None:
        """Continuously read frames; ack Q/I/E the instant they arrive, and
        push each decoded snapshot onto `queue`. Never sends anything after a
        snapshot -- the (1, 2) micro-ack drop pattern this module used to hit
        came from exactly that (see `test_stream_impl_no_post_snapshot_micro_ack`).
        """
        while True:
            frame = await self._read_one_frame()
            self._log_rx_frame(frame, phase="stream")
            if frame.cmd != b"STCP":
                continue
            pl = frame.payload
            if len(pl) == 4:
                # Server 4B STCP during live poll is not echoed by RS3.
                continue
            if len(pl) == 64 and len(pl) > 24:
                op = pl[24]
                if op == _STCP_OP_Q:
                    hint = struct.unpack("<I", pl[16:20])[0]
                    live_len = _q_hint_live_payload_size(hint)
                    if live_len is not None:
                        self._pending_live_size = live_len
                    await self._pay_micro_if_owed()
                    continue
                if op in (_STCP_OP_I, _STCP_OP_E):
                    await self._pay_micro_if_owed()
                    continue
                if op in (_STCP_OP_A, _STCP_OP_H):
                    # Rare mid-stream; same date-followup handling as setup.
                    await self._respond_stcp64(pl, phase="stream", post_date_ack=False)
                    continue
                logger.debug("AiM live reader: unhandled STCP-64 opcode in stream phase")
                continue
            if is_layout_blob(pl):
                self._ingest_channel_layout(pl, phase="stream")
                continue
            if len(pl) in (12, 324, 68):
                continue
            if _is_live_snapshot_payload(pl):
                snap = parse_live_snapshot(pl, self._channel_fields or None)
                await queue.put(snap)
                continue
            logger.debug("AiM live reader: unrecognized STCP payload len=%d", len(pl))

    def _record_snapshot_gap(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if self._last_snapshot_at is not None:
            self._snapshot_gaps_ms.append((now - self._last_snapshot_at) * 1000)
        self._last_snapshot_at = now

    def _log_rate(self) -> None:
        """Phase-0 measurement hook: snapshot rate + gap percentiles, so a car
        test can be checked against the plan's targets without Wireshark."""
        gaps = sorted(self._snapshot_gaps_ms)
        if not gaps:
            return
        p50 = gaps[len(gaps) // 2]
        p95 = gaps[min(len(gaps) - 1, int(len(gaps) * 0.95))]
        hz = 1000.0 / p50 if p50 > 0 else 0.0
        logger.info(
            "AiM live stream: rate ~%.2f Hz (p50 gap=%.0fms p95 gap=%.0fms, n=%d, total snapshots=%d)",
            hz,
            p50,
            p95,
            len(gaps),
            self._snapshots_yielded,
        )
        self._emit_trace("rate", hz=round(hz, 2), p50_gap_ms=round(p50), p95_gap_ms=round(p95))

    async def stream(self) -> AsyncIterator[LiveSnapshot]:
        """Drive the live-poll loop and yield each live snapshot.

        Runs two background tasks sharing the one socket: a reader that acks
        the device immediately and decodes snapshots, and a pump that keeps
        sending poll STNCs on a fixed period regardless of whether a snapshot
        has arrived yet. This replaces the old fixed lockstep loop (send,
        sleep 125ms, send, sleep 125ms, block for snapshot), which capped the
        rate at under 1 Hz even though the device can sustain 2.5-3 Hz.
        """
        if not self.connected:
            raise RuntimeError("call connect() first")
        assert self._writer is not None

        logger.info(
            "AiM live stream: event-driven pump starting (~%.0fms STNC period)",
            PUMP_PERIOD_S * 1000,
        )
        await self._autorespond_drain(idle_s=0.15, overall_timeout=1.0, label="pre-poll-sync")
        while not self._closed:
            self._micro_owed = False
            queue: "asyncio.Queue[LiveSnapshot]" = asyncio.Queue(maxsize=8)
            reader_task = asyncio.create_task(self._reader_loop(queue), name="aim-live-reader")
            pump_task = asyncio.create_task(self._pump_loop(), name="aim-live-pump")
            device_error: BaseException | None = None
            try:
                while not self._closed:
                    get_task = asyncio.ensure_future(queue.get())
                    done, _pending = await asyncio.wait(
                        {get_task, reader_task, pump_task},
                        timeout=2.0,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if reader_task in done or pump_task in done:
                        get_task.cancel()
                        failed = reader_task if reader_task in done else pump_task
                        device_error = failed.exception()
                        break
                    if get_task not in done:
                        get_task.cancel()
                        self._poll_a_timeouts += 1
                        self._pending_live_size = None
                        msg = (
                            "AiM live stream: no live snapshot within 2s "
                            "(pending_live_size=%s, poll_pair_timeouts=%d)."
                        )
                        if self._poll_a_timeouts == 1 or self._poll_a_timeouts % 10 == 0:
                            logger.warning(msg, self._pending_live_size, self._poll_a_timeouts)
                        else:
                            logger.debug(msg, self._pending_live_size, self._poll_a_timeouts)
                        continue

                    snap = get_task.result()
                    self._poll_a_timeouts = 0
                    self._snapshots_yielded += 1
                    self._record_snapshot_gap()
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
                        self._log_rate()
                    yield snap
            except ConnectionError as exc:
                device_error = exc
            finally:
                reader_task.cancel()
                pump_task.cancel()
                await asyncio.gather(reader_task, pump_task, return_exceptions=True)

            if self._closed:
                return
            if isinstance(device_error, ConnectionError):
                logger.warning(
                    "AiM live stream: device closed connection during poll "
                    "(snapshots=%d so far); attempting reconnect",
                    self._snapshots_yielded,
                )
                self._emit_trace("device_dropped", snapshots=self._snapshots_yielded)
                # Raises (propagating to the caller) if the device never comes back.
                await self._reconnect_with_retry(
                    max_attempts=RECONNECT_MAX_ATTEMPTS,
                    base_backoff_s=RECONNECT_BACKOFF_S,
                )
                await self._autorespond_drain(
                    idle_s=0.15, overall_timeout=1.0, label="post-reconnect-sync"
                )
            elif device_error is not None:
                raise device_error

    def _ingest_channel_layout(self, blob: bytes, *, phase: str) -> None:
        # Cap at the largest known live-frame size (113ch EVO5 uses 707 B `Syst`
        # frames, not just 691 B). decode_live_channels() bounds-checks each
        # field against the actual payload length per frame, so using the widest
        # cap here is a safe superset: fields beyond a shorter frame just decode
        # to None instead of being silently dropped at layout-parse time.
        fields = parse_channel_layout(blob, live_frame_len=LIVE_FRAME_SIZE_113CH)
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

    def _reset_stream_state(self) -> None:
        """Clear per-TCP-connection state before a reconnect (keeps cumulative stats).

        `_channel_fields` is deliberately NOT cleared -- the layout is re-sent
        during the next handshake anyway, but keeping the old one around lets
        the first snapshot after a reconnect decode immediately instead of
        showing zero channels until the new layout blob arrives.
        """
        self._buf.clear()
        self._pending_live_size = None
        self._handshake_done = False
        self._micro_owed = False

    async def _reconnect(self, *, timeout: float = 15.0) -> None:
        """Tear down the dead socket and redo TCP connect + live handshake."""
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._writer = None
        self._reader = None
        self._reset_stream_state()
        # discover_first=True but the device cache written on the original
        # connect is still fresh, so this resolves instantly without a new
        # UDP broadcast (see connect()'s cache check).
        await self.connect(discover_first=True, timeout=timeout)

    async def _reconnect_with_retry(self, *, max_attempts: int, base_backoff_s: float) -> None:
        last_exc: BaseException | None = None
        for attempt in range(1, max_attempts + 1):
            # No delay before the first attempt -- the device usually just
            # opened a fresh listener, so waiting here only adds dead time to
            # every reconnect. Back off (base * attempts-so-far) only after a
            # failed attempt.
            if attempt > 1:
                await asyncio.sleep(base_backoff_s * (attempt - 1))
            try:
                await self._reconnect()
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "AiM live stream: reconnect attempt %d/%d failed: %s",
                    attempt,
                    max_attempts,
                    exc,
                )
                self._emit_trace(
                    "device_reconnect_attempt_failed",
                    attempt=attempt,
                    max_attempts=max_attempts,
                    error=str(exc),
                )
                continue
            logger.info(
                "AiM live stream: reconnected after device drop "
                "(attempt %d/%d, snapshots so far=%d)",
                attempt,
                max_attempts,
                self._snapshots_yielded,
            )
            self._emit_trace(
                "device_reconnected", snapshots=self._snapshots_yielded, attempt=attempt
            )
            return
        self._emit_trace(
            "device_reconnect_failed", snapshots=self._snapshots_yielded, attempts=max_attempts
        )
        raise ConnectionError(
            f"AiM device did not come back after {max_attempts} reconnect attempts"
        ) from last_exc

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
