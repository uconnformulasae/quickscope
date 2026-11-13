"""
AiM datalogger connector for QuickScope.

Uses the reverse-engineered AiM binary TCP protocol (port 2000) and
UDP discovery (port 36002). Adapted from Data-Development's
host_agent/aim_protocol.py.

The AiM device does NOT have an HTTP server — all communication is
via a custom binary protocol over raw TCP sockets.
"""

import csv
import io
import logging
import os
import re
import socket
import struct
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from services.aim_discovery import (
    DATA_PORT,
    candidate_device_ips,
    configured_device_port,
    parse_discovery_text,
    probe_device_ips,
    remember_device,
)
from services.aim_device_cache import record_tcp_device
from services.aim_download_trace import STREAM_TAIL_BYTES, AimDownloadTrace
from services.aim_live import (
    STCP_4BYTE_ACK,
    STCP_CONTROL_OPS,
    STCP_HELLO,
    STCP_OPCODE_OFFSET,
    decode_frame,
    encode_frame,
    resync_offset,
)
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

# ── Hardcoded protocol messages (from Wireshark captures of RaceStudio3) ────
# CRITICAL: these must be exact byte-for-byte copies — the device firmware
# silently drops messages with wrong framing or size.
# Each STNC message is exactly 84 bytes: header(12) + payload(64) + trailer(8)

# Built from the same payload constants the live client sends, so the two
# can't drift: 3c68535443 5008...3e (hello) and 3c68535443 5004...3e (4-byte ack).
_HANDSHAKE = encode_frame(b"STCP", STCP_HELLO)
_ACK = encode_frame(b"STCP", STCP_4BYTE_ACK)
# The device streams a file in batches of 30 blocks (982,320 bytes) and then
# waits for a cumulative-progress ACK. Each block carries its *absolute* file
# offset (RS3_PULL_241/242.pcapng: one contiguous 0..N run). An ACK for N
# means "I have everything below N, send the next batch starting at N" -- so
# an ACK sent mid-batch makes the device replay from N after it finishes the
# batch in flight (QS_Pull_242.pcapng). Blocks are therefore placed by offset,
# and completeness is judged by byte coverage rather than by stream length.
_BATCH_PAYLOAD_BYTES = 982_320
# TCP loss on the WiFi link stalls the device ~1.5-3 s (its retransmit timer;
# it ignores dup-ACKs). That is not a reason to re-prompt it. Only after this
# long with no bytes at all do we ask it to resume from the contiguous prefix.
_STALL_RESUME_S = 8.0
_HANDSHAKE_REPLY_TIMEOUT_S = 5.0
# Give up if no *new contiguous* bytes for this long (leaves room for one or two
# resume ACKs at _STALL_RESUME_S intervals).
_PROGRESS_IDLE_S = 30.0
# Largest file accepted when the device never reports a size. Block offsets
# come off the wire, so without a ceiling one corrupt u32 allocates ~4 GB.
_MAX_FILE_BYTES = 1 << 30


def _get_data_port() -> int:
    return configured_device_port()


def _parse_discovery_reply(ip: str, data: bytes) -> dict:
    parsed = parse_discovery_text(ip, data)
    return {
        "ip": parsed["ip"],
        "ssid": parsed["ssid"],
        "device_name": parsed["device_name"],
        "model": parsed.get("model", ""),
        "serial": parsed.get("serial", ""),
        "vehicle": parsed.get("vehicle", ""),
    }


def _open_device_socket(timeout: float = 10) -> tuple[socket.socket, str]:
    """Open TCP to the first reachable AiM device IP.

    Windows cannot reuse a socket after a failed connect() — each candidate
    gets a fresh socket (WinError 10022 otherwise).
    """
    port = _get_data_port()
    last_exc: OSError | None = None
    for ip in candidate_device_ips():
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # Default RCVBUF (often 64-128 KB) caps the TCP receive window well
        # below what a download over WiFi can sustain; a bigger window lets
        # the device keep sending without stalling on ACKs. Best-effort: some
        # platforms clamp this silently, which is harmless.
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        try:
            sock.settimeout(timeout)
            sock.connect((ip, port))
            record_tcp_device(ip)
            logger.info("Connected to AiM device at %s:%d", ip, port)
            return sock, ip
        except OSError as exc:
            last_exc = exc
            sock.close()
            continue
    if last_exc:
        raise last_exc
    raise OSError("Could not connect to AiM device")


