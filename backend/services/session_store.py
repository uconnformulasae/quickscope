"""
Local session index backed by a JSON file.

Manages ./data/sessions.json and the ./data/sessions/ file cache.
Thread-safe via a simple lock since QuickScope is single-user.
"""

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SESSIONS_FILE = DATA_DIR / "sessions.json"
SESSIONS_DIR = DATA_DIR / "sessions"


def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


_lock = threading.Lock()


def _load() -> list[dict]:
    _ensure_dirs()
    if not SESSIONS_FILE.exists():
        return []
    with open(SESSIONS_FILE, "r") as f:
        return json.load(f)


def _save(sessions: list[dict]):
    _ensure_dirs()
    with open(SESSIONS_FILE, "w") as f:
        json.dump(sessions, f, indent=2, default=str)


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


def find_by_remote_id(remote_id: int) -> Optional[dict]:
    with _lock:
        for s in _load():
            if s.get("remote_id") == remote_id:
                return s
    return None


def add_session(
    filename: str,
    source: str,
    sync_status: str = "local_only",
    remote_id: Optional[int] = None,
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
        "remote_id": remote_id,
        "aim_session_id": aim_session_id or Path(filename).stem,
        "filename": filename,
        "local_path": local_path,
        "track_name": track_name,
        "driver_name": driver_name,
        "vehicle_name": vehicle_name,
        "recorded_at": recorded_at,
        "duration_s": duration_s,
        "lap_count": lap_count,
        "sync_status": sync_status,
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
