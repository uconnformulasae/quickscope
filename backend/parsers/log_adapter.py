"""
Convert AiM DLL session data into a libxrk-compatible LogFile.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

import pyarrow as pa
from libxrk.base import ChannelMetadata, LogFile

if TYPE_CHECKING:
    from .aim_dll import AimDll

# Normalize DLL GPS names to libxrk-style names QuickScope already matches.
_GPS_NAME_ALIASES: dict[str, str] = {
    "GPS_Speed": "GPS Speed",
    "GPS_Latitude": "GPS Latitude",
    "GPS_Longitude": "GPS Longitude",
    "GPS_LatAcc": "GPS LateralAcc",
    "GPS_LonAcc": "GPS InlineAcc",
    "GPS_Heading": "GPS Heading",
    "GPS_Altitude": "GPS Altitude",
    "GPS_PosAccuracy": "GPS Position Accuracy",
    "GPS_Nsat": "GPS Satellites",
}


def _normalize_channel_name(name: str) -> str:
    if name in _GPS_NAME_ALIASES:
        return _GPS_NAME_ALIASES[name]
    # DLL often uses spaces already ("GPS Latitude"); keep as-is.
    return name


def _to_timecodes_ms(times: list[float], *, already_ms: bool = False) -> list[int]:
    """Convert DLL sample times to session-relative milliseconds.

    Regular channels use seconds; GPS channels from get_GPS_channel_samples
    are already in milliseconds (verified against session duration).
    """
    if already_ms:
        return [int(round(t)) for t in times]
    return [int(round(t * 1000.0)) for t in times]


def _make_channel_table(
    name: str,
    times: list[float],
    values: list[float],
    *,
    units: str = "",
    source_type: int = 0,
    times_already_ms: bool = False,
) -> pa.Table:
    timecodes = _to_timecodes_ms(times, already_ms=times_already_ms)
    clean_values = []
    for v in values:
        if isinstance(v, (int, float)) and math.isfinite(v):
            clean_values.append(float(v))
        else:
            clean_values.append(0.0)

    meta = ChannelMetadata(
        units=units,
        dec_pts=0,
        interpolate=True,
        source_type=source_type,
    )
    time_field = pa.field("timecodes", pa.int64())
    value_field = pa.field(name, pa.float64(), metadata=meta.to_field_metadata())
    return pa.Table.from_arrays(
        [pa.array(timecodes, type=pa.int64()), pa.array(clean_values, type=pa.float64())],
        schema=pa.schema([time_field, value_field]),
    )


def _build_metadata(dll: AimDll, idx: int) -> dict[str, str]:
    log_date, log_time = dll.get_date_and_time(idx)
    return {
        "Vehicle": dll.get_vehicle_name(idx),
        "Driver": dll.get_racer_name(idx),
        "Venue": dll.get_track_name(idx),
        "Series": dll.get_championship_name(idx),
        "Session": dll.get_venue_type_name(idx),
        "Log Date": log_date,
        "Log Time": log_time,
        "Long Comment": "",
    }


def _build_laps(dll: AimDll, idx: int) -> pa.Table:
    lap_count = dll.get_laps_count(idx)
    if lap_count <= 0:
        return pa.table(
            {
                "num": pa.array([], type=pa.int32()),
                "start_time": pa.array([], type=pa.int64()),
                "end_time": pa.array([], type=pa.int64()),
            }
        )

    nums: list[int] = []
    starts: list[int] = []
    ends: list[int] = []
    for lap in range(lap_count):
        start_s, duration_s = dll.get_lap_info(idx, lap)
        nums.append(lap)
        start_ms = int(round(start_s * 1000.0))
        end_ms = int(round((start_s + duration_s) * 1000.0))
        starts.append(start_ms)
        ends.append(end_ms)

    return pa.table(
        {
            "num": pa.array(nums, type=pa.int32()),
            "start_time": pa.array(starts, type=pa.int64()),
            "end_time": pa.array(ends, type=pa.int64()),
        }
    )


def dll_to_logfile(dll: AimDll, idx: int, file_name: str) -> LogFile:
    channels: dict[str, pa.Table] = {}

    for name, units, times, values in dll.iter_regular_channels(idx):
        if not name or not times:
            continue
        norm = _normalize_channel_name(name)
        channels[norm] = _make_channel_table(norm, times, values, units=units)

    for name, units, times, values in dll.iter_gps_channels(idx):
        if not name or not times:
            continue
        norm = _normalize_channel_name(name)
        channels[norm] = _make_channel_table(
            norm, times, values, units=units, source_type=5, times_already_ms=True
        )

    return LogFile(
        channels=channels,
        laps=_build_laps(dll, idx),
        metadata=_build_metadata(dll, idx),
        file_name=file_name,
    )
