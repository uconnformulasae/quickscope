"""
Lap detection — three-tier fallback.

1. Device markers from libxrk (state.log.laps). Source = "device".
2. GPS close-the-loop detection. Source = "gps_auto".
   The car's first valid GPS fix is taken as the start/finish point. We
   detect a lap when the car returns within RETURN_RADIUS_M of the start
   AFTER having travelled at least DEPARTURE_RADIUS_M away. A minimum
   lap-time guard (MIN_LAP_S) prevents false positives at slow first
   crossings.
3. Beacon channel detection. Source = "beacon_auto".
   AiM devices often log a "Beacon" or "Lap Beacon" channel that pulses
   at the start/finish line. Look for falling/rising edges — exact polarity
   varies — and treat each pulse as a lap boundary.

Each result row is `{lapNumber, startTime, endTime, source}` so the frontend
can label where each lap came from.
"""

from __future__ import annotations

import logging
import math
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


# GPS detection tuning — these defaults are chosen for FSAE-scale autocross
# tracks (1.0–1.5 km). For long road-course sessions these may need tuning.
DEPARTURE_RADIUS_M = 30.0   # must travel this far from start before a return counts
RETURN_RADIUS_M = 15.0      # then re-enter this radius to register a lap
MIN_LAP_S = 10.0            # ignore "laps" shorter than this (debounce)
EARTH_R_M = 6_371_000.0


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres. Inputs in degrees."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def from_device(log) -> list[dict]:
    """Return device-reported laps if present, tagged source='device'."""
    if log.laps is None or log.laps.num_rows == 0:
        return []
    out = []
    for i in range(log.laps.num_rows):
        out.append({
            "lapNumber": log.laps.column("num")[i].as_py(),
            "startTime": log.laps.column("start_time")[i].as_py(),
            "endTime": log.laps.column("end_time")[i].as_py(),
            "source": "device",
        })
    return out


def from_gps(
    timestamps_ms: list[float],
    lats: list[float],
    lons: list[float],
    departure_m: float = DEPARTURE_RADIUS_M,
    return_m: float = RETURN_RADIUS_M,
    min_lap_s: float = MIN_LAP_S,
) -> list[dict]:
    """Detect laps by close-the-loop on GPS coordinates.

    `timestamps_ms` should be session-relative milliseconds (i.e. already
    offset so the first sample is ~0). Lats/lons are in degrees.
    Invalid fixes (lat≈0 and lon≈0, or non-finite) are dropped before
    detection.
    """
    valid: list[tuple[float, float, float]] = []
    for t, la, lo in zip(timestamps_ms, lats, lons):
        if abs(la) > 0.1 and abs(lo) > 0.1 and math.isfinite(la) and math.isfinite(lo):
            valid.append((t, la, lo))
    if len(valid) < 10:
        return []

    start_t, start_lat, start_lon = valid[0]
    has_departed = False
    last_crossing_t = start_t
    laps: list[dict] = []
    lap_num = 1
    prev_dist = 0.0

    for t, la, lo in valid[1:]:
        dist = _haversine_m(start_lat, start_lon, la, lo)
        if not has_departed:
            if dist > departure_m:
                has_departed = True
        else:
            # Look for a falling edge into the return-radius zone — i.e. the
            # sample where we cross from outside RETURN_RADIUS to inside.
            if prev_dist > return_m and dist <= return_m:
                lap_time_s = (t - last_crossing_t) / 1000.0
                if lap_time_s >= min_lap_s:
                    laps.append({
                        "lapNumber": lap_num,
                        "startTime": last_crossing_t,
                        "endTime": t,
                        "source": "gps_auto",
                    })
                    lap_num += 1
                    last_crossing_t = t
                    has_departed = False  # reset for next lap
        prev_dist = dist

    return laps