# ── Discovery ───────────────────────────────────────────────────────────────

def discover_device() -> dict | None:
    """Discover AiM device info via UDP broadcast.

    Returns dict with ip, ssid, device_name or None if not found.
    """
    probed = probe_device_ips()
    if not probed:
        return None

    ip, data = probed
    info = _parse_discovery_reply(ip, data)
    remember_device(ip, data)
    logger.info("Discovered AiM device at %s: %s", ip, info)
    return info


# ── TCP helpers ──────────────────────────────────────────────────────────────

def _send_and_await_frame(
    sock: socket.socket, msg: bytes, label: str, timeout: float = 5.0
) -> bytes:
    """Send `msg` and return as soon as one complete protocol frame has arrived.

    A single-frame reply (the handshake hello-ack) needs no idle window for
    continuation data.
    """
    logger.debug("Sending %s (%d bytes)", label, len(msg))
    sock.sendall(msg)
    sock.settimeout(timeout)
    buf = b""
    try:
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            buf += chunk
            try:
                frame, _ = decode_frame(buf)
            except ValueError:
                break
            if frame is not None:
                break
    except socket.timeout:
        logger.warning(
            "AiM device sent no complete frame within %.1fs for %s (%d bytes received)",
            timeout, label, len(buf),
        )
    logger.debug("Received %d bytes for %s", len(buf), label)
    return buf


def _extract_session_csv(raw: bytes) -> str | None:
    """Find and extract the CSV session listing from the TCP stream."""
    text = raw.decode("ascii", errors="replace")
    start = text.find("name,size,date,hour,")
    if start == -1:
        return None
    end = text.find("<STCP", start)
    if end == -1:
        end = len(text)
    csv_text = text[start:end]
    csv_text = csv_text.replace("\r\n", "\n")
    csv_text = re.sub(r"[^\x20-\x7e\n]", "", csv_text)
    return csv_text.strip()


def parse_aim_session_csv_rows(csv_text: str) -> list[dict]:
    """Parse session list CSV body into QuickScope session dicts."""
    sessions = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for row in reader:
        name = row.get("name", "").strip()
        if not name:
            continue
        try:
            sessions.append({
                "filename": name,
                "size": int(row.get("size", 0) or 0),
                "date": row.get("date", ""),
                "hour": row.get("hour", ""),
                "lap_count": int(row.get("nlap", 0) or 0),
                "vehicle": row.get("veicolo", ""),
                "device_name": row.get("device", ""),
            })
        except (ValueError, KeyError):
            continue
    return sessions


# ── File download ────────────────────────────────────────────────────────────

def _build_download_request(filepath: str) -> bytes:
    """Build a STNC file request for the given device path."""
    path_bytes = filepath.encode("ascii")[:32].ljust(32, b"\x00")

    payload = bytearray(64)
    payload[8] = 0x02
    payload[10] = 0x04
    payload[0x18] = 0x41  # 'A' marker
    payload[0x20:0x20 + 32] = path_bytes

    header = b"<hSTNC" + struct.pack("<I", 0x40) + b"\x00>"
    checksum = sum(payload) & 0xFFFF
    trailer = b"<STNC" + struct.pack("<H", checksum) + b">"

    return header + bytes(payload) + trailer


# 64-byte STCP control frames carry an opcode byte at payload[24]:
# 'A'/'I'/'E'/'H' handshake+ack frames and 'Q' size/ack frames
# (STCP_CONTROL_OPS in aim_live).


def _is_stcp_file_payload(payload: bytes) -> bool:
    """True when payload is file data (u32 offset + bytes), not a control frame."""
    if len(payload) <= 4:
        return False
    if (
        len(payload) == 64
        and payload[4:8] == b"\x00\x00\x00\x00"
        and payload[STCP_OPCODE_OFFSET] in STCP_CONTROL_OPS
    ):
        return False
    return True


