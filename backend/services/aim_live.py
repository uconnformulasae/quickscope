"""
Live-data client for AiM EVO5 (and likely other AiM Race Studio devices).

Speaks the protocol documented in `docs/protocol/aim-live-protocol.md`. The
flow:

1. UDP discovery probe (port 36002) — confirms the device is reachable.
2. TCP connect to port 2000.
3. 8-byte STCP "hello" exchange.
4. 3-pass enumeration (mimics Race Studio; gives the device a chance to
   refresh its internal state before live streams begin).
5. Steady-state live poll: alternate between STNC sub-cmds 0x00020003 and
   0x00020053, each ~125 ms apart, yielding the 547-byte live frame the
   device sends in response.

This module is intentionally separate from `aim_connector.py`. That file
implements the **session-list-download** flow (different STNC sub-cmds,
different lifecycle) and we keep it untouched. Live streaming is purely
read-only — we never tell the device to start/stop logging, and we never
write anything to its filesystem.

Field-level decoding of the 547-byte live frame is deliberately **not**
done here yet. We expose the raw payload as base64 plus the few field
positions we know are stable (subsystem tag, monotonic ms timestamp).
Higher-confidence decoding lands in a follow-up commit once the channel-
definition frame (libxrk-parsable) gives us the offset → name map.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import socket
import struct
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)


DISCOVERY_PORT = 36002
DATA_PORT = 2000
DISCOVERY_MAGIC = b"aim-ka"
LIVE_FRAME_SIZE = 547
DEFAULT_DEVICE_IP = "10.0.0.1"
POLL_INTERVAL_S = 0.125  # 125 ms × 2 STNC sub-cmds → 250 ms cycle


# ── Outer envelope helpers (see docs/protocol/aim-live-protocol.md §3) ──


def _checksum(payload: bytes) -> int:
    """Trailer u16 = sum of payload bytes mod 0x10000.

    Confirmed by libxrk (m3rlin45/libxrk, MIT). The library calls this
    function `accumulate(payload_start, payload_end, 0)` in its Cython
    parser and matches every observed trailer in our captures.
    """
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


def _stnc_payload(sub_cmd: int) -> bytes:
    """Build a 64-byte STNC payload with the given sub-cmd at offset 8.

    Layout (verified across 9 unique captured client STNCs):
        [0..7]   00 00 00 00 00 00 00 00          fixed header
        [8..11]  <sub-cmd, LE u32>                command code
        [12..23] zero-padded args                 reserved
        [24..27] '@' '\\x00' '\\x00' '\\x00'         marker (0x00000040)
        [28..]   zero-padded                      tail
    """
    p = bytearray(64)
    p[8:12] = struct.pack("<I", sub_cmd)
    p[24] = 0x40  # observed in every captured STNC
    return bytes(p)


# Discovered empirically from live1.pcapng (see docs/protocol/captures/extract_stnc.py):
STNC_SYSTEM = 0x00010010      # 3-pass enumeration (each pass)
STNC_LIVE_POLL_A = 0x00020003  # 194 occurrences in live1
STNC_LIVE_POLL_B = 0x00020053  # 194 occurrences in live1


# ── Identity (UDP discovery reply parsing) ──────────────────────────────────


@dataclass
class Identity:
    ip: str
    model: str = ""        # e.g. "EVO5"
    serial: str = ""       # e.g. "00740"
    vehicle: str = ""      # e.g. "UConn-EV"
    raw: bytes = field(default_factory=bytes, repr=False)


def parse_identity(addr_ip: str, data: bytes) -> Identity:
    """Parse a 244-byte UDP discovery reply into an Identity."""
    ident = Identity(ip=addr_ip, raw=data)
    text = data.decode("ascii", errors="replace")
    # The "AiM-<MODEL>-<SERIAL>-<VEHICLE>" string starts around offset 124
    import re
    m = re.search(r"AiM-([A-Za-z0-9_]+)-(\d+)-([^\x00]+)", text)
    if m:
        ident.model = m.group(1)
        ident.serial = m.group(2)
        ident.vehicle = m.group(3).rstrip("\x00").rstrip()
    return ident


async def discover(timeout: float = 2.0, ip: str = DEFAULT_DEVICE_IP) -> Optional[Identity]:
    """Send the UDP probe and parse the reply. Returns None on timeout."""
    loop = asyncio.get_running_loop()

    def _probe() -> Optional[tuple[str, bytes]]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(timeout)
                s.sendto(DISCOVERY_MAGIC, (ip, DISCOVERY_PORT))
                data, addr = s.recvfrom(4096)
                return addr[0], data
        except (socket.timeout, OSError):
            return None

    result = await loop.run_in_executor(None, _probe)
    if not result:
        return None
    return parse_identity(*result)


# ── Live snapshot ───────────────────────────────────────────────────────────


@dataclass
class LiveSnapshot:
    timestamp_ms: int            # device-monotonic counter from frame[8..11]
    subsystem: str               # ASCII tag from frame[4..7] (e.g. "kkk", "Syst")
    raw_b64: str                 # full 547-byte payload, base64 (for client-side decode)


def parse_live_snapshot(payload: bytes) -> LiveSnapshot:
    """Pull stable fields out of a 547-byte live frame.

    Channel values live further into the payload but require the channel-
    definition frame to map offsets → names. We expose the raw bytes so
    the frontend can decode once that map is published.
    """
    if len(payload) < 12:
        raise ValueError(f"live frame too short: {len(payload)}")
    subsystem = payload[4:8].decode("ascii", errors="replace").rstrip("\x00")
    timestamp_ms = int.from_bytes(payload[8:12], "little")
    return LiveSnapshot(
        timestamp_ms=timestamp_ms,
        subsystem=subsystem,
        raw_b64=base64.b64encode(payload).decode("ascii"),
    )


# ── Client ──────────────────────────────────────────────────────────────────


class AimLiveClient:
    """Async client for the AiM Live-data wire protocol.

    Usage:
        client = AimLiveClient(host="10.0.0.1")
        await client.connect()
        async for snap in client.stream():
            print(snap.timestamp_ms, snap.subsystem)
        await client.close()
    """

    def __init__(self, host: str = DEFAULT_DEVICE_IP, port: int = DATA_PORT):
        self.host = host
        self.port = port
        self.identity: Optional[Identity] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._buf = bytearray()
        self._closed = False

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    async def connect(self, *, discover_first: bool = True, timeout: float = 5.0) -> None:
        if discover_first:
            self.identity = await discover(ip=self.host)
            if self.identity is None:
                raise ConnectionError(f"AiM device not reachable via UDP at {self.host}")
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), timeout=timeout
        )
        # Send STCP hello
        self._writer.write(encode_frame(b"STCP", _STCP_HELLO))
        await self._writer.drain()
        await self._expect(b"STCP", min_payload_len=8, timeout=timeout)
        logger.info("AiM live: connected to %s:%d", self.host, self.port)

    async def _expect(
        self,
        cmd: bytes,
        *,
        min_payload_len: int = 0,
        timeout: float = 5.0,
    ) -> Frame:
        """Read frames until one matching the criteria arrives."""
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for {cmd!r}")
            frame = await asyncio.wait_for(self._read_one_frame(), timeout=remaining)
            if frame.cmd == cmd and len(frame.payload) >= min_payload_len:
                return frame

    async def _read_one_frame(self) -> Frame:
        assert self._reader is not None
        while True:
            try:
                frame, consumed = decode_frame(self._buf)
            except ValueError:
                # Resync: drop one byte and try again.
                self._buf.pop(0)
                continue
            if frame is not None:
                del self._buf[:consumed]
                return frame
            chunk = await self._reader.read(4096)
            if not chunk:
                raise ConnectionError("AiM device closed the connection")
            self._buf.extend(chunk)

    async def stream(self) -> AsyncIterator[LiveSnapshot]:
        """Drive the live-poll loop and yield each 547-byte snapshot."""
        if not self.connected:
            raise RuntimeError("call connect() first")
        assert self._writer is not None

        sub_cmds = [STNC_LIVE_POLL_A, STNC_LIVE_POLL_B]
        i = 0
        while not self._closed:
            sub = sub_cmds[i % len(sub_cmds)]
            i += 1
            self._writer.write(encode_frame(b"STNC", _stnc_payload(sub)))
            try:
                await self._writer.drain()
            except (ConnectionError, BrokenPipeError):
                break
            try:
                # Wait briefly for the live snapshot (547 bytes). We tolerate
                # other STCP frames (acks, kkk heartbeats) by keying on size.
                snap = await self._wait_for_live_frame(timeout=2.0)
                yield snap
            except TimeoutError:
                logger.debug("AiM live: no live frame in 2s, continuing poll")
            await asyncio.sleep(POLL_INTERVAL_S)

    async def _wait_for_live_frame(self, *, timeout: float) -> LiveSnapshot:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("no live frame")
            frame = await asyncio.wait_for(self._read_one_frame(), timeout=remaining)
            if frame.cmd == b"STCP" and len(frame.payload) == LIVE_FRAME_SIZE:
                return parse_live_snapshot(frame.payload)
            # Auto-respond to micro-acks: server sends 4-byte STCP, we owe a 4-byte STCP back.
            if frame.cmd == b"STCP" and len(frame.payload) == 4:
                self._writer.write(encode_frame(b"STCP", _STCP_4BYTE_ACK))
                await self._writer.drain()
                continue
            # Anything else (STCP 64-byte ack 'I'/'Q', 12-byte 'kkk' heartbeat) is silently consumed.

    async def close(self) -> None:
        self._closed = True
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None