def from_setpoints(
    timestamps_ms: list[float],
    lats: list[float],
    lons: list[float],
    setpoints: list[dict],
    min_lap_s: float = MIN_LAP_S,
) -> list[dict]:
    """Detect laps and sector splits from user-defined GPS setpoints.

    `setpoints[0]` is the start/finish line; `setpoints[1:]` are sector
    splits in order. Each setpoint is `{"lat": float, "lon": float,
    "radius_m": float}`.

    Lap counting mirrors `from_gps` but uses the user's pin instead of
    the first GPS fix: the first crossing of `setpoints[0]` opens lap 1,
    each subsequent return crossing closes a lap and opens the next.
    Departure radius is `2 × radius_m`. `min_lap_s` debounces the
    start/finish pin only.

    Sector splits: for each sector pin (i ≥ 1), record the first sample
    in the current lap that enters the pin's radius. Missed sectors stay
    `None`. Returned rows include a `sectorTimes` list of length
    `len(setpoints) - 1`.
    """
    if not setpoints:
        return []

    valid: list[tuple[float, float, float]] = []
    for t, la, lo in zip(timestamps_ms, lats, lons):
        if abs(la) > 0.1 and abs(lo) > 0.1 and math.isfinite(la) and math.isfinite(lo):
            valid.append((t, la, lo))
    if len(valid) < 10:
        return []

    sf = setpoints[0]
    sf_lat = float(sf["lat"])
    sf_lon = float(sf["lon"])
    sf_return = float(sf["radius_m"])
    sf_depart = sf_return * 2.0

    sector_pins = setpoints[1:]
    n_sectors = len(sector_pins)

    laps: list[dict] = []
    lap_open = False
    lap_start_t: float | None = None
    lap_num = 1
    has_departed = False
    prev_sf_dist: float | None = None
    cur_sector_times: list[float | None] = [None] * n_sectors
    prev_sector_dists: list[float | None] = [None] * n_sectors

    for t, la, lo in valid:
        sf_dist = _haversine_m(sf_lat, sf_lon, la, lo)

        if not lap_open:
            if prev_sf_dist is not None and prev_sf_dist > sf_return and sf_dist <= sf_return:
                lap_open = True
                lap_start_t = t
                has_departed = False
                cur_sector_times = [None] * n_sectors
                prev_sector_dists = [None] * n_sectors
        else:
            for i, pin in enumerate(sector_pins):
                pin_radius = float(pin["radius_m"])
                d = _haversine_m(float(pin["lat"]), float(pin["lon"]), la, lo)
                prev_d = prev_sector_dists[i]
                if (
                    cur_sector_times[i] is None
                    and prev_d is not None
                    and prev_d > pin_radius
                    and d <= pin_radius
                ):
                    cur_sector_times[i] = t
                prev_sector_dists[i] = d

            if not has_departed:
                if sf_dist > sf_depart:
                    has_departed = True
            else:
                if (
                    prev_sf_dist is not None
                    and prev_sf_dist > sf_return
                    and sf_dist <= sf_return
                ):
                    lap_time_s = (t - lap_start_t) / 1000.0
                    if lap_time_s >= min_lap_s:
                        laps.append({
                            "lapNumber": lap_num,
                            "startTime": lap_start_t,
                            "endTime": t,
                            "source": "gps_manual",
                            "sectorTimes": list(cur_sector_times),
                        })
                        lap_num += 1
                        lap_start_t = t
                        has_departed = False
                        cur_sector_times = [None] * n_sectors
                        prev_sector_dists = [None] * n_sectors

        prev_sf_dist = sf_dist

    return laps


