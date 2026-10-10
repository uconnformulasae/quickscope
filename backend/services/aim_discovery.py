"""Shared AiM UDP discovery (port 36002) used by live streaming and session download."""

from __future__ import annotations

import logging
import re
import socket

from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

DISCOVERY_PORT = 36002
DISCOVERY_MAGIC = b"aim-ka"
DATA_PORT = 2000
DEFAULT_DEVICE_IP = "10.0.0.1"

_DEFAULT_DEVICE_IPS = ("10.0.0.1", "192.168.137.1", "192.168.1.1", "192.168.4.1")


def configured_device_ip() -> str:
    return load_settings().get("aim_device_ip", "10.0.0.1")


def candidate_device_ips() -> list[str]:
    """Configured IP first, then common AiM hotspot defaults."""
    candidates = [configured_device_ip()]
    for default_ip in _DEFAULT_DEVICE_IPS:
        if default_ip not in candidates:
            candidates.append(default_ip)
    return candidates


def udp_probe(ip: str, timeout: float = 2.0) -> bytes | None:
    """Send discovery magic to one IP; return reply payload or None."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout)
            sock.sendto(DISCOVERY_MAGIC, (ip, DISCOVERY_PORT))
            data, _addr = sock.recvfrom(4096)
            if data:
                logger.debug("AiM UDP: reply from %s (%d bytes)", ip, len(data))
            return data if data else None
    except socket.timeout:
        logger.debug("AiM UDP: no reply from %s within %.1fs", ip, timeout)
        return None
    except OSError as exc:
        logger.debug("AiM UDP: probe %s failed: %s", ip, exc)
        return None


def broadcast_probe(timeout: float = 2.0) -> tuple[str, bytes] | None:
    """Send discovery magic to the LAN broadcast address; return (sender_ip, reply) or None.

    Unlike ``udp_probe``, this doesn't require guessing the device's IP ahead of
    time — it works whenever the Mac is on the same subnet as the device,
    regardless of what address DHCP handed out. This is what Race Studio does
    for first-time discovery (see docs/protocol/aim-live-protocol.md §2.1).
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.settimeout(timeout)
            sock.sendto(DISCOVERY_MAGIC, ("255.255.255.255", DISCOVERY_PORT))
            data, addr = sock.recvfrom(4096)
            if data:
                logger.info(
                    "AiM UDP broadcast discovery: reply from %s (%d bytes)", addr[0], len(data)
                )
                return addr[0], data
            return None
    except socket.timeout:
        logger.debug("AiM UDP broadcast: no reply within %.1fs", timeout)
        return None
    except OSError as exc:
        logger.debug("AiM UDP broadcast probe failed: %s", exc)
        return None


def probe_device_ips(timeout: float = 2.0) -> tuple[str, bytes] | None:
    """Try UDP discovery across candidate IPs, then fall back to a LAN broadcast.

    Returns (ip, reply) or None.
    """
    candidates = candidate_device_ips()
    for candidate in candidates:
        data = udp_probe(candidate, timeout=timeout)
        if data:
            logger.info("AiM UDP discovery: using %s (%d-byte reply)", candidate, len(data))
            return candidate, data

    broadcast_result = broadcast_probe(timeout=timeout)
    if broadcast_result:
        ip, _data = broadcast_result
        logger.info("AiM UDP discovery: found device at %s via broadcast (not in candidate list)", ip)
        return broadcast_result

    logger.warning("AiM UDP discovery: no reply from %s or broadcast", candidates)
    return None


def parse_discovery_text(ip: str, data: bytes) -> dict:
    """Parse a discovery reply into a loose dict (sessions + live friendly)."""
    info: dict = {
        "ip": ip,
        "ssid": "",
        "device_name": "",
        "model": "",
        "serial": "",
        "vehicle": "",
    }
    try:
        text = data.decode("ascii", errors="replace")
        aim_match = re.search(r"(AiM-[A-Za-z0-9_-]+)", text)
        if aim_match:
            info["ssid"] = aim_match.group(1)
        m = re.search(r"AiM-([A-Za-z0-9_]+)-(\d+)-([^\x00]+)", text)
        if m:
            info["model"] = m.group(1)
            info["serial"] = m.group(2)
            info["vehicle"] = m.group(3).rstrip("\x00").rstrip()
        if len(data) > 0x54:
            raw_name = data[0x14:0x54].split(b"\x00")[0].decode("ascii", errors="replace")
            if raw_name and raw_name.isprintable():
                info["device_name"] = raw_name
    except Exception:
        pass
    return info
