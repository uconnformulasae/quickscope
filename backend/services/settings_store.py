"""
Settings persistence backed by ./data/settings.json.
"""

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULTS = {
    "railway_url": "",
    "aim_wifi_ssid": "AiM-EVO5-00740-UConn-EV",
    "aim_device_ip": "10.0.0.1",
    "aim_device_port": 2000,
}


def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load() -> dict:
    _ensure_dir()
    if not SETTINGS_FILE.exists():
        save(DEFAULTS)
        return dict(DEFAULTS)
    with open(SETTINGS_FILE, "r") as f:
        stored = json.load(f)
    # Merge with defaults for any missing keys
    merged = {**DEFAULTS, **stored}
    return merged


def save(settings: dict):
    _ensure_dir()
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


def update(partial: dict) -> dict:
    current = load()
    current.update(partial)
    save(current)
    return current
