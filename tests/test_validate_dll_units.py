"""Unit tests for Race Studio CSV compare helpers in validate_dll.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from validate_dll import (
    _compare_channel,
    _is_rs_sentinel,
    _load_aim_reference_csv,
    _nearest_value,
    _resolve_dll_channel,
    _rs_to_dll_scale,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLDEN_CSV = FIXTURES / "golden" / "minimal_aim_export.csv"

GOLDEN_DLL_UNITS: dict[str, str] = {
    "GPS Speed": "m/s",
    "GPS PosAccuracy": "#",
    "GPS Latitude": "deg",
    "GPS Longitude": "deg",
    "GPS SpdAccuracy": "#",
    "LFspeed": "km/h",
    "RPM": "rpm",
    "Throttle_Pos": "%",
    "Phase_A_Current": "A",
    "Torque_Command": "Nm",
    "LateralAcc": "g",
    "InlineAcc": "g",
    "FBrakePressure": "bar",
    "RBrakePressure": "bar",
    "State_of_Charge": "%",
    "Pack_Temp": "C",
    "Pack_Voltage": "V",
    "Pack_Current": "A",
    "MCU_DC_Current": "A",
}


def test_rs_to_dll_scale_speed_units():
    assert _rs_to_dll_scale("km/h", "m/s", rs_channel="GPS Speed") == pytest.approx(1.0 / 3.6)
    assert _rs_to_dll_scale("m/s", "m/s", rs_channel="GPS Speed") == 1.0


def test_rs_to_dll_scale_lfspeed_ms_export_not_auto_converted():
    assert _rs_to_dll_scale("m/s", "km/h", rs_channel="LFspeed") == 1.0


def test_rs_to_dll_scale_posaccuracy_mm_to_dll_cm():
    assert _rs_to_dll_scale("mm", "#", rs_channel="GPS PosAccuracy") == 0.1


def test_rs_to_dll_scale_spdaccuracy_kmh_label_no_conversion():
    assert _rs_to_dll_scale("km/h", "#", rs_channel="GPS SpdAccuracy") == 1.0


def test_is_rs_sentinel():
    assert _is_rs_sentinel(10000.0)
    assert _is_rs_sentinel(9999.0)
    assert not _is_rs_sentinel(32.75)


def test_nearest_value_interpolates():
    ts = (0.0, 10.0, 20.0)
    vals = (0.0, 10.0, 20.0)
    assert _nearest_value(ts, vals, 5.0) == 5.0
    assert _nearest_value(ts, vals, 0.0) == 0.0
    assert _nearest_value(ts, vals, 25.0) == 20.0


def test_compare_channel_flags_mismatch():
    result = _compare_channel(
        "RPM",
        [0, 50, 100],
        [3000.0, 3010.0, 3020.0],
        [0.0, 0.05, 0.1],
        [3000.0, 3010.0, 3030.0],
        atol=0.01,
        rtol=0.001,
        sample_stride=1,
    )
    assert result is not None
    assert result["status"] == "fail"
    assert result["mismatches"] >= 1


def test_compare_channel_skips_sentinel_reference_values():
    result = _compare_channel(
        "GPS Radius",
        [0, 50, 100],
        [1.0, 1.0, 1.0],
        [0.0, 0.05, 0.1],
        [10000.0, 1.0, 1.0],
        atol=0.01,
        rtol=0.001,
        sample_stride=1,
    )
    assert result is not None
    assert result["status"] == "ok"


def test_load_aim_reference_csv_applies_unit_scaling():
    times, columns, units, converted = _load_aim_reference_csv(
        GOLDEN_CSV, dll_units=GOLDEN_DLL_UNITS
    )
    assert len(times) == 4
    assert units["GPS Speed"] == "m/s"
    assert columns["GPS Speed"][0] == pytest.approx(32.753)
    assert units["Pack Voltage"] == "V"
    assert units["Pack Current"] == "A"
    assert any("GPS PosAccuracy" in entry for entry in converted)
    assert columns["GPS PosAccuracy"][0] == pytest.approx(20.0)
    assert columns["GPS Latitude"][0] == pytest.approx(41.81529583)
    assert columns["MCU DC Current"][0] == pytest.approx(10.475)


def test_load_aim_reference_csv_skips_gps_sentinel_on_last_row():
    _, columns, _, _ = _load_aim_reference_csv(GOLDEN_CSV, dll_units=GOLDEN_DLL_UNITS)
    assert columns["GPS SpdAccuracy"][-1] == pytest.approx(0.18)


def test_resolve_dll_channel_normalizes_spaces():
    dll_units = {"Phase A Current": "A", "GPS Speed": "m/s"}
    assert _resolve_dll_channel("Phase A Current", dll_units) == "Phase A Current"
    assert _resolve_dll_channel("GPS Speed", dll_units) == "GPS Speed"


def test_resolve_dll_channel_maps_rs_names_to_dll_names():
    assert _resolve_dll_channel("Pack Voltage", GOLDEN_DLL_UNITS) == "Pack_Voltage"
    assert _resolve_dll_channel("Pack Current", GOLDEN_DLL_UNITS) == "Pack_Current"
    assert _resolve_dll_channel("State of Charge", GOLDEN_DLL_UNITS) == "State_of_Charge"
    assert _resolve_dll_channel("Phase A Current", GOLDEN_DLL_UNITS) == "Phase_A_Current"
    assert _resolve_dll_channel("MCU DC Current", GOLDEN_DLL_UNITS) == "MCU_DC_Current"
