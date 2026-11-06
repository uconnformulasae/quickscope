"""
Settings persistence backed by ./data/settings.json.
"""

import json
import os
import threading
import time
from pathlib import Path

from sanitize import InvalidInput, validate_device_ip, validate_device_port, validate_wifi_ssid

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULTS = {
    "aim_wifi_ssid": "AiM-EVO5-00740-UConn-EV",
    "aim_device_ip": "10.0.0.1",
    "aim_device_port": 2000,
}

ALLOWED_KEYS = frozenset(DEFAULTS.keys())

# Every setting feeds the AiM socket code, so each one is validated on the way
# in (PUT) and on the way out of a possibly hand-edited settings.json.
_VALIDATORS = {
    "aim_wifi_ssid": validate_wifi_ssid,
    "aim_device_ip": validate_device_ip,
    "aim_device_port": validate_device_port,
}
assert set(_VALIDATORS) == ALLOWED_KEYS


class SettingsError(InvalidInput):
    """A setting value was rejected; the message is user-visible."""

_lock = threading.Lock()


def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load() -> dict:
    with _lock:
        return _load_unlocked()


def _load_unlocked() -> dict:
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
            ts = int(time.time())
            os.replace(SETTINGS_FILE, SETTINGS_FILE.with_name(f"{SETTINGS_FILE.name}.{ts}.corrupt"))
        except OSError:
            pass
        _save_unlocked(DEFAULTS)
        return dict(DEFAULTS)
    known = {}
    for k, v in stored.items():
        if k not in ALLOWED_KEYS:
            continue  # keys from older versions (e.g. railway_url)
        try:
            known[k] = _VALIDATORS[k](v)
        except InvalidInput:
            continue  # unusable hand-edited value: fall back to the default
    merged = {**DEFAULTS, **known}
    if merged != stored:
        # Rewrite so dropped keys and repaired values stop round-tripping.
        _save_unlocked(merged)
    return merged


def _save_unlocked(settings: dict):
    _ensure_dir()
    tmp = SETTINGS_FILE.with_suffix(SETTINGS_FILE.suffix + f".{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SETTINGS_FILE)  # atomic: a crash mid-write can't leave a truncated file


def save(settings: dict):
    with _lock:
        _save_unlocked(settings)


def validate(partial: dict) -> dict:
    """Validated, normalised known keys from ``partial``; unknown keys are dropped.

    Raises :class:`SettingsError` on the first invalid value.
    """
    out = {}
    for k, v in partial.items():
        if k in ALLOWED_KEYS:
            try:
                out[k] = _VALIDATORS[k](v)
            except InvalidInput as exc:
                raise SettingsError(str(exc)) from None
    return out


def update(partial: dict) -> dict:
    filtered = validate(partial)  # all-or-nothing: nothing is saved if any value is bad
    with _lock:
        # Same corrupt-file recovery as load(), so a damaged settings.json
        # can't turn PUT /api/settings into a 500.
        current = _load_unlocked()
        current.update(filtered)
        _save_unlocked(current)
        return current
