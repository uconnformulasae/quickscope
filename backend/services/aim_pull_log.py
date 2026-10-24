"""
In-process ring buffer of recent AiM device list/pull attempts.

Mirrors upload_log.py — makes "did the AIM pull actually work?" debuggable
without digging through backend terminal logs.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from services.ring_log import RingLog

AimPullStatus = Literal[
    "ok",
    "download_failed",
    "parse_failed",
    "list_failed",
    "list_ok",
]

_log = RingLog(max_entries=100)


def record(
    *,
    action: Literal["list", "pull"],
    status: AimPullStatus,
    device_ip: str = "",
    filename: str | None = None,
    size: int = 0,
    duration_s: float = 0,
    session_id: str | None = None,
    session_count: int | None = None,
    error: str | None = None,
) -> None:
    entry: dict = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "status": status,
        "device_ip": device_ip,
        "size": size,
        "duration_s": round(duration_s, 3),
    }
    if filename:
        entry["filename"] = filename
    if session_id:
        entry["session_id"] = session_id
    if session_count is not None:
        entry["session_count"] = session_count
    if error:
        entry["error"] = error
    _log.append(entry)


def list_recent() -> list[dict]:
    """Newest first."""
    return _log.list_recent()


def clear() -> None:
    _log.clear()
