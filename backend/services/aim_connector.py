"""
AiM datalogger connector for QuickScope.

Cross-platform WiFi detection and session download from AiM devices.
Supports macOS (airport/networksetup) and Windows (netsh).

Adapted from Data-Development's aim_connector.py.
"""

import logging
import re
import subprocess
from pathlib import Path

import httpx

from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)


def _get_ssid() -> str:
    return load_settings().get("aim_wifi_ssid", "")


def _get_device_ip() -> str:
    return load_settings().get("aim_device_ip", "10.0.0.1")


def _get_device_port() -> int:
    return load_settings().get("aim_device_port", 2000)


def _get_base_url() -> str:
    ip = _get_device_ip()
    port = _get_device_port()
    return f"http://{ip}:{port}"


def is_aim_connected() -> bool:
    """Check if currently connected to the AiM WiFi hotspot."""
    ssid = _get_ssid()
    if not ssid:
        return False

    # macOS
    try:
        result = subprocess.run(
            ["networksetup", "-getairportnetwork", "en0"],
            capture_output=True, text=True, timeout=5,
        )
        if ssid in result.stdout:
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # macOS fallback (airport utility)
    try:
        result = subprocess.run(
            ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            if "SSID" in line and ssid in line:
                return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Windows
    try:
        result = subprocess.run(
            ["netsh", "wlan", "show", "interfaces"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            if "SSID" in line and ssid in line:
                return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return False


async def list_aim_sessions() -> list[dict]:
    """List sessions available on the AiM device via HTTP directory listing."""
    base = _get_base_url()
    sessions = []

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(f"{base}/sessions/")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("Could not reach AiM device at %s: %s", base, exc)
            return sessions

    # Parse Apache-style directory listing
    for match in re.finditer(
        r'href="([^"]+\.(?:xdrk|drk|xrk|xrz))"',
        resp.text,
        re.IGNORECASE,
    ):
        filename = match.group(1).lstrip("/")
        sessions.append({"filename": filename, "url": f"{base}/sessions/{filename}"})

    return sessions


async def download_aim_session(filename: str, dest_dir: Path) -> Path:
    """Download a single session file from the AiM device."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / filename

    if out_path.exists():
        logger.debug("Session %s already downloaded, skipping.", filename)
        return out_path

    url = f"{_get_base_url()}/sessions/{filename}"
    logger.info("Downloading %s from AiM device...", filename)

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(out_path, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    f.write(chunk)

    logger.info("Downloaded %s → %s", filename, out_path)
    return out_path
