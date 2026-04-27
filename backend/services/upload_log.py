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

import threading
from collections import deque
from datetime import datetime, timezone
from typing import Iterable, Literal

UploadStatus = Literal["ok", "parse_failed", "upload_failed"]

_MAX_ENTRIES = 100
_lock = threading.Lock()
_entries: deque[dict] = deque(maxlen=_MAX_ENTRIES)


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
    with _lock:
        _entries.append(entry)


def list_recent() -> list[dict]:
    with _lock:
        # Newest first
        return list(reversed(_entries))


def clear() -> None:
    with _lock:
        _entries.clear()
