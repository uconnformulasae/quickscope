"""
Channels each car has actually sent over the live stream, persisted in
./data/live_channels.json so the dashboard editor can offer them while the
laptop is offline.

The list per vehicle only grows: a channel missing from one session (e.g.
the IC ECU block while the ECU is unpowered) is still a valid pick. The
file is written only when a session sees a channel the cache didn't have.
"""

import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from config import DATA_DIR
from services.json_store import load_json, save_json

CHANNELS_FILE = DATA_DIR / "live_channels.json"

VEHICLES = ("ev", "ic")

_lock = threading.Lock()

# Mirrors vehicleKind() in client/src/components/live/live-channels.ts.
_IC_RE = re.compile(r"(^|[^a-z])ic([^a-z]|$)", re.IGNORECASE)


def vehicle_kind(vehicle: str | None) -> str:
    return "ic" if _IC_RE.search(vehicle or "") else "ev"


def _load_unlocked() -> dict:
    data = load_json(CHANNELS_FILE, lambda d: isinstance(d, dict))
    if data is None:
        return {}
    return {
        k: v for k, v in data.items()
        if k in VEHICLES and isinstance(v, dict) and isinstance(v.get("channels"), list)
    }


def _save_unlocked(data: dict) -> None:
    save_json(CHANNELS_FILE, data)


def get(kind: str) -> dict:
    with _lock:
        entry = _load_unlocked().get(kind)
    if entry is None:
        return {"vehicle_kind": kind, "vehicle": None, "serial": None, "seen_at": None, "channels": [], "units": {}}
    return {"vehicle_kind": kind, "units": {}, **entry}


def record(vehicle: str | None, serial: str | None, names, units: dict | None = None) -> bool:
    """Merge channel names (and their logger units) seen for this car.

    Returns True if the file was written.
    """
    kind = vehicle_kind(vehicle)
    names = {n for n in names if isinstance(n, str) and n}
    units = {k: v for k, v in (units or {}).items() if isinstance(k, str) and isinstance(v, str)}
    with _lock:
        data = _load_unlocked()
        entry = data.get(kind) or {"channels": []}
        known = set(entry["channels"])
        known_units = entry.get("units") if isinstance(entry.get("units"), dict) else {}
        merged_units = {**known_units, **units}
        if names <= known and merged_units == known_units:
            return False
        data[kind] = {
            "vehicle": vehicle or entry.get("vehicle"),
            "serial": serial or entry.get("serial"),
            "seen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "channels": sorted(known | names),
            "units": dict(sorted(merged_units.items())),
        }
        _save_unlocked(data)
        return True
