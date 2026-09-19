"""Parse AiM channel-layout blobs and decode 691-byte live snapshots.

Mapping validated in docs/protocol/captures/analysis/q5_validate.py:
  live_offset = logical_offset(u68 in record) + 12
  width       = u72 in record
  value       = raw * scale + offset  (scale/offset as f32 at +100/+104 in record)
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

LIVE_FRAME_HEADER = 12
INT32_PLACEHOLDER = 0x7FFFFFFF
INT16_PLACEHOLDER = 0x7FFF
# Layout frames seen on EVO5 (Race Studio 2026 captures).
LAYOUT_SIZES = frozenset({13608, 15060})


@dataclass(frozen=True)
class ChannelField:
    name: str
    live_offset: int
    width: int
    scale: float
    offset: float
    type_code: int


def parse_inner_records(stream: bytes, start_at: int = LIVE_FRAME_HEADER) -> list[bytes]:
    """Extract inner `<hCMD>…` record payloads from a channel-layout STCP blob."""
    out: list[bytes] = []
    i = start_at
    n = len(stream)
    while i < n:
        idx = stream.find(b"<h", i)
        if idx < 0 or idx + 12 > n:
            break
        length = int.from_bytes(stream[idx + 6 : idx + 10], "little")
        if stream[idx + 11 : idx + 12] != b">":
            i = idx + 1
            continue
        ps = idx + 12
        pe = ps + length
        if pe + 8 > n:
            break
        cmd = stream[idx + 2 : idx + 6]
        cmd2 = stream[pe + 1 : pe + 5]
        if stream[pe : pe + 1] != b"<" or cmd2 != cmd or stream[pe + 7 : pe + 8] != b">":
            i = idx + 1
            continue
        out.append(stream[ps:pe])
        i = pe + 8
    return out


def parse_channel_layout(blob: bytes, *, live_frame_len: int = 691) -> list[ChannelField]:
    """Build decode map from the ~15 KB layout frame delivered during live setup."""
    fields: list[ChannelField] = []
    for record in parse_inner_records(blob):
        if len(record) < 104:
            continue
        logical = struct.unpack_from("<I", record, 68)[0]
        width = struct.unpack_from("<I", record, 72)[0]
        type_code = struct.unpack_from("<I", record, 80)[0]
        if width <= 0 or width > 64:
            continue
        live_off = logical + LIVE_FRAME_HEADER
        if live_off + width > live_frame_len:
            continue
        name = record[32:64].rstrip(b"\x00").decode("latin1", errors="replace").strip()
        if not name:
            continue
        scale, offset = struct.unpack_from("<2f", record, 100)
        fields.append(
            ChannelField(
                name=name,
                live_offset=live_off,
                width=width,
                scale=scale,
                offset=offset,
                type_code=type_code,
            )
        )
    return fields


def _raw_scalar(sl: bytes) -> float | None:
    if len(sl) == 4:
        u = int.from_bytes(sl, "little")
        if u in (INT32_PLACEHOLDER, 0xFF80FF80, 0xFF800000):
            return None
        s = struct.unpack("<i", sl)[0]
        if s == INT32_PLACEHOLDER:
            return None
        return float(s)
    if len(sl) == 2:
        u = int.from_bytes(sl, "little")
        if u == INT16_PLACEHOLDER:
            return None
        return float(struct.unpack("<h", sl)[0])
    if len(sl) == 1:
        return float(sl[0])
    if len(sl) == 8:
        return struct.unpack("<d", sl)[0]
    return None


def _effective_offset(offset: float) -> float:
    if offset != offset or abs(offset) > 1e10:
        return 0.0
    return offset


def _decode_field_value(payload: bytes, field: ChannelField) -> float | None:
    end = field.live_offset + field.width
    if end > len(payload):
        return None
    sl = payload[field.live_offset:end]
    off = _effective_offset(field.offset)

    if field.width == 4 and field.type_code in (2, 4, 6):
        value, = struct.unpack("<f", sl)
        if value != value or abs(value) >= 1e20:
            return None
        return value * field.scale + off

    if field.width == 2:
        if len(sl) < 2:
            return None
        signed = struct.unpack("<h", sl)[0]
        if signed == INT16_PLACEHOLDER:
            return None
        scale = field.scale
        if scale == 1.0 and "Voltage" in field.name:
            scale = 0.001
        elif field.type_code == 6 and scale == 1.0:
            scale = 0.0001
        value = signed * scale + off
        if value != value or abs(value) >= 1e20:
            return None
        return value

    raw = _raw_scalar(sl)
    if raw is None:
        return None
    value = raw * field.scale + off
    if value != value or abs(value) >= 1e20:
        return None
    return value


def decode_live_channels(payload: bytes, fields: list[ChannelField]) -> dict[str, float]:
    """Decode named channels from one live STCP payload."""
    out: dict[str, float] = {}
    for field in fields:
        if field.width >= 8 and field.type_code >= 512:
            continue
        value = _decode_field_value(payload, field)
        if value is None:
            continue
        out[field.name] = value
    return out


def is_layout_blob(payload: bytes) -> bool:
    return len(payload) in LAYOUT_SIZES or len(payload) >= 12000
