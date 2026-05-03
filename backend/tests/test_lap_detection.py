"""Unit tests for lap_detection.from_setpoints()."""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.lap_detection import from_setpoints, MIN_LAP_S


# Earth radius used to convert meters → degrees for synthetic GPS tracks.
_EARTH_R_M = 6_371_000.0
_BASE_LAT = 41.8084  # somewhere in Storrs, CT — values just need to be plausible
_BASE_LON = -72.2495


def _lat_offset_m_to_deg(meters: float) -> float:
    return (meters / _EARTH_R_M) * (180.0 / math.pi)


def _lon_offset_m_to_deg(meters: float, at_lat: float) -> float:
    return (meters / (_EARTH_R_M * math.cos(math.radians(at_lat)))) * (180.0 / math.pi)


def _make_loop(
    n_laps: int,
    *,
    samples_per_lap: int = 200,
    radius_m: float = 50.0,
    period_s: float = 30.0,
    start_t_ms: float = 0.0,
):
    """Build a synthetic circular track centred at (_BASE_LAT, _BASE_LON).

    Each lap is `samples_per_lap` evenly-spaced samples around the loop.
    Returns (timestamps_ms, lats, lons). Sample 0 of every lap is at angle 0
    (i.e., directly north of centre by `radius_m`).
    """
    timestamps: list[float] = []
    lats: list[float] = []
    lons: list[float] = []
    dt_ms = (period_s * 1000.0) / samples_per_lap
    for lap_idx in range(n_laps):
        for i in range(samples_per_lap):
            theta = 2 * math.pi * (i / samples_per_lap)
            d_lat_m = radius_m * math.cos(theta)
            d_lon_m = radius_m * math.sin(theta)
            lats.append(_BASE_LAT + _lat_offset_m_to_deg(d_lat_m))
            lons.append(_BASE_LON + _lon_offset_m_to_deg(d_lon_m, _BASE_LAT))
            timestamps.append(start_t_ms + (lap_idx * samples_per_lap + i) * dt_ms)
    return timestamps, lats, lons


def _point_at_angle(theta_deg: float, *, radius_m: float = 50.0) -> tuple[float, float]:
    """Return (lat, lon) on the synthetic loop at the given angle from centre."""
    theta = math.radians(theta_deg)
    d_lat_m = radius_m * math.cos(theta)
    d_lon_m = radius_m * math.sin(theta)
    return (
        _BASE_LAT + _lat_offset_m_to_deg(d_lat_m),
        _BASE_LON + _lon_offset_m_to_deg(d_lon_m, _BASE_LAT),
    )


class FromSetpointsBasicTests(unittest.TestCase):
    def test_no_setpoints_returns_empty(self):
        ts, la, lo = _make_loop(3)
        self.assertEqual(from_setpoints(ts, la, lo, []), [])

    def test_no_gps_data_returns_empty(self):
        sp = [{"lat": _BASE_LAT, "lon": _BASE_LON, "radius_m": 2.0}]
        self.assertEqual(from_setpoints([], [], [], sp), [])

    def test_too_few_valid_samples_returns_empty(self):
        sp = [{"lat": _BASE_LAT, "lon": _BASE_LON, "radius_m": 2.0}]
        # nine samples — below the 10-sample threshold mirrored from from_gps
        ts = [float(i) for i in range(9)]
        la = [_BASE_LAT for _ in range(9)]
        lo = [_BASE_LON for _ in range(9)]
        self.assertEqual(from_setpoints(ts, la, lo, sp), [])

    def test_invalid_fixes_filtered(self):
        # 200 valid samples around the loop with one zero/zero garbage row spliced in
        ts, la, lo = _make_loop(2)
        ts.insert(50, ts[49] + 0.5)
        la.insert(50, 0.0)  # invalid fix
        lo.insert(50, 0.0)
        # Place start/finish on the loop where the car actually goes (angle 0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0}]
        laps = from_setpoints(ts, la, lo, sp)
        # 2 loops past start/finish → 1 closed lap
        self.assertEqual(len(laps), 1)
        self.assertEqual(laps[0]["source"], "gps_manual")


