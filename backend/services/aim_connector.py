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
from pathlib import Path

from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

DISCOVERY_PORT = 36002
DATA_PORT = 2000
DISCOVERY_MAGIC = b"aim-ka"

# ── Hardcoded protocol messages (from Wireshark captures of RaceStudio3) ────

_HANDSHAKE = bytes.fromhex(
    "3c685354435008000000003e00000000060800003c535443500e003e"
)
_STNC_SYSTEM = bytes.fromhex(
    "3c6853544e4340000000003e0000000000000000"
    "10000100000000004000000000000000"
    "41000000000000000000000000000000"
    "00000000000000000000000000000000"
    "000000000000000000000000"
    "3c53544e4392003e"
)
_STNC_PREP_SESSIONS = bytes.fromhex(
    "3c6853544e4340000000003e0000000000000000"
    "51000200000000000000000000000000"
    "4100000000000000ffffffff00000000"
    "00000000000000000000000000000000"
    "000000000000000000000000"
    "3c53544e4390043e"
)
_STNC_GET_SESSIONS = bytes.fromhex(
    "3c6853544e4340000000003e0000000000000000"
    "24000200000000000000000000000000"
    "41000000000000000000000000000000"
    "00000000000000000000000000000000"
    "000000000000000000000000"
    "3c53544e4367003e"
)
_ACK = bytes.fromhex(
    "3c685354435004000000003e000000003c5354435000003e"
)


def _get_device_ip() -> str:
    return load_settings().get("aim_device_ip", "10.0.0.1")


# ── Discovery ───────────────────────────────────────────────────────────────

def is_aim_connected() -> bool:
    """Check if an AiM device is reachable via UDP discovery probe."""
    ip = _get_device_ip()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2)
            s.sendto(DISCOVERY_MAGIC, (ip, DISCOVERY_PORT))
            data, addr = s.recvfrom(4096)
            return len(data) > 0
    except (socket.timeout, OSError):
        return False


def discover_device() -> dict | None:
    """Discover AiM device info via UDP broadcast.

    Returns dict with ip, ssid, device_name or None if not found.
    """
    ip = _get_device_ip()

    # Try configured IP first, then common defaults
    candidates = [ip]
    for default_ip in ["10.0.0.1", "192.168.137.1", "192.168.1.1", "192.168.4.1"]:
        if default_ip not in candidates:
            candidates.append(default_ip)

    for candidate in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(2)
                s.sendto(DISCOVERY_MAGIC, (candidate, DISCOVERY_PORT))
                data, addr = s.recvfrom(4096)

            info = {"ip": addr[0], "ssid": "", "device_name": ""}
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

            logger.info("Discovered AiM device at %s: %s", addr[0], info)
            return info
        except (socket.timeout, OSError):
            continue

    return None


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
    ip = _get_device_ip()
    logger.info("Connecting to AiM device at %s:%d for session listing...", ip, DATA_PORT)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.settimeout(10)
            s.connect((ip, DATA_PORT))
            logger.info("Connected to AiM device.")

            all_data = b""

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

    except (ConnectionRefusedError, OSError) as exc:
        logger.error("Failed to connect to AiM device: %s", exc)
        return []

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


def _extract_data_blocks(raw: bytes) -> bytes:
    """Parse STCP data blocks and extract file data.

    Each block: header(12) + [file_offset(u32) + file_data] + trailer(8)
    Blocks are reassembled by file_offset order.
    """
    blocks: list[tuple[int, bytes]] = []
    pos = 0

    while pos < len(raw):
        idx = raw.find(b"<hSTCP", pos)
        if idx == -1:
            break
        if idx + 12 > len(raw):
            break

        payload_size = struct.unpack_from("<I", raw, idx + 6)[0]
        payload_start = idx + 12
        payload_end = payload_start + payload_size

        if payload_end > len(raw):
            available = raw[payload_start:len(raw)]
            if len(available) >= 4:
                file_offset = struct.unpack_from("<I", available, 0)[0]
                blocks.append((file_offset, available[4:]))
            break

        payload = raw[payload_start:payload_end]
        file_offset = struct.unpack_from("<I", payload, 0)[0]
        file_data = payload[4:]
        blocks.append((file_offset, file_data))

        pos = payload_end + 8

    if not blocks:
        return raw

    blocks.sort(key=lambda b: b[0])
    total_size = blocks[-1][0] + len(blocks[-1][1])
    file_data = bytearray(total_size)
    for offset, data in blocks:
        file_data[offset:offset + len(data)] = data

    return bytes(file_data)


def download_aim_session(filename: str, dest_dir: Path) -> Path:
    """Download a single session file from the AiM device via TCP protocol."""
    ip = _get_device_ip()
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / filename

    if out_path.exists():
        logger.debug("Session %s already exists locally, skipping.", filename)
        return out_path

    filepath = f"1:/mem/{filename}"
    logger.info("Downloading %s from %s:%d ...", filepath, ip, DATA_PORT)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.settimeout(30)
        s.connect((ip, DATA_PORT))

        # Step 1: Handshake
        _send_and_recv(s, _HANDSHAKE, "handshake", read_timeout=5)

        # Step 2: File request
        request = _build_download_request(filepath)
        s.sendall(request)

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

        # Extract total file size from second info response
        total_file_size = 0
        if len(info_data) >= 168:
            total_file_size = struct.unpack_from("<I", info_data, 84 + 12 + 0x10)[0]
            logger.info("File size from device: %d bytes", total_file_size)

        # Step 4: ACK triggers data transmission
        s.sendall(_ACK)

        # Step 5: Receive data blocks
        raw_data = b""
        s.settimeout(10)
        while True:
            try:
                chunk = s.recv(8192)
                if not chunk:
                    break
                raw_data += chunk
                s.settimeout(3)
                if total_file_size > 0 and len(raw_data) > total_file_size:
                    break
            except socket.timeout:
                break

        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    if len(raw_data) < 100:
        raise RuntimeError(f"Download failed: received only {len(raw_data)} bytes for {filename}")

    file_data = _extract_data_blocks(raw_data)
    logger.info("Downloaded %s: %d bytes", filename, len(file_data))

    out_path.write_bytes(file_data)
    return out_path
