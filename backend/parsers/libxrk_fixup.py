"""
Post-process libxrk LogFile output for QuickScope chart compatibility.

libxrk emits GPS-derived channels with wall-clock millisecond timecodes while
regular channels use session-relative milliseconds. The chart x-axis is always
0..durationMs, so epoch GPS samples never fall in view unless rebased.
"""

from __future__ import annotations

import pyarrow as pa
from libxrk import ChannelMetadata
from libxrk.base import LogFile

# Session-relative channel times stay well below one day in ms.
_EPOCH_THRESHOLD_MS = 86_400_000


def _is_gps_channel(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith("gps") or lowered.startswith("gps_")


def _session_duration_ms(log: LogFile) -> float:
    duration_ms = 0.0
    for name, table in log.channels.items():
        if _is_gps_channel(name) or table.num_rows == 0:
            continue
        last_tc = float(table["timecodes"][-1].as_py())
        if last_tc < _EPOCH_THRESHOLD_MS and last_tc > duration_ms:
            duration_ms = last_tc
    return duration_ms


def _needs_epoch_rebase(timecodes: list[int], duration_ms: float) -> bool:
    if not timecodes:
        return False
    min_tc = timecodes[0]
    max_tc = timecodes[-1]
    if min_tc >= _EPOCH_THRESHOLD_MS:
        return True
    if duration_ms > 0 and max_tc > duration_ms * 2:
        return True
    return False


def _rebase_table(table: pa.Table, offset: int) -> pa.Table:
    name = table.schema.names[1]
    meta = ChannelMetadata.from_field(table.schema.field(name))
    timecodes = [int(tc) - offset for tc in table["timecodes"].to_pylist()]
    values = table[name].to_pylist()

    time_field = pa.field("timecodes", pa.int64())
    value_field = pa.field(name, pa.float64(), metadata=meta.to_field_metadata())
    return pa.Table.from_arrays(
        [pa.array(timecodes, type=pa.int64()), pa.array(values, type=pa.float64())],
        schema=pa.schema([time_field, value_field]),
    )


def normalize_libxrk_timestamps(log: LogFile) -> LogFile:
    """Rebase epoch GPS timecodes to session-relative milliseconds."""
    duration_ms = _session_duration_ms(log)

    offset: int | None = None
    for name, table in log.channels.items():
        if not _is_gps_channel(name) or table.num_rows == 0:
            continue
        timecodes = table["timecodes"].to_pylist()
        if not _needs_epoch_rebase(timecodes, duration_ms):
            continue
        if offset is None:
            offset = int(min(timecodes))
        log.channels[name] = _rebase_table(table, offset)

    return log
