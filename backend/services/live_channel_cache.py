"""
Channels each car has actually sent over the live stream, persisted in
./data/live_channels.json so the dashboard editor can offer them while the
laptop is offline.

The list per vehicle only grows: a channel missing from one session (e.g.
the IC ECU block while the ECU is unpowered) is still a valid pick. The
file is written only when a session sees a channel the cache didn't have.
"""

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
CHANNELS_FILE = DATA_DIR / "live_channels.json"

VEHICLES = ("ev", "ic")

_lock = threading.Lock()

# Mirrors vehicleKind() in client/src/components/live/live-channels.ts.
_IC_RE = re.compile(r"(^|[^a-z])ic([^a-z]|$)", re.IGNORECASE)


def vehicle_kind(vehicle: str | None) -> str:
    return "ic" if _IC_RE.search(vehicle or "") else "ev"


def _load_unlocked() -> dict:
    if not CHANNELS_FILE.exists():
        return {}
    try:
        with open(CHANNELS_FILE, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("live channels file is not a JSON object")
    except (ValueError, UnicodeDecodeError):
        try:
            os.replace(CHANNELS_FILE, CHANNELS_FILE.with_name(f"{CHANNELS_FILE.name}.{int(time.time())}.corrupt"))
        except OSError:
            pass
        return {}
    return {
        k: v for k, v in data.items()
        if k in VEHICLES and isinstance(v, dict) and isinstance(v.get("channels"), list)
    }


def _save_unlocked(data: dict) -> None:
    CHANNELS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CHANNELS_FILE.with_suffix(CHANNELS_FILE.suffix + f".{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CHANNELS_FILE)


def get(kind: str) -> dict:
    with _lock:
        entry = _load_unlocked().get(kind)
    if entry is None:
        return {"vehicle_kind": kind, "vehicle": None, "serial": None, "seen_at": None, "channels": []}
    return {"vehicle_kind": kind, **entry}


def record(vehicle: str | None, serial: str | None, names) -> bool:
    """Merge channel names seen for this car. Returns True if the file was written."""
    kind = vehicle_kind(vehicle)
    names = {n for n in names if isinstance(n, str) and n}
    with _lock:
        data = _load_unlocked()
        entry = data.get(kind) or {"channels": []}
        known = set(entry["channels"])
        if names <= known:
            return False
        data[kind] = {
            "vehicle": vehicle or entry.get("vehicle"),
            "serial": serial or entry.get("serial"),
            "seen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "channels": sorted(known | names),
        }
        _save_unlocked(data)
        return True
