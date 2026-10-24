"""Parse AiM channel-layout blobs and decode 691-byte live snapshots.

Mapping validated in docs/protocol/captures/analysis/q5_validate.py:
  live_offset = logical_offset(u68 in record) + 12
  width       = u72 in record
  value       = raw * scale  (f32 at +100; +104/+108 are the display min/max
                range, e.g. Logger Temperature -99.9..999.9 -- NOT an offset)
  quantity    = u16 at +12, low 7 bits -- what the channel measures, and so
                the unit AiM sends it in (see _QUANTITY_UNITS)
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass

LIVE_FRAME_HEADER = 12
INT32_PLACEHOLDER = 0x7FFFFFFF
INT16_PLACEHOLDER = 0x7FFF
# Layout frames seen on EVO5 (Race Studio 2026 captures).
LAYOUT_SIZES = frozenset({13608, 15060})

# Layout quantity code -> (display unit, factor from the wire unit). Verified
# against UConn EV (live_707b_evo5) and IC (oct20livetest.pcapng) captures:
# every 0x15 voltage arrives in mV (External Voltage 12424, Min_Cell_Voltage
# 4012, S8_vbat 12485) while the BMS pack voltage is its own quantity 0x20 in
# V (407.6); 0x0e pressures read 0.99 for MAP at atmosphere, so bar.
_QUANTITY_UNITS: dict[int, tuple[str, float]] = {
    0x01: ("%", 1.0),
    0x03: ("g", 1.0),
    0x04: ("°", 1.0),
    0x05: ("°/s", 1.0),
    0x0E: ("bar", 1.0),
    0x0F: ("rpm", 1.0),
    0x10: ("km/h", 1.0),
    0x11: ("°C", 1.0),
    0x12: ("ms", 1.0),
    0x13: ("Nm", 1.0),
    0x15: ("V", 0.001),
    0x1B: ("A", 1.0),
    0x20: ("V", 1.0),
}


@dataclass(frozen=True)
class ChannelField:
    name: str
    live_offset: int
    width: int
    scale: float
    type_code: int
    # Display unit from the layout's quantity code ("" when unknown/unitless)
    # and the factor converting the wire value into it (mV -> V).
    unit: str = ""
    unit_factor: float = 1.0


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
            i = idx + 1
            continue
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
        scale = struct.unpack_from("<f", record, 100)[0]
        quantity = struct.unpack_from("<H", record, 12)[0] & 0x7F
        unit, unit_factor = _QUANTITY_UNITS.get(quantity, ("", 1.0))
        fields.append(
            ChannelField(
                name=name,
                live_offset=live_off,
                width=width,
                scale=scale,
                type_code=type_code,
                unit=unit,
                unit_factor=unit_factor,
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


def _decode_field_value(payload: bytes, field: ChannelField) -> float | None:
    end = field.live_offset + field.width
    if end > len(payload):
        return None
    sl = payload[field.live_offset:end]

    is_float = field.type_code in (2, 4, 6) and field.width in (2, 4)
    is_bool_flag = field.type_code in (512, 514) and len(sl) >= 4
    if is_float or is_bool_flag:
        # 4-byte type 2/4/6 fields are f32; 2-byte ones are IEEE half floats
        # (VerticalAcc reads -1.0 g at rest, Logger Temperature ~25 C, and
        # FBRAKEPres matches its f32 FBrakePressCorr). AiM marks "no sensor"
        # with -inf (0xfc00 / 0xff800000), e.g. unplugged thermocouples.
        #
        # 512/514 are boolean state/fault/alarm flags. AiM always encodes them
        # as an f32 0.0/1.0 (confirmed: BMS_Disch_Enable / Direction read raw
        # 0x3f800000 -- garbage 1065353216 if read as int32) in the first 4
        # bytes of the record's declared slot. The *_Fault/*_Alarm channels
        # declare an 8-byte slot but only the first 4 bytes ever carry a real
        # value -- the trailing 4 are a constant 0xA5A5A5A5 fill pattern
        # (verified identical across all 70 live frames / 3 TCP sessions in
        # wiresharklivedata.pcapng), so we deliberately ignore them rather
        # than reading a bogus f64 across the whole 8-byte slot.
        value, = struct.unpack_from("<e" if field.width == 2 else "<f", sl, 0)
    else:
        raw = _raw_scalar(sl)
        if raw is None:
            return None
        value = raw
    value = value * field.scale * field.unit_factor
    if not math.isfinite(value) or abs(value) >= 1e20:
        return None
    return value


def decode_live_channels(payload: bytes, fields: list[ChannelField]) -> dict[str, float]:
    """Decode named channels from one live STCP payload."""
    out: dict[str, float] = {}
    for field in fields:
        # 512/514 are handled explicitly (as f32 booleans) in _decode_field_value.
        # Anything else >= 512 is an unmodeled composite (e.g. the 56 B GPS
        # struct at type 65536) -- skip rather than emit a garbage scalar.
        if field.type_code >= 512 and field.type_code not in (512, 514):
            continue
        value = _decode_field_value(payload, field)
        if value is None:
            continue
        out[field.name] = value
    return out


# Smaller than any real layout (the 85-channel UConn-IC layout is 11232 B) but
# larger than the 494 B `hhh` frame the device also sends during setup.
LAYOUT_MIN_LEN = 2000


def is_layout_blob(payload: bytes) -> bool:
    """Channel-layout frame: `\\0\\0\\0\\0hhh` header, any size above LAYOUT_MIN_LEN.

    The layout size depends on the channel count (EV 13608/15060/15588 B, IC
    11232 B), so identify it by its tag rather than a size list.
    """
    if len(payload) in LAYOUT_SIZES or len(payload) >= 12000:
        return True
    return len(payload) >= LAYOUT_MIN_LEN and payload[:4] == b"\x00\x00\x00\x00" and payload[4:7] == b"hhh"