class _IncrementalReassembler:
    """Places (absolute file offset, data) blocks and tracks byte coverage.

    Idempotent: a block the device replays (after a resume ACK) lands on the
    same bytes it already wrote, so duplicates can never shift or corrupt the
    file. `len()` is the *contiguous* prefix length -- the value the device
    wants in a progress ACK -- while `covered` counts every distinct byte.
    """

    def __init__(self, total_size: int = 0) -> None:
        self.file_data = bytearray()
        self._spans: list[list[int]] = []  # sorted, disjoint [start, end)
        self.conflicts = 0  # replayed bytes that differed from what we had
        self.rejected = 0  # blocks placed beyond the end of the file
        # The last block may run past the reported size (result() trims it),
        # so allow one batch of slack before calling an offset corrupt.
        self._limit = total_size + _BATCH_PAYLOAD_BYTES if total_size > 0 else _MAX_FILE_BYTES

    def feed(self, file_offset: int, data: bytes) -> None:
        end = file_offset + len(data)
        if end > self._limit:
            self.rejected += 1
            return
        if end > len(self.file_data):
            self.file_data.extend(b"\x00" * (end - len(self.file_data)))
        if self._is_covered(file_offset, end) and self.file_data[file_offset:end] != data:
            self.conflicts += 1
        self.file_data[file_offset:end] = data
        self._add_span(file_offset, end)

    def _is_covered(self, start: int, end: int) -> bool:
        return any(s <= start and end <= e for s, e in self._spans)

    def _add_span(self, start: int, end: int) -> None:
        spans = self._spans
        # Fast path: in-order append (the normal case).
        if spans and start == spans[-1][1]:
            spans[-1][1] = end
            return
        merged: list[list[int]] = []
        placed = False
        for s, e in spans:
            if e < start:
                merged.append([s, e])
            elif end < s:
                if not placed:
                    merged.append([start, end])
                    placed = True
                merged.append([s, e])
            else:
                start, end = min(start, s), max(end, e)
        if not placed:
            merged.append([start, end])
        self._spans = merged

    @property
    def covered(self) -> int:
        return sum(e - s for s, e in self._spans)

    def __len__(self) -> int:
        """Contiguous bytes from offset 0."""
        if self._spans and self._spans[0][0] == 0:
            return self._spans[0][1]
        return 0

    def is_complete(self, total: int) -> bool:
        return total > 0 and len(self) >= total


def _drain_download_frames_incremental(
    frame_buffer: bytes,
    reassembler: "_IncrementalReassembler",
    trace: AimDownloadTrace | None = None,
    total_file_size: int = 0,
    frame_counts: dict[str, int] | None = None,
) -> bytes:
    """Parse complete frames out of `frame_buffer`, feeding file-data blocks
    into `reassembler` as they're decoded instead of re-parsing the whole
    stream from byte 0 on every `recv()` in `_receive_file_data`.
    Download mode never ACKs control frames inline (only batch/stall ACKs),
    so this never touches the socket.

    Stops as soon as the file is complete: anything after it on the same TCP
    (RS3 lists sessions next, RS3_PULL_241/242) also uses offset-0 STCP blocks
    and would overwrite the file.
    """
    # Walk the buffer by offset: slicing it after every frame copied the whole
    # remainder once per frame.
    pos = 0
    while not reassembler.is_complete(total_file_size):
        try:
            frame, consumed = decode_frame(frame_buffer, pos)
        except ValueError as exc:
            if trace is not None:
                trace.log("frame_resync", error=str(exc), buffer_len=len(frame_buffer) - pos)
            pos = resync_offset(frame_buffer, pos)
            continue
        if frame is None or consumed == 0:
            break
        pos += consumed
        if frame_counts is not None:
            key = f"{frame.cmd.decode('ascii', errors='replace')}:{len(frame.payload)}"
            frame_counts[key] = frame_counts.get(key, 0) + 1
        if frame.cmd != b"STCP":
            continue
        if _is_stcp_file_payload(frame.payload):
            file_offset = struct.unpack_from("<I", frame.payload, 0)[0]
            data = frame.payload[4:]
            if data:
                rejected = reassembler.rejected
                reassembler.feed(file_offset, data)
                if trace is not None and reassembler.rejected != rejected:
                    trace.log("block_out_of_range", file_offset=file_offset, block_bytes=len(data))
        elif trace is not None and len(frame.payload) <= 64:
            trace.log_frame(frame, ack_sent=False)
    return frame_buffer[pos:] if pos else frame_buffer


