"""Lap detection: device markers -> GPS loop closing -> beacon pulses."""

from __future__ import annotations

import pytest

from conftest import circuit_samples, make_log
from services import lap_detection as ld
from state import channel_data


def _detect(log):
    return ld.detect_laps(log, lambda n: channel_data(n, log.channels[n]) if n in log.channels else None)


def test_device_laps_win_over_everything():
    log = make_log({"RPM": ([0, 10], [1.0, 2.0], "")}, laps=[(0, 1000), (1000, 2200)])
    laps, source = _detect(log)
    assert source == "device"
    assert [(l["startTime"], l["endTime"]) for l in laps] == [(0, 1000), (1000, 2200)]


def test_gps_loop_detection_finds_each_completed_lap():
    ts, lat, lon = circuit_samples(n_laps=3, lap_s=30, hz=10)
    laps = ld.from_gps(ts, lat, lon)
    assert len(laps) == 3
    assert [l["lapNumber"] for l in laps] == [1, 2, 3]
    for l in laps:
        assert l["source"] == "gps_auto"
        assert (l["endTime"] - l["startTime"]) == pytest.approx(30_000, abs=1_500)


def test_gps_detection_needs_departure_before_return():
    """A parked car jittering near the start line is not doing laps."""
    n = 300
    ts = [i * 100 for i in range(n)]
    lat = [41.8 + (i % 3) * 1e-6 for i in range(n)]
    lon = [-72.2 + (i % 2) * 1e-6 for i in range(n)]
    assert ld.from_gps(ts, lat, lon) == []


def test_gps_detection_never_reports_laps_shorter_than_the_debounce():
    """4 s circuits are skipped individually; the lap clock keeps running, so a
    later crossing may still register -- but never as a sub-10 s lap."""
    ts, lat, lon = circuit_samples(n_laps=5, lap_s=4, hz=10)
    laps = ld.from_gps(ts, lat, lon)
    assert len(laps) < 5
    assert all((l["endTime"] - l["startTime"]) / 1000 >= ld.MIN_LAP_S for l in laps)


def test_gps_detection_drops_zero_fixes_and_needs_enough_points():
    assert ld.from_gps([0, 100], [41.8, 41.8], [-72.2, -72.2]) == []
    ts, lat, lon = circuit_samples(2, 30, 10)
    lat = [0.0 if i % 50 == 0 else v for i, v in enumerate(lat)]
    lon = [0.0 if i % 50 == 0 else v for i, v in enumerate(lon)]
    assert len(ld.from_gps(ts, lat, lon)) >= 1


def test_beacon_rising_edges_become_laps():
    ts = [i * 1000 for i in range(100)]
    values = [1.0 if i % 25 == 0 and i else 0.0 for i in range(100)]
    laps = ld.from_beacon(ts, values)
    assert [l["source"] for l in laps] == ["beacon_auto"] * 3
    assert [l["endTime"] for l in laps] == [25_000, 50_000, 75_000]
    assert laps[0]["startTime"] == 0


def test_beacon_flat_signal_and_short_signal_yield_nothing():
    assert ld.from_beacon(list(range(20)), [0.0] * 20) == []
    assert ld.from_beacon([0, 1, 2], [0.0, 1.0, 0.0]) == []


def test_fallback_chain_uses_gps_then_beacon_then_none():
    ts, lat, lon = circuit_samples(3, 30, 10)
    gps_log = make_log({"GPS Latitude": (ts, lat, "deg"), "GPS Longitude": (ts, lon, "deg")})
    laps, source = _detect(gps_log)
    assert source == "gps_auto" and len(laps) == 3

    bts = [i * 1000 for i in range(100)]
    bval = [1.0 if i % 25 == 0 and i else 0.0 for i in range(100)]
    beacon_log = make_log({"Lap Beacon": (bts, bval, "")})
    laps, source = _detect(beacon_log)
    assert source == "beacon_auto" and len(laps) == 3

    laps, source = _detect(make_log({"RPM": ([0, 10], [1.0, 2.0], "")}))
    assert (laps, source) == ([], "none")


def test_haversine_known_distance():
    # 0.01 deg of latitude ~ 1.112 km
    assert ld._haversine_m(41.0, -72.0, 41.01, -72.0) == pytest.approx(1111.9, abs=2)
    assert ld._haversine_m(41.0, -72.0, 41.0, -72.0) == 0.0
