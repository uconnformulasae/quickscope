"""
Local session index backed by a JSON file.

Manages ./data/sessions.json and the ./data/sessions/ file cache.
Thread-safe via a simple lock since QuickScope is single-user.
"""

import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import DATA_DIR
from services.json_store import load_json, save_json

SESSIONS_FILE = DATA_DIR / "sessions.json"
SESSIONS_DIR = DATA_DIR / "sessions"


def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


_lock = threading.Lock()


def _load() -> list[dict]:
    _ensure_dirs()
    # An unreadable index is kept for recovery; start with an empty one.
    return load_json(SESSIONS_FILE, lambda data: isinstance(data, list)) or []


def _save(sessions: list[dict]):
    _ensure_dirs()
    save_json(SESSIONS_FILE, sessions, default=str)


def list_sessions() -> list[dict]:
    with _lock:
        return _load()


def get_session(session_id: str) -> Optional[dict]:
    with _lock:
        for s in _load():
            if s["id"] == session_id:
                return s
    return None


def find_by_filename(filename: str) -> Optional[dict]:
    """The session stored under ``filename``.

    Falls back to a case-insensitive match: Windows and default macOS volumes
    treat ``A.xrk`` and ``a.xrk`` as one file, so they must be one session.
    """
    folded = filename.casefold()
    fallback = None
    with _lock:
        for s in _load():
            if s["filename"] == filename:
                return s
            if fallback is None and s["filename"].casefold() == folded:
                fallback = s
    return fallback


def _new_entry(
    filename: str,
    source: str,
    now: str,
    aim_session_id: Optional[str] = None,
    track_name: str = "",
    driver_name: str = "",
    vehicle_name: str = "",
    recorded_at: Optional[str] = None,
    duration_s: float = 0,
    lap_count: int = 0,
    local_path: Optional[str] = None,
    index_status: Optional[str] = None,
) -> dict:
    entry = {
        "id": str(uuid.uuid4()),
        "aim_session_id": aim_session_id or Path(filename).stem,
        "filename": filename,
        "local_path": local_path,
        "track_name": track_name,
        "driver_name": driver_name,
        "vehicle_name": vehicle_name,
        "recorded_at": recorded_at,
        "duration_s": duration_s,
        "lap_count": lap_count,
        "source": source,
        "created_at": now,
        "updated_at": now,
    }
    if index_status is not None:
        entry["index_status"] = index_status
    return entry


def add_session(filename: str, source: str, **fields) -> dict:
    """Append a new session. ``fields`` are the optional keys of :func:`_new_entry`."""
    entry = _new_entry(filename, source, datetime.now(timezone.utc).isoformat(), **fields)
    with _lock:
        sessions = _load()
        sessions.append(entry)
        _save(sessions)
    return entry


def get_or_add_session(filename: str, source: str, **fields) -> tuple[dict, bool]:
    """The session stored under ``filename``, added (with ``fields``) if absent.

    Returns ``(entry, created)``. Lookup and insert happen under one lock; an
    existing entry is returned as it is. Names match as in
    :func:`find_by_filename`.
    """
    folded = filename.casefold()
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        sessions = _load()
        fallback = None
        for s in sessions:
            if s["filename"] == filename:
                return s, False
            if fallback is None and s["filename"].casefold() == folded:
                fallback = s
        if fallback is not None:
            return fallback, False
        entry = _new_entry(filename, source, now, **fields)
        sessions.append(entry)
        _save(sessions)
    return entry, True


def update_session(session_id: str, **fields) -> Optional[dict]:
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    with _lock:
        sessions = _load()
        for s in sessions:
            if s["id"] == session_id:
                s.update(fields)
                _save(sessions)
                return s
    return None


_LEGACY_KEYS = ("remote_id", "sync_status")


def migrate_legacy_entries() -> dict[str, int]:
    """Clean up sessions.json written by versions that synced with Railway.

    * Entries that only existed remotely (no file on disk) can never be opened
      now that cloud sync is gone, so they are dropped.
    * ``remote_id`` / ``sync_status`` bookkeeping keys are removed.
    * ``source: "railway"`` entries that do have a local file become
      ``manual_upload``.

    Idempotent; returns counts of what changed. Called once at startup.
    """
    pruned = cleaned = 0
    with _lock:
        sessions = _load()
        kept: list[dict] = []
        for s in sessions:
            legacy = s.get("sync_status") == "remote_only" or s.get("source") == "railway"
            if legacy and resolve_session_path(s) is None:
                pruned += 1
                continue
            touched = False
            for key in _LEGACY_KEYS:
                if key in s:
                    del s[key]
                    touched = True
            if s.get("source") == "railway":
                s["source"] = "manual_upload"
                touched = True
            cleaned += touched
            kept.append(s)
        if pruned or cleaned:
            _save(kept)
    return {"pruned": pruned, "cleaned": cleaned}


def delete_session(session_id: str) -> bool:
    with _lock:
        sessions = _load()
        filtered = [s for s in sessions if s["id"] != session_id]
        if len(filtered) == len(sessions):
            return False
        _save(filtered)
    return True


def session_file_path(filename: str) -> Path:
    _ensure_dirs()
    safe_name = Path(filename).name
    if not safe_name:
        raise ValueError("Invalid filename")
    resolved = (SESSIONS_DIR / safe_name).resolve()
    if not resolved.is_relative_to(SESSIONS_DIR.resolve()):
        raise ValueError("Invalid filename")
    return resolved


def resolve_session_path(entry: dict) -> Optional[Path]:
    """Return the on-disk session file, if present.

    Stored ``local_path`` values may be stale absolute paths from another OS
    (e.g. Windows paths when running in Docker/Linux). Fall back to the
    canonical file under the current ``SESSIONS_DIR``.
    """
    filename = entry.get("filename")
    if not filename:
        return None

    stored = entry.get("local_path")
    if stored:
        stored_path = Path(stored)
        if stored_path.is_file():
            return stored_path

    try:
        canonical = session_file_path(filename)
    except ValueError:
        return None

    if canonical.is_file():
        return canonical

    return None


def repair_session_path(session_id: str, entry: dict) -> Optional[Path]:
    """Like :func:`resolve_session_path`, but rewrite stale ``local_path`` in the index."""
    path = resolve_session_path(entry)
    if path is None:
        return None

    canonical = str(path)
    if entry.get("local_path") != canonical:
        update_session(session_id, local_path=canonical)
    return path