def _make_download_progress_ack(byte_count: int) -> bytes:
    """Build an STCP micro-ACK carrying cumulative reassembled byte count."""
    return encode_frame(b"STCP", struct.pack("<I", byte_count))


def _send_download_progress_ack(sock: socket.socket, byte_count: int) -> None:
    sock.sendall(_make_download_progress_ack(byte_count))


def _prompt_next_batch(
    sock: socket.socket,
    *,
    extracted_size: int,
    acked_through: int,
    total_file_size: int = 0,
    trace: AimDownloadTrace | None,
) -> tuple[int, int]:
    """ACK the exact batch boundary once a full batch has landed since the last ACK.

    `extracted_size` must be the contiguous byte count from offset 0. The ACK
    value is always `acked_through + k * _BATCH_PAYLOAD_BYTES` -- never the raw
    contiguous count -- because RS3 only ever ACKs boundaries and every ACK
    queues a batch starting at its value. If a read overshoots several
    boundaries, only the highest one is ACKed (one ACK == one queued batch).
    Nothing is sent for the final (partial) batch.
    """
    batches = (extracted_size - acked_through) // _BATCH_PAYLOAD_BYTES
    if batches < 1:
        return acked_through, 0
    if total_file_size > 0 and extracted_size >= total_file_size:
        return acked_through, 0
    boundary = acked_through + batches * _BATCH_PAYLOAD_BYTES
    _send_download_progress_ack(sock, boundary)
    if trace is not None:
        trace.log(
            "batch_complete_ack",
            extracted_bytes=extracted_size,
            acked_through=boundary,
            ack_payload_bytes=boundary,
        )
    return boundary, 1


class _SendSink(Protocol):
    def sendall(self, data: bytes) -> None: ...


class BufferedSink:
    """Collects outbound frames so an async transport can write + drain them."""

    def __init__(self) -> None:
        self._pending: list[bytes] = []

    def sendall(self, data: bytes) -> None:
        self._pending.append(data)

    def take(self) -> bytes:
        data, self._pending = b"".join(self._pending), []
        return data


