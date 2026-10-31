"""Prepare on-disk session files for user export as uncompressed .xrk."""

from __future__ import annotations

import re
import zlib
from pathlib import Path


def is_zlib_xrz_payload(raw: bytes) -> bool:
    """True when ``raw`` looks like zlib-compressed XRZ (see aim-protocol-research)."""
    return len(raw) >= 2 and raw[0] == 0x78 and raw[1] in (0x01, 0x9C, 0xDA)


def quickscope_export_basename(
    stored_filename: str | None,
    aim_session_id: str | None = None,
) -> str:
    """Filesystem-safe export base matching QuickScope's session list label."""
    label = (aim_session_id or "").strip()
    if not label and stored_filename:
        label = Path(stored_filename).name
    if not label:
        return "export"
    lower = label.lower()
    if lower.endswith(".xrk") or lower.endswith(".xrz"):
        label = Path(label).stem
    safe = re.sub(r"[^\w\-.]", "_", label)
    return safe or "export"


def export_xrk_filename(
    stored_filename: str | None,
    aim_session_id: str | None = None,
) -> str:
    """Download name for export — always ``.xrk``, never ``.xrz``."""
    return f"{quickscope_export_basename(stored_filename, aim_session_id)}.xrk"


def read_xrk_export_bytes(
    local_path: Path,
    stored_filename: str | None = None,
    aim_session_id: str | None = None,
) -> tuple[bytes, str]:
    """Return uncompressed XRK bytes and a ``.xrk`` filename for Content-Disposition."""
    name = export_xrk_filename(stored_filename or local_path.name, aim_session_id)
    raw = local_path.read_bytes()

    is_xrz = local_path.suffix.lower() == ".xrz" or is_zlib_xrz_payload(raw)
    if not is_xrz:
        return raw, name

    try:
        return zlib.decompress(raw), name
    except zlib.error as exc:
        raise ValueError("Failed to decompress XRZ file") from exc
