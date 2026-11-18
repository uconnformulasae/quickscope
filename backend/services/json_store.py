"""Shared persistence for the small JSON files under the data dir.

Every store (sessions, settings, live layouts, live channels) needs the same
two guarantees: a crash mid-write can't leave a truncated file, and a file
that can't be read is kept for recovery instead of being silently overwritten.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path


def quarantine(path: Path) -> None:
    """Move an unreadable file aside as ``<name>.<utc stamp>.corrupt``."""
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        os.replace(path, path.with_name(f"{path.name}.{stamp}.corrupt"))
    except OSError:
        pass


def load_json(path: Path, is_valid: Callable[[object], bool]) -> object | None:
    """Parsed contents of ``path``, or ``None`` when it is missing or unusable.

    A file that is not JSON, not UTF-8, or fails ``is_valid`` is quarantined.
    """
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not is_valid(data):
            raise ValueError(f"{path.name} has the wrong shape")
    except (ValueError, UnicodeDecodeError):  # JSONDecodeError is a ValueError
        quarantine(path)
        return None
    return data


def save_json(path: Path, data: object, *, default: Callable[[object], object] | None = None) -> None:
    """Write ``data`` to ``path`` atomically (temp file, fsync, rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=default)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
