"""Tests for libxrk GPS epoch timestamp rebasing."""

from __future__ import annotations

import pyarrow as pa
from libxrk import ChannelMetadata
from libxrk.base import LogFile

from parsers.libxrk_fixup import normalize_libxrk_timestamps

_EPOCH_GPS_MS = 1_464_818_460_000_000


def _channel_table(name: str, timecodes: list[int], values: list[float]) -> pa.Table:
    meta = ChannelMetadata(units="m/s" if name == "GPS Speed" else "", dec_pts=0, interpolate=True)
    time_field = pa.field("timecodes", pa.int64())
    value_field = pa.field(name, pa.float64(), metadata=meta.to_field_metadata())
    return pa.Table.from_arrays(
        [pa.array(timecodes, type=pa.int64()), pa.array(values, type=pa.float64())],
        schema=pa.schema([time_field, value_field]),
    )


def test_normalize_libxrk_timestamps_rebases_epoch_gps():
    log = LogFile(
        channels={
            "RPM": _channel_table("RPM", [0, 50, 100], [3000.0, 3100.0, 3200.0]),
            "GPS Speed": _channel_table(
                "GPS Speed",
                [_EPOCH_GPS_MS, _EPOCH_GPS_MS + 50, _EPOCH_GPS_MS + 100],
                [10.0, 11.0, 12.0],
            ),
        },
        laps=pa.table({"num": [], "start_time": [], "end_time": []}),
        metadata={},
        file_name="test.xrk",
    )

    normalized = normalize_libxrk_timestamps(log)
    gps_tc = normalized.channels["GPS Speed"]["timecodes"].to_pylist()
    assert gps_tc[0] == 0
    assert gps_tc[1] == 50
    assert gps_tc[2] == 100
