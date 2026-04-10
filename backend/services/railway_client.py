"""
HTTP client for Data-Development's Railway API.

Handles listing remote sessions, downloading session files,
and uploading local sessions.
"""

import logging
from pathlib import Path

import httpx

from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

TIMEOUT_DEFAULT = 15
TIMEOUT_DOWNLOAD = 120
TIMEOUT_UPLOAD = 120


def _base_url() -> str:
    settings = load_settings()
    url = settings.get("railway_url", "").rstrip("/")
    if not url:
        raise ValueError("Railway URL not configured. Set it in Settings.")
    return url


async def list_remote_sessions(skip: int = 0, limit: int = 200) -> list[dict]:
    """Fetch session list from Data-Development API."""
    base = _base_url()
    async with httpx.AsyncClient(timeout=TIMEOUT_DEFAULT) as client:
        resp = await client.get(f"{base}/sessions/", params={"skip": skip, "limit": limit})
        resp.raise_for_status()
        return resp.json()


async def get_remote_session(session_id: int) -> dict:
    """Fetch a single session's details."""
    base = _base_url()
    async with httpx.AsyncClient(timeout=TIMEOUT_DEFAULT) as client:
        resp = await client.get(f"{base}/sessions/{session_id}")
        resp.raise_for_status()
        return resp.json()


async def download_session_file(remote_id: int, dest_path: Path) -> Path:
    """Download a raw session file from Railway."""
    base = _base_url()
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=TIMEOUT_DOWNLOAD) as client:
        async with client.stream("GET", f"{base}/sessions/{remote_id}/download") as resp:
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    f.write(chunk)

    logger.info("Downloaded session %d → %s", remote_id, dest_path)
    return dest_path


async def upload_session_file(file_path: Path) -> dict:
    """Upload a local session file to Railway."""
    base = _base_url()

    async with httpx.AsyncClient(timeout=TIMEOUT_UPLOAD) as client:
        with open(file_path, "rb") as f:
            files = {"files": (file_path.name, f, "application/octet-stream")}
            resp = await client.post(f"{base}/sessions/upload", files=files)
            resp.raise_for_status()
            return resp.json()