class AimFileReceiver:
    """Transport-agnostic STCP file receive state machine.

    The caller owns the I/O: it calls ``idle_expired()`` before each read,
    ``feed()`` with received bytes, ``on_silence()`` when a short read timeout
    elapses with nothing, and ``on_eof()`` when the peer closes. ACKs go to
    ``sink.sendall`` (a socket, or a ``BufferedSink`` for asyncio).

    Blocks are placed by absolute offset; the device is ACKed only at batch
    boundaries (RS3 behaviour). A pause is normally the device's own TCP
    retransmit after WiFi loss, so it is waited out -- only a long dead
    silence triggers a resume ACK for the contiguous prefix.
    """

    def __init__(
        self,
        total_file_size: int,
        sink: _SendSink,
        trace: AimDownloadTrace | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> None:
        self.total_file_size = total_file_size
        self._sink = sink
        self._trace = trace
        self._on_progress = on_progress
        # The raw stream itself is not kept (that held the file in memory a
        # second time). A failed download's trace needs only its size, its mix
        # of frames and its last bytes, so those are tracked as it arrives.
        self._raw_len = 0
        self._raw_tail = bytearray()
        self._frame_counts: dict[str, int] = {}
        self.frame_buffer = b""
        self._reassembler = _IncrementalReassembler(total_file_size)
        self._extracted_size = 0
        self._micro_acks_sent = 0
        self._resume_acks = 0
        self._recv_count = 0
        self._acked_through = 0
        idle_limit_s = 60 + max(0, total_file_size // 100_000)
        self._idle_deadline = time.monotonic() + idle_limit_s
        self._last_rx = time.monotonic()
        self._last_progress_size = 0
        if trace is not None:
            trace.log("receive_start", total_file_size=total_file_size)

    @property
    def is_complete(self) -> bool:
        return self._reassembler.is_complete(self.total_file_size)

    def idle_expired(self) -> bool:
        """True (and logged) once no new contiguous bytes arrived for too long."""
        if time.monotonic() <= self._idle_deadline:
            return False
        if self._trace is not None:
            self._trace.log(
                "idle_timeout",
                raw_bytes=self._raw_len,
                extracted_bytes=self._extracted_size,
                covered_bytes=self._reassembler.covered,
                expected_bytes=self.total_file_size,
                micro_acks_sent=self._micro_acks_sent,
                resume_acks=self._resume_acks,
                recv_count=self._recv_count,
                frame_buffer_len=len(self.frame_buffer),
            )
        logger.warning(
            "Download idle timeout: contiguous=%d covered=%d/%d acks=%d resumes=%d recv=%d",
            self._extracted_size,
            self._reassembler.covered,
            self.total_file_size,
            self._micro_acks_sent,
            self._resume_acks,
            self._recv_count,
        )
        return True

    def on_silence(self) -> None:
        silent_s = time.monotonic() - self._last_rx
        if not (
            self._extracted_size > 0
            and self.total_file_size > 0
            and self._extracted_size < self.total_file_size
            and silent_s >= _STALL_RESUME_S
        ):
            return
        # Dead silence well past any TCP retransmit: ask the device to resume
        # from the contiguous prefix. Safe because replayed blocks are written
        # at their absolute offsets.
        _send_download_progress_ack(self._sink, self._extracted_size)
        self._acked_through = self._extracted_size
        self._resume_acks += 1
        self._micro_acks_sent += 1
        # Restart only the silence clock -- NOT idle_deadline, or a dead device
        # would be re-prompted forever instead of timing out.
        self._last_rx = time.monotonic()
        if self._trace is not None:
            self._trace.log(
                "resume_ack_sent",
                silent_s=round(silent_s, 2),
                ack_payload_bytes=self._extracted_size,
                covered_bytes=self._reassembler.covered,
                expected_bytes=self.total_file_size,
            )

    def on_eof(self) -> None:
        if self._trace is not None:
            self._trace.log(
                "recv_eof", raw_bytes=self._raw_len, extracted_bytes=self._extracted_size
            )

    def connection_reset_error(self) -> RuntimeError:
        if self._trace is not None:
            self._trace.log(
                "connection_reset",
                raw_bytes=self._raw_len,
                extracted_bytes=self._extracted_size,
                expected_bytes=self.total_file_size,
                acked_through=self._acked_through,
                micro_acks_sent=self._micro_acks_sent,
                resume_acks=self._resume_acks,
            )
        return RuntimeError(
            f"Device closed download connection after {self._extracted_size} contiguous bytes "
            f"(expected {self.total_file_size}, acked_through={self._acked_through})"
        )

    def feed(self, chunk: bytes) -> None:
        self._last_rx = time.monotonic()
        self._recv_count += 1
        self._raw_len += len(chunk)
        self._raw_tail = (self._raw_tail + chunk[-STREAM_TAIL_BYTES:])[-STREAM_TAIL_BYTES:]
        self.frame_buffer = _drain_download_frames_incremental(
            self.frame_buffer + chunk, self._reassembler, self._trace, self.total_file_size,
            self._frame_counts,
        )

        extracted_size = self._extracted_size = len(self._reassembler)
        self._acked_through, batch_sent = _prompt_next_batch(
            self._sink,
            extracted_size=extracted_size,
            acked_through=self._acked_through,
            total_file_size=self.total_file_size,
            trace=self._trace,
        )
        self._micro_acks_sent += batch_sent
        trace = self._trace
        if trace is not None and (
            extracted_size > self._last_progress_size
            or self._recv_count == 1
            or self._recv_count % 50 == 0
        ):
            trace.log(
                "recv_chunk",
                chunk_bytes=len(chunk),
                raw_bytes=self._raw_len,
                extracted_bytes=extracted_size,
                frame_buffer_remainder=len(self.frame_buffer),
                recv_count=self._recv_count,
            )
        if extracted_size <= self._last_progress_size:
            return
        self._last_progress_size = extracted_size
        self._idle_deadline = self._last_rx + _PROGRESS_IDLE_S
        if self._on_progress is not None and self.total_file_size > 0:
            self._on_progress(extracted_size, self.total_file_size)
        if trace is not None:
            trace.log(
                "progress",
                extracted_bytes=extracted_size,
                expected_bytes=self.total_file_size,
                micro_acks_sent=self._micro_acks_sent,
            )

    def _log_stream_summary(self, *, extracted: int) -> None:
        assert self._trace is not None
        self._trace.log_stream_summary(
            raw_bytes=self._raw_len, extracted=extracted, expected=self.total_file_size,
            frame_counts=self._frame_counts, tail=bytes(self._raw_tail),
        )

    def result(self) -> bytearray:
        """The complete file, or ``RuntimeError`` describing what is missing."""
        trace = self._trace
        reassembler = self._reassembler
        total = self.total_file_size
        covered = reassembler.covered
        if covered == 0:
            if trace is not None:
                self._log_stream_summary(extracted=0)
            raise RuntimeError(f"No data blocks found in {self._raw_len} bytes of response")

        if reassembler.conflicts and trace is not None:
            trace.log("replay_conflicts", count=reassembler.conflicts)
        if total > 0 and not reassembler.is_complete(total):
            if trace is not None:
                self._log_stream_summary(extracted=self._extracted_size)
            trace_hint = f" trace={trace.path}" if trace is not None else ""
            raise RuntimeError(
                f"Incomplete download: contiguous {self._extracted_size} / covered {covered} bytes, "
                f"expected {total} (raw={self._raw_len}, acks={self._micro_acks_sent}, "
                f"resumes={self._resume_acks}, recv_chunks={self._recv_count}){trace_hint}"
            )

        # Hand back the buffer itself: copying it would hold the file twice.
        file_data = reassembler.file_data
        if total > 0 and len(file_data) > total:
            del file_data[total:]
        return file_data


def _receive_file_data(
    sock: socket.socket,
    total_file_size: int,
    trace: AimDownloadTrace | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> bytearray:
    """Read STCP file blocks from a blocking socket until the whole file is covered."""
    receiver = AimFileReceiver(total_file_size, sock, trace, on_progress)
    sock.settimeout(0.5)
    while not receiver.is_complete:
        if receiver.idle_expired():
            break
        try:
            chunk = sock.recv(262144)
        except ConnectionResetError as exc:
            raise receiver.connection_reset_error() from exc
        except socket.timeout:
            receiver.on_silence()
            continue
        if not chunk:
            receiver.on_eof()
            break
        receiver.feed(chunk)
    return receiver.result()


def device_file_path(filename: str) -> str:
    return f"1:/mem/{filename}"


def build_download_request(filename: str) -> bytes:
    """STNC ``0x00040002`` file request (RS3_PULL_241/242: sent as-is on the list TCP)."""
    return _build_download_request(device_file_path(filename))


def file_size_from_info_payload(payload: bytes) -> int:
    """Device-reported size from the 64 B ``Q`` reply to a file request (payload[16:20])."""
    if len(payload) < 20:
        return 0
    return struct.unpack_from("<I", payload, 0x10)[0]


def pull_target_path(dest_dir: Path, filename: str, expected_size: int) -> Path:
    """Where a pulled log goes, without touching a different local session.

    The logger reuses file names once its memory is cleared, so a local file
    with the same name is the same session only if it is also the size the
    device reports. One that differs is somebody's data: it stays where it is
    and the pulled file gets a ``_2``, ``_3`` ... suffix. With no size to
    compare (``expected_size <= 0``) the existing file is taken as the session.
    """
    stem, suffix = Path(filename).stem, Path(filename).suffix
    for n in range(1, 1000):
        candidate = dest_dir / (filename if n == 1 else f"{stem}_{n}{suffix}")
        if not candidate.exists():
            return candidate
        if expected_size <= 0 or candidate.stat().st_size == expected_size:
            return candidate
    return dest_dir / filename


def reuse_local_file(
    out_path: Path,
    expected_size: int,
    on_progress: Callable[[int, int], None] | None = None,
) -> bool:
    """True when ``out_path`` (from :func:`pull_target_path`) is already on disk."""
    if not out_path.exists():
        return False
    local_size = out_path.stat().st_size
    logger.debug("Session %s already exists locally, skipping.", out_path.name)
    if on_progress is not None:
        total = expected_size if expected_size > 0 else local_size
        on_progress(total, total if total > 0 else 1)
    return True


def write_file_atomically(out_path: Path, file_data: bytes | bytearray) -> None:
    tmp_path = out_path.with_name(f"{out_path.name}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_bytes(file_data)
    os.replace(tmp_path, out_path)


def download_aim_session(
    filename: str,
    dest_dir: Path,
    expected_size: int = 0,
    on_progress: Callable[[int, int], None] | None = None,
) -> Path:
    """Download one log file over a **dedicated** TCP session (legacy fallback).

    The normal path downloads on the primary hub TCP like RS3
    (``AimLiveClient.download_file``); this one opens its own socket and must
    only run after the primary is closed (``116CaptureWireshark`` stream 38).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = pull_target_path(dest_dir, filename, expected_size)

    if reuse_local_file(out_path, expected_size, on_progress):
        return out_path

    filepath = device_file_path(filename)
    port = _get_data_port()
    logger.info("Downloading %s via AiM device port %d ...", filepath, port)

    s, device_ip = _open_device_socket(timeout=30)
    trace = AimDownloadTrace(filename, expected_size or 0)
    try:
        logger.info("Downloading %s from %s:%d (trace: %s)", filepath, device_ip, port, trace.path)
        trace.log("connect", device_ip=device_ip, port=port, filepath=filepath)

        # Step 1: Handshake
        _send_and_await_frame(s, _HANDSHAKE, "handshake", timeout=_HANDSHAKE_REPLY_TIMEOUT_S)
        trace.log("handshake_ok")

        # Step 2: File request
        request = _build_download_request(filepath)
        s.sendall(request)
        trace.log("file_request_sent", request_bytes=len(request))

        # Step 3: Receive two info responses (168 bytes total)
        s.settimeout(5)
        info_data = b""
        try:
            while len(info_data) < 168:
                chunk = s.recv(4096)
                if not chunk:
                    break
                info_data += chunk
        except socket.timeout:
            pass

        trace.log("info_responses", bytes_received=len(info_data))

        # Extract total file size from second info response
        total_file_size = 0
        if len(info_data) >= 168:
            total_file_size = file_size_from_info_payload(info_data[84 + 12 : 84 + 12 + 64])
            logger.info("File size from device: %d bytes", total_file_size)
            trace.log("file_size", total_file_size=total_file_size)
        if total_file_size <= 0 and expected_size > 0:
            # Session list already told us the size; completion detection
            # needs it even if the info frames were short or split.
            total_file_size = expected_size
            trace.log("file_size_from_session_list", total_file_size=total_file_size)

        # Step 4: ACK triggers data transmission
        s.sendall(_ACK)
        trace.log("initial_ack_sent")

        # Step 5: Receive data blocks
        file_data = _receive_file_data(s, total_file_size, trace, on_progress=on_progress)

        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    except Exception as exc:
        trace.close(status="error", error=str(exc))
        raise
    else:
        trace.close(status="ok", bytes=len(file_data))
    finally:
        s.close()

    logger.info(
        "Downloaded %s: %d bytes%s",
        filename,
        len(file_data),
        f" (expected {total_file_size})" if total_file_size else "",
    )

    write_file_atomically(out_path, file_data)
    return out_path
