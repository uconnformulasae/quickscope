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
import re
import socket
import struct
import time
from pathlib import Path

from services.aim_discovery import (
    DATA_PORT,
    candidate_device_ips,
    configured_device_ip,
    parse_discovery_text,
    probe_device_ips,
)
from services.aim_device_cache import record_from_parsed, record_tcp_device
from services.aim_download_trace import AimDownloadTrace
from services.aim_live import decode_frame, encode_frame
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

# ── Hardcoded protocol messages (from Wireshark captures of RaceStudio3) ────
# CRITICAL: these must be exact byte-for-byte copies — the device firmware
# silently drops messages with wrong framing or size.
# Each STNC message is exactly 84 bytes: header(12) + payload(64) + trailer(8)

_HANDSHAKE = bytes.fromhex("3c685354435008000000003e00000000060800003c535443500e003e")
_STNC_SYSTEM = bytes.fromhex("3c6853544e4340000000003e000000000000000010000100000000004000000000000000410000000000000000000000000000000000000000000000000000000000000000000000000000003c53544e4392003e")
_STNC_PREP_SESSIONS = bytes.fromhex("3c6853544e4340000000003e0000000000000000510002000000000000000000000000004100000000000000ffffffff000000000000000000000000000000000000000000000000000000003c53544e4390043e")
_STNC_GET_SESSIONS = bytes.fromhex("3c6853544e4340000000003e000000000000000024000200000000000000000000000000410000000000000000000000000000000000000000000000000000000000000000000000000000003c53544e4367003e")
_ACK = bytes.fromhex("3c685354435004000000003e000000003c5354435000003e")
# Live-stream polling uses zero payloads; file downloads use cumulative byte counts.
_STCP_MICRO_ACK = encode_frame(b"STCP", b"\x00\x00\x00\x00")
_STCP_Q_ACK_OPCODE = ord("Q")
_STCP_Q_ACK_OPCODE_OFFSET = 24
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


def _get_device_ip() -> str:
    return configured_device_ip()


def _get_data_port() -> int:
    return int(load_settings().get("aim_device_port", DATA_PORT))


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

def is_aim_connected() -> bool:
    """Check if an AiM device is reachable via UDP discovery probe."""
    return probe_device_ips() is not None


def discover_device() -> dict | None:
    """Discover AiM device info via UDP broadcast.

    Returns dict with ip, ssid, device_name or None if not found.
    """
    probed = probe_device_ips()
    if not probed:
        return None

    ip, data = probed
    info = _parse_discovery_reply(ip, data)
    record_from_parsed(parse_discovery_text(ip, data))
    logger.info("Discovered AiM device at %s: %s", ip, info)
    return info


# ── TCP helpers ──────────────────────────────────────────────────────────────

def _send_and_recv(sock: socket.socket, msg: bytes, label: str, read_timeout: float = 3.0) -> bytes:
    """Send one message and read the response. Each must be a separate TCP write."""
    logger.debug("Sending %s (%d bytes)", label, len(msg))
    sock.sendall(msg)

    sock.settimeout(read_timeout)
    buf = b""
    try:
        chunk = sock.recv(8192)
        if chunk:
            buf += chunk
            # Read continuation data
            sock.settimeout(0.5)
            while True:
                try:
                    more = sock.recv(8192)
                    if not more:
                        break
                    buf += more
                except socket.timeout:
                    break  # idle window elapsed: the reply is complete
    except socket.timeout:
        logger.warning("No reply from AiM device within %.1fs for %s", read_timeout, label)

    logger.debug("Received %d bytes for %s", len(buf), label)
    return buf


