"""
Settings persistence backed by ./data/settings.json.
"""

import json
import os
import threading
from pathlib import Path

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULTS = {
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
        try:
            with open(SETTINGS_FILE, "r") as f:
                stored = json.load(f)
            if not isinstance(stored, dict):
                raise ValueError("settings file is not a JSON object")
        except (ValueError, UnicodeDecodeError):  # JSONDecodeError is a ValueError
            # Keep the unreadable file for recovery and fall back to defaults.
            try:
                os.replace(SETTINGS_FILE, SETTINGS_FILE.with_suffix(SETTINGS_FILE.suffix + ".corrupt"))
            except OSError:
                pass
            _save_unlocked(DEFAULTS)
            return dict(DEFAULTS)
        known = {k: v for k, v in stored.items() if k in ALLOWED_KEYS}
        if len(known) != len(stored):
            # Drop keys from older versions (e.g. railway_url) so they stop round-tripping.
            _save_unlocked({**DEFAULTS, **known})
        return {**DEFAULTS, **known}


def _save_unlocked(settings: dict):
    _ensure_dir()
    tmp = SETTINGS_FILE.with_suffix(SETTINGS_FILE.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
    os.replace(tmp, SETTINGS_FILE)  # atomic: a crash mid-write can't leave a truncated file


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
            current = {**DEFAULTS, **{k: v for k, v in current.items() if k in ALLOWED_KEYS}}
        else:
            current = dict(DEFAULTS)
        current.update(filtered)
        _save_unlocked(current)
        return current