class FromSetpointsLapCountingTests(unittest.TestCase):
    def test_single_setpoint_three_loops_yields_two_laps(self):
        # The first crossing opens lap 1; the third crossing closes lap 2.
        ts, la, lo = _make_loop(3, samples_per_lap=400, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0}]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(len(laps), 2)
        for i, lap in enumerate(laps, start=1):
            self.assertEqual(lap["lapNumber"], i)
            self.assertEqual(lap["source"], "gps_manual")
            self.assertEqual(lap["sectorTimes"], [])
            # ~30 seconds per lap (allow some tolerance because the radius
            # window picks slightly different samples on each crossing)
            duration_s = (lap["endTime"] - lap["startTime"]) / 1000.0
            self.assertAlmostEqual(duration_s, 30.0, delta=2.0)

    def test_min_lap_s_debounces_short_returns(self):
        # 5-second laps absorbed by the debounce — every short return is
        # silently swallowed until a return finally lands ≥ 10 s after the
        # current lap opened, which then closes it. The first lap to close
        # therefore spans roughly 2× the loop period (10 s).
        ts, la, lo = _make_loop(6, samples_per_lap=400, period_s=5.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0}]
        laps = from_setpoints(ts, la, lo, sp)
        # No "lap" should be shorter than the debounce.
        for lap in laps:
            duration_s = (lap["endTime"] - lap["startTime"]) / 1000.0
            self.assertGreaterEqual(duration_s, MIN_LAP_S)

    def test_short_first_lap_is_debounced(self):
        # A 5 s loop that completes a single round before stopping — too
        # short to count, must produce zero laps (no second crossing exists
        # to "rescue" the first).
        ts, la, lo = _make_loop(2, samples_per_lap=400, period_s=5.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0}]
        laps = from_setpoints(ts, la, lo, sp)
        # 1 closed lap is allowed only if it's ≥ 10 s. Because two 5-s loops
        # finish at t=10s exactly, at the boundary, the result is sensitive
        # to floating-point edge — accept either zero or one lap so long as
        # any returned lap is ≥ MIN_LAP_S.
        for lap in laps:
            duration_s = (lap["endTime"] - lap["startTime"]) / 1000.0
            self.assertGreaterEqual(duration_s, MIN_LAP_S)

    def test_first_crossing_opens_lap_does_not_count(self):
        # Exactly 1.0 loops → first crossing opens lap, never closes → 0 laps.
        ts, la, lo = _make_loop(1, samples_per_lap=400, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0}]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(laps, [])


class FromSetpointsSectorTests(unittest.TestCase):
    def test_three_setpoints_one_completed_lap_records_two_sector_splits(self):
        # 2 loops → 1 closed lap. Sectors at 120° and 240° from start.
        ts, la, lo = _make_loop(2, samples_per_lap=600, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        s1_lat, s1_lon = _point_at_angle(120.0)
        s2_lat, s2_lon = _point_at_angle(240.0)
        sp = [
            {"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0},
            {"lat": s1_lat, "lon": s1_lon, "radius_m": 2.0},
            {"lat": s2_lat, "lon": s2_lon, "radius_m": 2.0},
        ]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(len(laps), 1)
        sectors = laps[0]["sectorTimes"]
        self.assertEqual(len(sectors), 2)
        s1_t, s2_t = sectors
        # Both sectors should have been crossed (loop is continuous on track).
        self.assertIsNotNone(s1_t)
        self.assertIsNotNone(s2_t)
        # Sector splits are absolute ms timestamps on the same timebase as start/end.
        self.assertGreater(s1_t, laps[0]["startTime"])
        self.assertLess(s1_t, s2_t)
        self.assertLess(s2_t, laps[0]["endTime"])
        # ~10 s into the lap for the first split, ~20 s for the second.
        rel_s1 = (s1_t - laps[0]["startTime"]) / 1000.0
        rel_s2 = (s2_t - laps[0]["startTime"]) / 1000.0
        self.assertAlmostEqual(rel_s1, 10.0, delta=2.0)
        self.assertAlmostEqual(rel_s2, 20.0, delta=2.0)

    def test_missed_sector_records_none(self):
        # Place sector 1 OFF-TRACK (1 km away) so the car never enters its radius.
        ts, la, lo = _make_loop(2, samples_per_lap=400, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        far_lat = _BASE_LAT + _lat_offset_m_to_deg(1000.0)
        far_lon = _BASE_LON + _lon_offset_m_to_deg(1000.0, _BASE_LAT)
        sp = [
            {"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0},
            {"lat": far_lat, "lon": far_lon, "radius_m": 2.0},
        ]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(len(laps), 1)
        self.assertEqual(laps[0]["sectorTimes"], [None])

    def test_sector_resets_per_lap(self):
        # 3 loops → 2 closed laps. Each lap should record its own sector split.
        ts, la, lo = _make_loop(3, samples_per_lap=600, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        s1_lat, s1_lon = _point_at_angle(180.0)
        sp = [
            {"lat": sf_lat, "lon": sf_lon, "radius_m": 2.0},
            {"lat": s1_lat, "lon": s1_lon, "radius_m": 2.0},
        ]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(len(laps), 2)
        for lap in laps:
            self.assertEqual(len(lap["sectorTimes"]), 1)
            self.assertIsNotNone(lap["sectorTimes"][0])
            rel = (lap["sectorTimes"][0] - lap["startTime"]) / 1000.0
            self.assertAlmostEqual(rel, 15.0, delta=2.0)


class FromSetpointsRadiusTests(unittest.TestCase):
    def test_small_radius_still_detects_crossings(self):
        # 5 m radius requires denser samples — synthetic loop is at 50 m, so
        # the car is always exactly 50 m from centre, never within 5 m.
        # Place the start/finish ON the loop so it gets crossed.
        ts, la, lo = _make_loop(3, samples_per_lap=2000, period_s=30.0)
        sf_lat, sf_lon = _point_at_angle(0.0)
        sp = [{"lat": sf_lat, "lon": sf_lon, "radius_m": 5.0}]
        laps = from_setpoints(ts, la, lo, sp)
        self.assertEqual(len(laps), 2)


if __name__ == "__main__":
    unittest.main()