def _send_and_await_frame(
    sock: socket.socket, msg: bytes, label: str, timeout: float = 5.0
) -> bytes:
    """Send `msg` and return as soon as one complete protocol frame has arrived.

    `_send_and_recv` always waits an extra 0.5 s idle window for continuation
    data; a single-frame reply (the handshake hello-ack) doesn't need it.
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
    # Rows are separated by null bytes (appear as ".." in text)
    csv_text = csv_text.replace("\r\n", "\n").replace("..", "\n")
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


# ── Session listing ──────────────────────────────────────────────────────────

def list_aim_sessions() -> list[dict]:
    """Deprecated: session list on its own short-lived TCP.

    Only works when no primary hub TCP is open -- the device silently ignores a
    second port-2000 connection (QS_Pull_241/242 lost ~37 s per pull this way).
    App code must use ``aim_primary_hub.list_sessions`` instead; this remains for
    standalone scripts.
    """
    return _list_aim_sessions_legacy_tcp()


def _list_aim_sessions_legacy_tcp() -> list[dict]:
    """Fallback: own TCP for session list (pre–primary-hub behavior)."""
    port = _get_data_port()
    logger.info("Connecting to AiM device on port %d for session listing...", port)

    try:
        s, _device_ip = _open_device_socket(timeout=10)
    except OSError as exc:
        logger.error("Failed to connect to AiM device: %s", exc)
        raise ConnectionError(f"Failed to connect to AiM device: {exc}") from exc

    try:
        all_data = b""

        # Step 0: STCP handshake — device ignores all STNC messages without this
        resp = _send_and_recv(s, _HANDSHAKE, "STCP handshake", read_timeout=5)
        all_data += resp

        # Step 1: System info query
        resp = _send_and_recv(s, _STNC_SYSTEM, "STNC system info", read_timeout=5)
        all_data += resp

        # Step 2: ACK
        resp = _send_and_recv(s, _ACK, "ACK", read_timeout=3)
        all_data += resp

        # Step 3: Session prep #1
        resp = _send_and_recv(s, _STNC_PREP_SESSIONS, "STNC session prep #1")
        all_data += resp

        # Step 4: Session prep #2
        resp = _send_and_recv(s, _STNC_PREP_SESSIONS, "STNC session prep #2")
        all_data += resp

        # Step 5: Get session list
        resp = _send_and_recv(s, _STNC_GET_SESSIONS, "STNC get sessions")
        all_data += resp

        # Step 6: ACK triggers CSV delivery
        resp = _send_and_recv(s, _ACK, "ACK (trigger CSV)", read_timeout=10)
        all_data += resp

        # Read remaining CSV data
        s.settimeout(5)
        try:
            while True:
                chunk = s.recv(8192)
                if not chunk:
                    break
                all_data += chunk
                s.settimeout(3)
        except (socket.timeout, OSError):
            pass  # end of CSV: the device stops sending without closing the socket

        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    finally:
        s.close()

    logger.info("Received %d total bytes from device", len(all_data))

    csv_text = _extract_session_csv(all_data)
    if csv_text is None:
        logger.error("Could not find session CSV in device response")
        return []

    sessions = parse_aim_session_csv_rows(csv_text)
    logger.info("Found %d sessions on device", len(sessions))
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
# 'A'/'I'/'E'/'H' handshake+ack frames and 'Q' size/ack frames.
_STCP_CONTROL_OPCODES = frozenset(b"AIQEH")


def _is_stcp_file_payload(payload: bytes) -> bool:
    """True when payload is file data (u32 offset + bytes), not a control frame."""
    if len(payload) <= 4:
        return False
    if (
        len(payload) == 64
        and payload[4:8] == b"\x00\x00\x00\x00"
        and payload[_STCP_Q_ACK_OPCODE_OFFSET] in _STCP_CONTROL_OPCODES
    ):
        return False
    return True


def _iter_file_blocks(raw: bytes) -> list[tuple[int, bytes]]:
    """Parse STCP file-data frames in stream order.

    Control frames use 4- or 64-byte payloads; file blocks are larger and
    begin with a little-endian u32 file offset followed by raw bytes.
    """
    blocks: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(raw):
        try:
            frame, consumed = decode_frame(raw, offset)
        except ValueError:
            next_h = raw.find(b"<h", offset + 1)
            if next_h == -1:
                break
            offset = next_h
            continue
        if frame is None or consumed == 0:
            break
        if frame.cmd == b"STCP" and _is_stcp_file_payload(frame.payload):
            file_offset = struct.unpack_from("<I", frame.payload, 0)[0]
            file_data = frame.payload[4:]
            if file_data:
                blocks.append((file_offset, file_data))
        offset += consumed
    return blocks


class _IncrementalReassembler:
    """Places (absolute file offset, data) blocks and tracks byte coverage.

    Idempotent: a block the device replays (after a resume ACK) lands on the
    same bytes it already wrote, so duplicates can never shift or corrupt the
    file. `len()` is the *contiguous* prefix length -- the value the device
    wants in a progress ACK -- while `covered` counts every distinct byte.
    """

    def __init__(self) -> None:
        self.file_data = bytearray()
        self._spans: list[list[int]] = []  # sorted, disjoint [start, end)
        self.conflicts = 0  # replayed bytes that differed from what we had

    def feed(self, file_offset: int, data: bytes) -> None:
        end = file_offset + len(data)
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


def _extract_data_blocks(raw: bytes, expected_size: int = 0) -> bytes:
    """Parse STCP data blocks out of a whole stream and reassemble the file."""
    blocks = _iter_file_blocks(raw)
    if not blocks:
        raise RuntimeError(f"No data blocks found in {len(raw)} bytes of response")

    reassembler = _IncrementalReassembler()
    for file_offset, data in blocks:
        reassembler.feed(file_offset, data)
    file_data = reassembler.file_data

    if expected_size > 0 and len(file_data) > expected_size:
        return bytes(file_data[:expected_size])
    return bytes(file_data)


def _try_extract_file_size(raw: bytes) -> int:
    """Return reassembled file byte length from STCP blocks, or 0 if none yet."""
    try:
        return len(_extract_data_blocks(raw))
    except RuntimeError:
        return 0


def _drain_download_frames_incremental(
    frame_buffer: bytes,
    reassembler: "_IncrementalReassembler",
    trace: AimDownloadTrace | None = None,
    total_file_size: int = 0,
) -> bytes:
    """Parse complete frames out of `frame_buffer`, feeding file-data blocks
    into `reassembler` as they're decoded instead of re-parsing the whole
    stream from byte 0 (see `_try_extract_file_size`'s old hot-path use,
    now replaced by this for `_receive_file_data`'s per-`recv()` loop).
    Download mode never ACKs control frames inline (only batch/stall ACKs),
    so unlike `_drain_download_frames()` this never touches the socket.

    Stops as soon as the file is complete: anything after it on the same TCP
    (RS3 lists sessions next, RS3_PULL_241/242) also uses offset-0 STCP blocks
    and would overwrite the file.
    """
    while not reassembler.is_complete(total_file_size):
        try:
            frame, consumed = decode_frame(frame_buffer)
        except ValueError as exc:
            if trace is not None:
                trace.log("frame_resync", error=str(exc), buffer_len=len(frame_buffer))
            resync = frame_buffer.find(b"<h", 1)
            if resync == -1:
                frame_buffer = b""
                break
            frame_buffer = frame_buffer[resync:]
            continue
        if frame is None or consumed == 0:
            break
        frame_buffer = frame_buffer[consumed:]
        if frame.cmd != b"STCP":
            continue
        if _is_stcp_file_payload(frame.payload):
            file_offset = struct.unpack_from("<I", frame.payload, 0)[0]
            data = frame.payload[4:]
            if data:
                reassembler.feed(file_offset, data)
        elif trace is not None and len(frame.payload) <= 64:
            trace.log_frame(frame, ack_sent=False)
    return frame_buffer


def _make_download_progress_ack(byte_count: int) -> bytes:
    """Build an STCP micro-ACK carrying cumulative reassembled byte count."""
    return encode_frame(b"STCP", struct.pack("<I", byte_count))


def _send_download_progress_ack(sock: socket.socket, byte_count: int) -> None:
    sock.sendall(_make_download_progress_ack(byte_count))


def _process_download_frame(
    sock: socket.socket,
    frame,
    trace: AimDownloadTrace | None = None,
    *,
    reply_to_control: bool = True,
) -> bool:
    """Handle one STCP control frame during transfer.

    Live polling replies to 4-byte and Q-64 server frames with zero micro-ACKs.
    File download ignores those frames; batch progress ACKs are sent separately.
    """
    if frame.cmd != b"STCP":
        return False
    if not reply_to_control:
        if trace is not None and len(frame.payload) <= 64:
            trace.log_frame(frame, ack_sent=False)
        return False
    ack = False
    if len(frame.payload) == 4:
        sock.sendall(_STCP_MICRO_ACK)
        ack = True
    elif (
        len(frame.payload) == 64
        and frame.payload[_STCP_Q_ACK_OPCODE_OFFSET] == _STCP_Q_ACK_OPCODE
    ):
        sock.sendall(_STCP_MICRO_ACK)
        ack = True
    if trace is not None and (ack or len(frame.payload) <= 64):
        trace.log_frame(frame, ack_sent=ack)
    return ack


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


def _drain_download_frames(
    sock: socket.socket,
    frame_buffer: bytes,
    trace: AimDownloadTrace | None = None,
    *,
    reply_to_control: bool = True,
) -> tuple[bytes, int]:
    """Parse all complete frames in frame_buffer; optionally send live micro-acks."""
    micro_acks_sent = 0
    while True:
        try:
            frame, consumed = decode_frame(frame_buffer)
        except ValueError as exc:
            if trace is not None:
                trace.log("frame_resync", error=str(exc), buffer_len=len(frame_buffer))
            resync = frame_buffer.find(b"<h", 1)
            if resync == -1:
                frame_buffer = b""
                break
            frame_buffer = frame_buffer[resync:]
            continue
        if frame is None or consumed == 0:
            break
        frame_buffer = frame_buffer[consumed:]
        if _process_download_frame(
            sock, frame, trace, reply_to_control=reply_to_control
        ):
            micro_acks_sent += 1
        elif trace is not None and frame.cmd == b"STCP" and len(frame.payload) <= 64:
            trace.log_frame(frame, ack_sent=False)
    return frame_buffer, micro_acks_sent


def _receive_file_data(
    sock: socket.socket,
    total_file_size: int,
    trace: AimDownloadTrace | None = None,
) -> bytes:
    """Read STCP file blocks until the whole file is covered.

    Blocks are placed by absolute offset; the device is ACKed only at batch
    boundaries (RS3 behaviour). A pause is normally the device's own TCP
    retransmit after WiFi loss, so it is waited out -- only a long dead
    silence triggers a resume ACK for the contiguous prefix.
    """
    raw_data = bytearray()
    frame_buffer = b""
    reassembler = _IncrementalReassembler()
    extracted_size = 0
    micro_acks_sent = 0
    resume_acks = 0
    recv_count = 0
    acked_through = 0
    idle_limit_s = 60 + max(0, total_file_size // 100_000)
    idle_deadline = time.monotonic() + idle_limit_s
    last_rx = time.monotonic()
    last_progress_size = 0
    sock.settimeout(0.5)

    if trace is not None:
        trace.log("receive_start", total_file_size=total_file_size)

    while True:
        if reassembler.is_complete(total_file_size):
            break
        now = time.monotonic()
        if now > idle_deadline:
            if trace is not None:
                trace.log(
                    "idle_timeout",
                    raw_bytes=len(raw_data),
                    extracted_bytes=extracted_size,
                    covered_bytes=reassembler.covered,
                    expected_bytes=total_file_size,
                    micro_acks_sent=micro_acks_sent,
                    resume_acks=resume_acks,
                    recv_count=recv_count,
                    frame_buffer_len=len(frame_buffer),
                )
            logger.warning(
                "Download idle timeout: contiguous=%d covered=%d/%d acks=%d resumes=%d recv=%d",
                extracted_size,
                reassembler.covered,
                total_file_size,
                micro_acks_sent,
                resume_acks,
                recv_count,
            )
            break

        try:
            chunk = sock.recv(262144)
        except ConnectionResetError as exc:
            if trace is not None:
                trace.log(
                    "connection_reset",
                    raw_bytes=len(raw_data),
                    extracted_bytes=extracted_size,
                    expected_bytes=total_file_size,
                    acked_through=acked_through,
                    micro_acks_sent=micro_acks_sent,
                    resume_acks=resume_acks,
                )
            raise RuntimeError(
                f"Device closed download connection after {extracted_size} contiguous bytes "
                f"(expected {total_file_size}, acked_through={acked_through})"
            ) from exc
        except socket.timeout:
            silent_s = time.monotonic() - last_rx
            if (
                extracted_size > 0
                and total_file_size > 0
                and extracted_size < total_file_size
                and silent_s >= _STALL_RESUME_S
            ):
                # Dead silence well past any TCP retransmit: ask the device to
                # resume from the contiguous prefix. Safe because replayed
                # blocks are written at their absolute offsets.
                _send_download_progress_ack(sock, extracted_size)
                acked_through = extracted_size
                resume_acks += 1
                micro_acks_sent += 1
                # Restart only the silence clock -- NOT idle_deadline, or a dead
                # device would be re-prompted forever instead of timing out.
                last_rx = time.monotonic()
                if trace is not None:
                    trace.log(
                        "resume_ack_sent",
                        silent_s=round(silent_s, 2),
                        ack_payload_bytes=extracted_size,
                        covered_bytes=reassembler.covered,
                        expected_bytes=total_file_size,
                    )
            continue

        if not chunk:
            if trace is not None:
                trace.log("recv_eof", raw_bytes=len(raw_data), extracted_bytes=extracted_size)
            break

        last_rx = time.monotonic()
        recv_count += 1
        raw_data.extend(chunk)
        frame_buffer += chunk
        frame_buffer = _drain_download_frames_incremental(
            frame_buffer, reassembler, trace, total_file_size
        )

        extracted_size = len(reassembler)
        acked_through, batch_sent = _prompt_next_batch(
            sock,
            extracted_size=extracted_size,
            acked_through=acked_through,
            total_file_size=total_file_size,
            trace=trace,
        )
        micro_acks_sent += batch_sent
        if trace is not None and (
            extracted_size > last_progress_size or recv_count == 1 or recv_count % 50 == 0
        ):
            trace.log(
                "recv_chunk",
                chunk_bytes=len(chunk),
                raw_bytes=len(raw_data),
                extracted_bytes=extracted_size,
                frame_buffer_remainder=len(frame_buffer),
                recv_count=recv_count,
            )
        if extracted_size > last_progress_size:
            last_progress_size = extracted_size
            idle_deadline = last_rx + _PROGRESS_IDLE_S
            if trace is not None:
                trace.log(
                    "progress",
                    extracted_bytes=extracted_size,
                    expected_bytes=total_file_size,
                    micro_acks_sent=micro_acks_sent,
                )

    covered = reassembler.covered
    if covered == 0:
        if trace is not None:
            trace.analyze_raw_stream(raw_data, extracted=0, expected=total_file_size)
        raise RuntimeError(f"No data blocks found in {len(raw_data)} bytes of response")

    if reassembler.conflicts and trace is not None:
        trace.log("replay_conflicts", count=reassembler.conflicts)
    if total_file_size > 0 and not reassembler.is_complete(total_file_size):
        if trace is not None:
            trace.analyze_raw_stream(raw_data, extracted=extracted_size, expected=total_file_size)
        trace_hint = f" trace={trace.path}" if trace is not None else ""
        raise RuntimeError(
            f"Incomplete download: contiguous {extracted_size} / covered {covered} bytes, "
            f"expected {total_file_size} (raw={len(raw_data)}, acks={micro_acks_sent}, "
            f"resumes={resume_acks}, recv_chunks={recv_count}){trace_hint}"
        )

    file_data = reassembler.file_data
    if total_file_size > 0 and len(file_data) > total_file_size:
        return bytes(file_data[:total_file_size])
    return bytes(file_data)


def download_aim_session(filename: str, dest_dir: Path, expected_size: int = 0) -> Path:
    """Download one log file over a **dedicated** TCP session (RS3 stream 38 in 116CaptureWireshark.pcapng).

    Session list and live view share the primary hub TCP; downloads do not.
    """
    """Download a single session file from the AiM device via TCP protocol."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / filename

    if out_path.exists():
        local_size = out_path.stat().st_size
        if expected_size > 0 and local_size < expected_size:
            logger.warning(
                "Session %s exists but is incomplete (%d/%d bytes); re-downloading.",
                filename,
                local_size,
                expected_size,
            )
            out_path.unlink()
        else:
            logger.debug("Session %s already exists locally, skipping.", filename)
            return out_path

    filepath = f"1:/mem/{filename}"
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
            total_file_size = struct.unpack_from("<I", info_data, 84 + 12 + 0x10)[0]
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
        file_data = _receive_file_data(s, total_file_size, trace)

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

    out_path.write_bytes(file_data)
    return out_path
