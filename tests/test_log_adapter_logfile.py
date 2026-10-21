"""Tests for the DLL → libxrk LogFile adapter using a fake DLL (runs on any OS)."""

from __future__ import annotations

import math

from parsers.log_adapter import (
    _build_laps,
    _build_metadata,
    _make_channel_table,
    _normalize_channel_name,
    dll_to_logfile,
)


class FakeDll:
    def __init__(self, *, regular=None, gps=None, laps=None):
        self.regular = regular or []
        self.gps = gps or []
        self.laps = laps or []

    def iter_regular_channels(self, _idx):
        yield from self.regular

    def iter_gps_channels(self, _idx):
        yield from self.gps

    def get_laps_count(self, _idx):
        return len(self.laps)

    def get_lap_info(self, _idx, lap):
        return self.laps[lap]

    def get_date_and_time(self, _idx):
        return "19/10/2026", "14:05:00"

    def get_vehicle_name(self, _idx):
        return "CT16-EV"

    def get_racer_name(self, _idx):
        return "Driver A"

    def get_track_name(self, _idx):
        return "Lot"

    def get_championship_name(self, _idx):
        return "FSAE"

    def get_venue_type_name(self, _idx):
        return "Test"


def test_normalize_channel_name_maps_gps_aliases():
    assert _normalize_channel_name("GPS_Speed") == "GPS Speed"
    assert _normalize_channel_name("GPS_LatAcc") == "GPS LateralAcc"
    assert _normalize_channel_name("GPS_Nsat") == "GPS Satellites"


def test_normalize_channel_name_passes_through_unknown_names():
    assert _normalize_channel_name("RPM") == "RPM"
    assert _normalize_channel_name("GPS Latitude") == "GPS Latitude"


def test_make_channel_table_schema_and_units():
    table = _make_channel_table("RPM", [0.0, 0.5], [1000, 2000.5], units="rpm")

    assert table.column_names == ["timecodes", "RPM"]
    assert table["timecodes"].to_pylist() == [0, 500]
    assert table["RPM"].to_pylist() == [1000.0, 2000.5]
    meta = table.schema.field("RPM").metadata
    assert meta is not None
    assert any(b"rpm" in v for v in meta.values())


def test_make_channel_table_non_finite_and_non_numeric_become_nan():
    table = _make_channel_table("X", [0.0, 1.0, 2.0, 3.0], [1.0, math.inf, None, float("nan")])

    values = table["X"].to_pylist()
    assert values[0] == 1.0
    assert all(math.isnan(v) for v in values[1:])


def test_make_channel_table_gps_times_already_ms():
    table = _make_channel_table("GPS Speed", [100.0, 200.4], [1.0, 2.0], times_already_ms=True)

    assert table["timecodes"].to_pylist() == [100, 200]


def test_build_laps_converts_seconds_to_ms():
    laps = _build_laps(FakeDll(laps=[(0.0, 30.5), (30.5, 29.25)]), 0)

    assert laps["num"].to_pylist() == [0, 1]
    assert laps["start_time"].to_pylist() == [0, 30500]
    assert laps["end_time"].to_pylist() == [30500, 59750]


def test_build_laps_empty_when_no_laps():
    laps = _build_laps(FakeDll(), 0)

    assert laps.num_rows == 0
    assert laps.column_names == ["num", "start_time", "end_time"]


def test_build_metadata_maps_dll_fields():
    assert _build_metadata(FakeDll(), 0) == {
        "Vehicle": "CT16-EV",
        "Driver": "Driver A",
        "Venue": "Lot",
        "Series": "FSAE",
        "Session": "Test",
        "Log Date": "19/10/2026",
        "Log Time": "14:05:00",
        "Long Comment": "",
    }


def test_dll_to_logfile_builds_regular_and_gps_channels():
    dll = FakeDll(
        regular=[
            ("RPM", "rpm", [0.0, 1.0], [1000.0, 1100.0]),
            ("", "x", [0.0], [1.0]),  # unnamed → skipped
            ("Empty", "x", [], []),  # no samples → skipped
        ],
        gps=[("GPS_Speed", "km/h", [0.0, 100.0], [10.0, 11.0])],
        laps=[(0.0, 1.0)],
    )

    log = dll_to_logfile(dll, 0, "run.xrk")

    assert set(log.channels) == {"RPM", "GPS Speed"}
    assert log.channels["RPM"]["timecodes"].to_pylist() == [0, 1000]
    assert log.channels["GPS Speed"]["timecodes"].to_pylist() == [0, 100]
    assert log.laps.num_rows == 1
    assert log.metadata["Vehicle"] == "CT16-EV"
    assert log.file_name == "run.xrk"
