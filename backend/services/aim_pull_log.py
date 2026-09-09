"""
In-process ring buffer of recent AiM device list/pull attempts.

Mirrors upload_log.py — makes "did the AIM pull actually work?" debuggable
without digging through backend terminal logs.
"""

from __future__ import annotations

import threading
from collections import deque
from datetime import datetime, timezone
from typing import Literal

AimPullStatus = Literal[
    "ok",
    "download_failed",
    "parse_failed",
    "list_failed",
    "list_ok",
]

_MAX_ENTRIES = 100
_lock = threading.Lock()
_entries: deque[dict] = deque(maxlen=_MAX_ENTRIES)


def record(
    *,
    action: Literal["list", "pull"],
    status: AimPullStatus,
    device_ip: str = "",
    filename: str | None = None,
    size: int = 0,
    duration_s: float = 0,
    session_id: str | None = None,
    railway_queued: bool = False,
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
        "railway_queued": railway_queued,
    }
    if filename:
        entry["filename"] = filename
    if session_id:
        entry["session_id"] = session_id
    if session_count is not None:
        entry["session_count"] = session_count
    if error:
        entry["error"] = error
    with _lock:
        _entries.append(entry)


def list_recent() -> list[dict]:
    with _lock:
        return list(reversed(_entries))


def clear() -> None:
    with _lock:
        _entries.clear()
