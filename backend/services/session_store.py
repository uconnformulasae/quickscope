"""
Local session index backed by a JSON file.

Manages ./data/sessions.json and the ./data/sessions/ file cache.
Thread-safe via a simple lock since QuickScope is single-user.
"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
SESSIONS_FILE = DATA_DIR / "sessions.json"
SESSIONS_DIR = DATA_DIR / "sessions"


def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


_lock = threading.Lock()


def _quarantine(path: Path) -> None:
    try:
        os.replace(path, path.with_suffix(path.suffix + ".corrupt"))
    except OSError:
        pass


def _load() -> list[dict]:
    _ensure_dirs()
    if not SESSIONS_FILE.exists():
        return []
    try:
        with open(SESSIONS_FILE, "r") as f:
            sessions = json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Keep the unreadable file for recovery and start with an empty index.
        _quarantine(SESSIONS_FILE)
        return []
    return sessions if isinstance(sessions, list) else []


def _save(sessions: list[dict]):
    _ensure_dirs()
    tmp = SESSIONS_FILE.with_suffix(SESSIONS_FILE.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(sessions, f, indent=2, default=str)
    os.replace(tmp, SESSIONS_FILE)  # atomic: a crash mid-write can't leave a truncated file


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
    with _lock:
        for s in _load():
            if s["filename"] == filename:
                return s
    return None


def find_by_aim_session_id(aim_session_id: str) -> Optional[dict]:
    with _lock:
        for s in _load():
            if s.get("aim_session_id") == aim_session_id:
                return s
    return None


def add_session(
    filename: str,
    source: str,
    aim_session_id: Optional[str] = None,
    track_name: str = "",
    driver_name: str = "",
    vehicle_name: str = "",
    recorded_at: Optional[str] = None,
    duration_s: float = 0,
    lap_count: int = 0,
    local_path: Optional[str] = None,
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
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
    with _lock:
        sessions = _load()
        sessions.append(entry)
        _save(sessions)
    return entry


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
