"""
AiM datalogger connector for QuickScope.

Detects AiM device connectivity by probing its HTTP endpoint directly,
then lists and downloads session files.

Works on any platform (macOS, Windows, Linux) without relying on
OS-specific WiFi SSID detection, which breaks on modern macOS due
to privacy restrictions that redact SSIDs from command output.
"""

import logging
import re
from pathlib import Path

import httpx

from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)


def _get_device_ip() -> str:
    return load_settings().get("aim_device_ip", "10.0.0.1")


def _get_device_port() -> int:
    return load_settings().get("aim_device_port", 2000)


def _get_base_url() -> str:
    ip = _get_device_ip()
    port = _get_device_port()
    return f"http://{ip}:{port}"


def is_aim_connected() -> bool:
    """Check if the AiM device is reachable by probing its HTTP endpoint.

    This is more reliable than SSID detection because:
    - Modern macOS redacts SSIDs in command output (privacy)
    - The airport utility was removed in recent macOS versions
    - It confirms actual device connectivity, not just WiFi network
    """
    base = _get_base_url()
    try:
        # Quick probe — short timeout since AiM is on local network
        with httpx.Client(timeout=3) as client:
            resp = client.get(f"{base}/sessions/")
            return resp.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPError, OSError):
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

    # Parse directory listing — match links to session files
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