def from_beacon(
    timestamps_ms: list[float],
    values: list[float],
    threshold: Optional[float] = None,
    min_lap_s: float = MIN_LAP_S,
) -> list[dict]:
    """Detect laps from a digital-ish beacon channel.

    The channel is treated as binary around its midpoint (auto-thresholded if
    `threshold` is None). Each rising edge that occurs at least `min_lap_s`
    after the previous one is treated as a lap boundary.
    """
    if len(values) < 10:
        return []
    if threshold is None:
        lo, hi = min(values), max(values)
        if hi - lo < 1e-6:
            return []
        threshold = lo + (hi - lo) * 0.5

    laps: list[dict] = []
    last_t = timestamps_ms[0]
    lap_num = 1
    prev_high = values[0] >= threshold

    for t, v in zip(timestamps_ms[1:], values[1:]):
        is_high = v >= threshold
        if is_high and not prev_high:
            lap_time_s = (t - last_t) / 1000.0
            if lap_time_s >= min_lap_s:
                laps.append({
                    "lapNumber": lap_num,
                    "startTime": last_t,
                    "endTime": t,
                    "source": "beacon_auto",
                })
                lap_num += 1
                last_t = t
        prev_high = is_high

    return laps


def detect_laps(
    log,
    channel_data_fn,
    setpoints: Optional[list[dict]] = None,
) -> tuple[list[dict], str]:
    """Run the full fallback chain.

    `channel_data_fn(name)` is a callable that returns
    {'timestamps': [...], 'values': [...]} for a channel name (or None if
    the channel does not exist). This lets callers pass in the existing
    `channel_data` helper without us depending on libxrk types directly.

    `setpoints` is the user-defined GPS setpoints list. When non-empty it
    overrides the cascade: lap detection runs `from_setpoints` and the
    result is returned with source `'gps_manual'` even if no laps are
    detected (the explicit user choice should not silently revert).

    Returns (laps, source) where source is one of:
        'device'        — device-reported markers (preferred)
        'gps_manual'    — user-defined GPS setpoints (override)
        'gps_auto'      — GPS close-the-loop fallback
        'beacon_auto'   — beacon channel fallback
        'none'          — no laps could be detected
    """
    if setpoints:
        ch_names = list(log.channels.keys())
        lat_name = next((n for n in ch_names if "latitude" in n.lower()), None)
        lon_name = next((n for n in ch_names if "longitude" in n.lower()), None)
        manual_laps: list[dict] = []
        if lat_name and lon_name:
            try:
                lat_data = channel_data_fn(lat_name)
                lon_data = channel_data_fn(lon_name)
            except Exception:
                logger.exception("GPS channel read failed during manual lap detection")
                lat_data = lon_data = None
            if lat_data and lon_data and lat_data["timestamps"]:
                # Use session-relative timestamps to match from_gps's
                # timebase, since the frontend already handles that one.
                ts = lat_data["timestamps"]
                ts_offset = min(ts)
                ts_rel = [t - ts_offset for t in ts]
                manual_laps = from_setpoints(ts_rel, lat_data["values"], lon_data["values"], setpoints)
        return manual_laps, "gps_manual"

    device = from_device(log)
    if device:
        return device, "device"

    # GPS fallback
    ch_names = list(log.channels.keys())
    lat_name = next((n for n in ch_names if "latitude" in n.lower()), None)
    lon_name = next((n for n in ch_names if "longitude" in n.lower()), None)
    if lat_name and lon_name:
        try:
            lat_data = channel_data_fn(lat_name)
            lon_data = channel_data_fn(lon_name)
        except Exception:
            logger.exception("GPS channel read failed during lap detection")
            lat_data = lon_data = None
        if lat_data and lon_data and lat_data["timestamps"]:
            ts = lat_data["timestamps"]
            ts_offset = min(ts)
            ts_rel = [t - ts_offset for t in ts]
            gps_laps = from_gps(ts_rel, lat_data["values"], lon_data["values"])
            if gps_laps:
                return gps_laps, "gps_auto"

    # Beacon-channel fallback
    beacon_name = next(
        (n for n in ch_names if "beacon" in n.lower()),
        None,
    )
    if beacon_name:
        try:
            bd = channel_data_fn(beacon_name)
        except Exception:
            logger.exception("Beacon channel read failed during lap detection")
            bd = None
        if bd and bd["timestamps"]:
            beacon_laps = from_beacon(bd["timestamps"], bd["values"])
            if beacon_laps:
                return beacon_laps, "beacon_auto"

    return [], "none"
