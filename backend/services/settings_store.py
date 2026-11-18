"""
Settings persistence backed by ./data/settings.json.
"""

import threading
from pathlib import Path

from config import DATA_DIR
from services.json_store import load_json, save_json
from sanitize import InvalidInput, validate_device_ip, validate_device_port, validate_wifi_ssid

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
    # Missing or unreadable (kept aside for recovery): fall back to defaults.
    stored = load_json(SETTINGS_FILE, lambda data: isinstance(data, dict))
    if stored is None:
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
    save_json(SETTINGS_FILE, settings)


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
