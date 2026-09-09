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

from services.aim_download_trace import AimDownloadTrace
from services.aim_live import decode_frame, encode_frame
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

DISCOVERY_PORT = 36002
DATA_PORT = 2000
DISCOVERY_MAGIC = b"aim-ka"

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
_BATCH_DUP_SAMPLE = 4096
_BATCH_BOUNDARY_MIN_OFFSET = 32_744
_BATCH_PAYLOAD_BYTES = 982_320


def _is_first_batch_retransmit(file_data: bytes, file_offset: int, data: bytes) -> bool:
    """True when a post-boundary block repeats bytes from the first ~982 KB batch."""
    if len(file_data) < _BATCH_BOUNDARY_MIN_OFFSET:
        return False
    end = file_offset + len(data)
    if end > _BATCH_PAYLOAD_BYTES:
        return False
    return file_data[file_offset:end] == data


def _detect_duplicate_batch_content(file_data: bytes) -> bool:
    """True when reassembly contains repeated first-batch content or zero gaps."""
    if len(file_data) < _BATCH_DUP_SAMPLE * 2:
        return False
    sample = _BATCH_DUP_SAMPLE
    period = _BATCH_PAYLOAD_BYTES
    if len(file_data) >= period + sample:
        if file_data[:sample] == file_data[period:period + sample]:
            return True
        gap = file_data[period:period + sample]
        if gap == b"\x00" * len(gap):
            return True
    for segment in (2, 4, 6):
        offset = segment * period
        if offset + sample <= len(file_data):
            if file_data[:sample] == file_data[offset:offset + sample]:
                return True
    return False


_DEFAULT_DEVICE_IPS = ("10.0.0.1", "192.168.137.1", "192.168.1.1", "192.168.4.1")


def _get_device_ip() -> str:
    return load_settings().get("aim_device_ip", "10.0.0.1")


def _get_data_port() -> int:
    return int(load_settings().get("aim_device_port", DATA_PORT))


def _candidate_ips() -> list[str]:
    """Configured IP first, then common AiM hotspot defaults."""
    candidates = [_get_device_ip()]
    for default_ip in _DEFAULT_DEVICE_IPS:
        if default_ip not in candidates:
            candidates.append(default_ip)
    return candidates


