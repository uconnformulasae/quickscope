"""
In-process ring buffer of recent file uploads.

This exists to make "phone uploads are slow and never show up" debuggable.
Every call to /api/upload records:
  - timestamp, filename, size, duration
  - client IP, user agent
  - status (ok / parse_failed / upload_failed)

The buffer is in-memory only (no disk persistence — restarts wipe it). For
an FSAE pit-side tool that's the right tradeoff: the log is for the current
session's debugging, not historical forensics.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from services.ring_log import RingLog

UploadStatus = Literal["ok", "parse_failed", "upload_failed"]

_log = RingLog(max_entries=100)


def record(
    *,
    filename: str,
    size: int,
    duration_s: float,
    client_ip: str,
    user_agent: str,
    status: UploadStatus,
    error: str | None = None,
) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "filename": filename,
        "size": size,
        "duration_s": round(duration_s, 3),
        "client_ip": client_ip,
        "user_agent": user_agent,
        "status": status,
    }
    if error:
        entry["error"] = error
    _log.append(entry)


def list_recent() -> list[dict]:
    """Newest first."""
    return _log.list_recent()


def clear() -> None:
    _log.clear()
