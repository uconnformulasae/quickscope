"""
Settings persistence backed by ./data/settings.json.
"""

import json
import threading
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULTS = {
    "railway_url": "",
    "aim_wifi_ssid": "AiM-EVO5-00740-UConn-EV",
    "aim_device_ip": "10.0.0.1",
    "aim_device_port": 2000,
}

ALLOWED_KEYS = frozenset(DEFAULTS.keys())

_lock = threading.Lock()


def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load() -> dict:
    with _lock:
        _ensure_dir()
        if not SETTINGS_FILE.exists():
            _save_unlocked(DEFAULTS)
            return dict(DEFAULTS)
        with open(SETTINGS_FILE, "r") as f:
            stored = json.load(f)
        return {**DEFAULTS, **stored}


def _save_unlocked(settings: dict):
    _ensure_dir()
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


def save(settings: dict):
    with _lock:
        _save_unlocked(settings)


def update(partial: dict) -> dict:
    # Only allow known keys
    filtered = {k: v for k, v in partial.items() if k in ALLOWED_KEYS}
    with _lock:
        _ensure_dir()
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r") as f:
                current = json.load(f)
            current = {**DEFAULTS, **current}
        else:
            current = dict(DEFAULTS)
        current.update(filtered)
        _save_unlocked(current)
        return current
