"""Input sanitization shared by every route.

Pure functions, no FastAPI imports. Validators raise :class:`InvalidInput`
(a ``ValueError``) whose message is safe to show the user; routes turn it into
a 400. Two kinds of input come through here:

* things the user types (settings, rename, layout names) — rejected when
  malformed so the user sees why;
* text from files or the network (XRK channel names, upload filenames) —
  cleaned and truncated, because there is no one to correct it.
"""

from __future__ import annotations

import ipaddress
import math
import re
from pathlib import PurePosixPath

MAX_FILENAME_LEN = 200
MAX_CHANNEL_NAME_LEN = 256
MAX_DERIVED_CHANNELS = 512
MAX_LAYOUT_NAME_LEN = 100
MAX_SSID_BYTES = 32  # IEEE 802.11 limit
MAX_UNIT_LEN = 32

# C0/C1 control characters, zero-width characters and bidi overrides. The last
# two are invisible and are used to disguise names ("evil\u202egpj.exe").
_INVISIBLE_RE = re.compile(
    "[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
)
_UNSAFE_FILENAME_CHARS_RE = re.compile(r"[^\w\-.]")
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)
_LAYOUT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")  # used with fullmatch: "$" would allow a trailing \n
# Leading characters Excel / LibreOffice / Sheets treat as a formula (OWASP
# CSV injection), including the full-width forms some of them also accept.
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "＝", "＋", "－", "＠")


class InvalidInput(ValueError):
    """Input rejected; the message is user-visible."""


# ─── Text ────────────────────────────────────────────────────────────────────


def strip_invisible(value: str) -> str:
    """Remove control, zero-width and bidi-override characters."""
    return _INVISIBLE_RE.sub("", value)


def clean_text(value: object, *, max_len: int, field: str = "Value", truncate: bool = False) -> str:
    """Trimmed text with invisible characters removed, at most ``max_len`` long."""
    if not isinstance(value, str):
        raise InvalidInput(f"{field} must be text")
    cleaned = strip_invisible(value).strip()
    if len(cleaned) > max_len:
        if not truncate:
            raise InvalidInput(f"{field} is too long (max {max_len} characters)")
        cleaned = cleaned[:max_len].rstrip()
    return cleaned


# ─── Filenames ───────────────────────────────────────────────────────────────


def sanitize_filename(filename: object) -> str:
    """A bare, portable filename safe to create under the sessions directory.

    Directory components are dropped (``/`` and ``\\`` on every OS, so a
    Windows path behaves the same on macOS), unsafe characters become ``_``,
    Windows reserved device names get a ``_`` prefix, and the result is
    capped at :data:`MAX_FILENAME_LEN` keeping the extension.
    """
    if not isinstance(filename, str):
        raise InvalidInput("Invalid filename")
    name = PurePosixPath(strip_invisible(filename).strip().replace("\\", "/")).name
    name = _UNSAFE_FILENAME_CHARS_RE.sub("_", name)
    # Windows strips trailing dots, so "a.xrk." and "a.xrk" would collide.
    name = name.rstrip(".")
    if not name or name.startswith("."):
        raise InvalidInput("Invalid filename")

    if name.partition(".")[0].upper() in _WINDOWS_RESERVED:
        name = "_" + name

    if len(name) > MAX_FILENAME_LEN:
        suffix = PurePosixPath(name).suffix
        if len(suffix) > 16:  # not a real extension; just cut
            suffix = ""
        name = name[: MAX_FILENAME_LEN - len(suffix)].rstrip(".") + suffix
    return name


# ─── AiM device settings ─────────────────────────────────────────────────────


def validate_device_ip(value: object) -> str:
    """A literal IPv4/IPv6 address (normalised). Hostnames are not accepted:
    the logger is always addressed by IP and this value is opened as a raw socket."""
    if not isinstance(value, str):
        raise InvalidInput("Device IP must be text")
    try:
        return str(ipaddress.ip_address(value.strip(" ")))
    except ValueError:
        raise InvalidInput("Device IP must be an IP address like 10.0.0.1") from None


def validate_device_port(value: object) -> int:
    """TCP port 1–65535. Accepts ints, integral floats and digit strings."""
    if isinstance(value, bool):
        raise InvalidInput("Device port must be a number")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise InvalidInput("Device port must be a whole number")
        value = int(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped.isdecimal():
            raise InvalidInput("Device port must be a number")
        value = int(stripped)
    if not isinstance(value, int):
        raise InvalidInput("Device port must be a number")
    if not 1 <= value <= 65535:
        raise InvalidInput("Device port must be between 1 and 65535")
    return value


def validate_wifi_ssid(value: object) -> str:
    """A WiFi network name: at most 32 bytes of UTF-8, no control characters."""
    ssid = clean_text(value, max_len=MAX_SSID_BYTES, field="WiFi network name")
    if len(ssid.encode("utf-8")) > MAX_SSID_BYTES:
        raise InvalidInput(f"WiFi network name is too long (max {MAX_SSID_BYTES} bytes)")
    return ssid


# ─── CSV export ──────────────────────────────────────────────────────────────


def csv_safe_cell(value: str) -> str:
    """Prefix text that a spreadsheet would run as a formula with ``'``.

    Only for text cells (headers); numeric cells are written by the exporter
    itself and must stay numeric, including negatives.
    """
    if value.startswith(_CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


# ─── Live layouts ────────────────────────────────────────────────────────────


def validate_layout_id(value: object) -> str:
    """Layout ids are generated by the client as ``<prefix>-<hex>``."""
    if not isinstance(value, str) or not _LAYOUT_ID_RE.fullmatch(value):
        raise InvalidInput("Layout id may only contain letters, digits, '-' and '_' (max 64)")
    return value


def is_valid_layout_id(value: object) -> bool:
    try:
        validate_layout_id(value)
    except InvalidInput:
        return False
    return True


# ─── Derived channels ────────────────────────────────────────────────────────


def validate_channel_payload(channels: object) -> dict:
    """Structural check of ``{name: {"timestamps": [...], "values": [...]}}``.

    Element types are not checked here: the arrays can be millions long and the
    script (and the result filter) already copes with ``None`` gaps.
    """
    if not isinstance(channels, dict):
        raise InvalidInput("channels must be an object")
    if len(channels) > MAX_DERIVED_CHANNELS:
        raise InvalidInput(f"Too many channels (max {MAX_DERIVED_CHANNELS})")
    for name, data in channels.items():
        if len(name) > MAX_CHANNEL_NAME_LEN:
            raise InvalidInput(f"Channel name is too long (max {MAX_CHANNEL_NAME_LEN} characters)")
        if not isinstance(data, dict):
            raise InvalidInput(f"Channel '{name[:64]}' must be an object")
        ts, vs = data.get("timestamps"), data.get("values")
        if not isinstance(ts, list) or not isinstance(vs, list):
            raise InvalidInput(f"Channel '{name[:64]}' needs 'timestamps' and 'values' lists")
        if len(ts) != len(vs):
            raise InvalidInput(f"Channel '{name[:64]}' has mismatched timestamps and values")
    return channels


def is_finite_number(value: object) -> bool:
    """True for finite ints/floats (bools count: scripts may emit flag channels)."""
    return isinstance(value, (int, float)) and math.isfinite(value)