def _udp_probe(ip: str, timeout: float = 2.0) -> bytes | None:
    """Send discovery magic to one IP; return reply payload or None."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(DISCOVERY_MAGIC, (ip, DISCOVERY_PORT))
            data, _addr = s.recvfrom(4096)
            return data if data else None
    except (socket.timeout, OSError):
        return None


def _probe_device_ips() -> tuple[str, bytes] | None:
    """Try UDP discovery across candidate IPs. Returns (ip, reply) or None."""
    for candidate in _candidate_ips():
        data = _udp_probe(candidate)
        if data:
            return candidate, data
    return None


def _parse_discovery_reply(ip: str, data: bytes) -> dict:
    info = {"ip": ip, "ssid": "", "device_name": ""}
    try:
        text = data.decode("ascii", errors="replace")
        aim_match = re.search(r"(AiM-[A-Za-z0-9_-]+)", text)
        if aim_match:
            info["ssid"] = aim_match.group(1)
        if len(data) > 0x54:
            raw_name = data[0x14:0x54].split(b"\x00")[0].decode("ascii", errors="replace")
            if raw_name and raw_name.isprintable():
                info["device_name"] = raw_name
    except Exception:
        pass
    return info


def _open_device_socket(timeout: float = 10) -> tuple[socket.socket, str]:
    """Open TCP to the first reachable AiM device IP.

    Windows cannot reuse a socket after a failed connect() — each candidate
    gets a fresh socket (WinError 10022 otherwise).
    """
    port = _get_data_port()
    last_exc: OSError | None = None
    for ip in _candidate_ips():
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.settimeout(timeout)
            sock.connect((ip, port))
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
    return _probe_device_ips() is not None


def discover_device() -> dict | None:
    """Discover AiM device info via UDP broadcast.

    Returns dict with ip, ssid, device_name or None if not found.
    """
    probed = _probe_device_ips()
    if not probed:
        return None

    ip, data = probed
    info = _parse_discovery_reply(ip, data)
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
                    break
    except socket.timeout:
        pass

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


# ── Session listing ──────────────────────────────────────────────────────────

def list_aim_sessions() -> list[dict]:
    """Connect to AiM device and retrieve session listing via TCP protocol.

    Uses the 7-message handshake sequence. Each message must be a separate
    TCP write — the device firmware won't process batched commands.
    """
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
            pass

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


def _is_stcp_file_payload(payload: bytes) -> bool:
    """True when payload is file data (u32 offset + bytes), not a control frame."""
    if len(payload) <= 4:
        return False
    if (
        len(payload) == 64
        and payload[_STCP_Q_ACK_OPCODE_OFFSET] == _STCP_Q_ACK_OPCODE
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


def _extract_data_blocks(raw: bytes, expected_size: int = 0) -> bytes:
    """Parse STCP data blocks and reassemble the file.

    The device sends the file in batches. Each batch uses file offsets
    relative to zero; when a new batch starts the offset resets even though
    TCP data continues. Append batches sequentially instead of sorting by
    absolute offset (which silently overwrites the first ~982 KB).
    """
    blocks = _iter_file_blocks(raw)
    if not blocks:
        raise RuntimeError(f"No data blocks found in {len(raw)} bytes of response")

    file_data = bytearray()
    batch_base = 0
    prev_offset = -1

    for file_offset, data in blocks:
        if _is_first_batch_retransmit(file_data, file_offset, data):
            continue
        if file_data and file_offset < prev_offset:
            batch_base = len(file_data)
        abs_offset = batch_base + file_offset
        if (
            abs_offset + len(data) <= len(file_data)
            and file_data[abs_offset:abs_offset + len(data)] == data
        ):
            prev_offset = max(prev_offset, file_offset + len(data) - 1)
            continue
        needed = abs_offset + len(data)
        if needed > len(file_data):
            file_data.extend(b"\x00" * (needed - len(file_data)))
        file_data[abs_offset:abs_offset + len(data)] = data
        prev_offset = file_offset

    if expected_size > 0 and len(file_data) > expected_size:
        return bytes(file_data[:expected_size])
    return bytes(file_data)


def _try_extract_file_size(raw: bytes) -> int:
    """Return reassembled file byte length from STCP blocks, or 0 if none yet."""
    try:
        return len(_extract_data_blocks(raw))
    except RuntimeError:
        return 0


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
    trace: AimDownloadTrace | None,
) -> tuple[int, int]:
    """Send one progress ACK each time unique extracted size completes another batch."""
    sent = 0
    while extracted_size >= acked_through + _BATCH_PAYLOAD_BYTES:
        acked_through += _BATCH_PAYLOAD_BYTES
        _send_download_progress_ack(sock, acked_through)
        sent += 1
        if trace is not None:
            trace.log(
                "batch_complete_ack",
                extracted_bytes=extracted_size,
                acked_through=acked_through,
                ack_payload_bytes=acked_through,
            )
    return acked_through, sent


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


def _send_stall_ack(
    sock: socket.socket,
    *,
    extracted_size: int,
    last_stall_ack_bytes: int | None,
    trace: AimDownloadTrace | None,
) -> tuple[str, int | None, bool]:
    """Prompt device after transfer pauses mid-file using a progress-encoded ACK."""
    ack_payload = extracted_size
    if last_stall_ack_bytes == ack_payload:
        if trace is not None:
            trace.log("stall_ack_skipped", ack_payload_bytes=ack_payload)
        return "skipped", last_stall_ack_bytes, False
    _send_download_progress_ack(sock, ack_payload)
    if trace is not None:
        trace.log(
            "stall_ack_sent",
            kind="progress_ack",
            ack_payload_bytes=ack_payload,
        )
    return "progress_ack", ack_payload, True


def _receive_file_data(
    sock: socket.socket,
    total_file_size: int,
    trace: AimDownloadTrace | None = None,
) -> bytes:
    """Read STCP file blocks until complete, prompting device between batches."""
    raw_data = b""
    frame_buffer = b""
    extracted_size = 0
    micro_acks_sent = 0
    stall_ack_round = 0
    last_stall_ack_bytes: int | None = None
    recv_count = 0
    acked_through = 0
    idle_limit_s = 60 + max(0, total_file_size // 100_000)
    idle_deadline = time.monotonic() + idle_limit_s
    last_progress_size = 0
    sock.settimeout(2.0)

    if trace is not None:
        trace.log("receive_start", total_file_size=total_file_size)

    while True:
        if total_file_size > 0 and extracted_size >= total_file_size:
            break
        if time.monotonic() > idle_deadline:
            if trace is not None:
                trace.log(
                    "idle_timeout",
                    raw_bytes=len(raw_data),
                    extracted_bytes=extracted_size,
                    expected_bytes=total_file_size,
                    micro_acks_sent=micro_acks_sent,
                    stall_ack_round=stall_ack_round,
                    recv_count=recv_count,
                    frame_buffer_len=len(frame_buffer),
                )
            logger.warning(
                "Download idle timeout: raw=%d extracted=%d/%d micro_acks_sent=%d stall_acks=%d recv=%d",
                len(raw_data),
                extracted_size,
                total_file_size,
                micro_acks_sent,
                stall_ack_round,
                recv_count,
            )
            break

        try:
            chunk = sock.recv(65536)
        except ConnectionResetError as exc:
            if trace is not None:
                trace.log(
                    "connection_reset",
                    raw_bytes=len(raw_data),
                    extracted_bytes=extracted_size,
                    expected_bytes=total_file_size,
                    acked_through=acked_through,
                    micro_acks_sent=micro_acks_sent,
                    stall_ack_round=stall_ack_round,
                )
            raise RuntimeError(
                f"Device closed download connection after {extracted_size} unique bytes "
                f"(expected {total_file_size}, acked_through={acked_through})"
            ) from exc
        except socket.timeout:
            if total_file_size > 0 and extracted_size >= total_file_size:
                break
            if extracted_size > 0 and extracted_size < total_file_size:
                kind, last_stall_ack_bytes, sent_stall = _send_stall_ack(
                    sock,
                    extracted_size=extracted_size,
                    last_stall_ack_bytes=last_stall_ack_bytes,
                    trace=trace,
                )
                stall_ack_round += 1
                if sent_stall:
                    micro_acks_sent += 1
                idle_deadline = time.monotonic() + 15
                if trace is not None:
                    trace.log(
                        "recv_timeout",
                        extracted_bytes=extracted_size,
                        expected_bytes=total_file_size,
                        ack_kind=kind,
                        ack_payload_bytes=last_stall_ack_bytes,
                    )
            continue

        if not chunk:
            if trace is not None:
                trace.log("recv_eof", raw_bytes=len(raw_data), extracted_bytes=extracted_size)
            break

        recv_count += 1
        raw_data += chunk
        frame_buffer += chunk
        frame_buffer, sent = _drain_download_frames(
            sock, frame_buffer, trace, reply_to_control=False
        )
        micro_acks_sent += sent

        extracted_size = _try_extract_file_size(raw_data)
        acked_through, batch_sent = _prompt_next_batch(
            sock,
            extracted_size=extracted_size,
            acked_through=acked_through,
            trace=trace,
        )
        micro_acks_sent += batch_sent
        if trace is not None and (
            extracted_size > last_progress_size
            or recv_count == 1
            or recv_count % 50 == 0
        ):
            trace.log(
                "recv_chunk",
                chunk_bytes=len(chunk),
                raw_bytes=len(raw_data),
                extracted_bytes=extracted_size,
                micro_acks_this_chunk=sent,
                frame_buffer_remainder=len(frame_buffer),
                recv_count=recv_count,
            )
        if extracted_size > last_progress_size:
            last_progress_size = extracted_size
            idle_deadline = time.monotonic() + 15
            if trace is not None:
                trace.log(
                    "progress",
                    extracted_bytes=extracted_size,
                    expected_bytes=total_file_size,
                    micro_acks_sent=micro_acks_sent,
                )
        elif sent > 0:
            idle_deadline = time.monotonic() + 15

        if total_file_size > 0 and extracted_size >= total_file_size:
            break

    if extracted_size == 0:
        if trace is not None:
            trace.analyze_raw_stream(raw_data, extracted=0, expected=total_file_size)
        raise RuntimeError(f"No data blocks found in {len(raw_data)} bytes of response")

    file_data = _extract_data_blocks(raw_data, expected_size=total_file_size)
    if _detect_duplicate_batch_content(file_data):
        if trace is not None:
            trace.analyze_raw_stream(
                raw_data,
                extracted=len(file_data),
                expected=total_file_size,
            )
        trace_hint = f" trace={trace.path}" if trace is not None else ""
        raise RuntimeError(
            "Download contains duplicate batch data (device re-sent the same "
            f"~982 KB chunk instead of the next segment). Got {len(file_data)} "
            f"bytes unique payload before repeats{trace_hint}"
        )
    if total_file_size > 0 and len(file_data) < total_file_size:
        if trace is not None:
            trace.analyze_raw_stream(
                raw_data,
                extracted=len(file_data),
                expected=total_file_size,
            )
        trace_hint = f" trace={trace.path}" if trace is not None else ""
        raise RuntimeError(
            f"Incomplete download: got {len(file_data)} bytes, expected {total_file_size} bytes "
            f"(raw={len(raw_data)}, micro_acks_sent={micro_acks_sent}, "
            f"stall_acks={stall_ack_round}, recv_chunks={recv_count}){trace_hint}"
        )
    return file_data


def download_aim_session(filename: str, dest_dir: Path, expected_size: int = 0) -> Path:
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
        _send_and_recv(s, _HANDSHAKE, "handshake", read_timeout=5)
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
