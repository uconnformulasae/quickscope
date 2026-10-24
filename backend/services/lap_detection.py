"""
Lap detection — three-tier fallback.

1. Device markers from libxrk (state.log.laps). Source = "device".
2. GPS close-the-loop detection. Source = "gps_auto".
   The reference point is the track position the car passes most often --
   NOT the first fix, which is usually the pit box or paddock the logger was
   powered on in. A crossing is a return within RETURN_RADIUS_M of the
   reference AFTER having travelled at least DEPARTURE_RADIUS_M away. Lap 1
   starts at the first crossing, so the out-lap is not counted. A minimum
   lap-time guard (MIN_LAP_S) prevents false positives at slow crossings.
3. Beacon channel detection. Source = "beacon_auto".
   AiM devices often log a "Beacon" or "Lap Beacon" channel that pulses
   at the start/finish line. Each rising edge is a line crossing; lap 1 runs
   from the first pulse to the second (time before the first pulse is the
   out-lap).

Each result row is `{lapNumber, startTime, endTime, source}` so the frontend
can label where each lap came from.
"""

from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


# GPS detection tuning — these defaults are chosen for FSAE-scale autocross
# tracks (1.0–1.5 km). For long road-course sessions these may need tuning.
DEPARTURE_RADIUS_M = 30.0   # must travel this far from start before a return counts
RETURN_RADIUS_M = 15.0      # then re-enter this radius to register a lap
MIN_LAP_S = 10.0            # ignore "laps" shorter than this (debounce)
EARTH_R_M = 6_371_000.0
MAX_REFERENCE_CANDIDATES = 400  # trajectory points tried as start/finish


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres. Inputs in degrees."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def _count_crossings(dist_m: np.ndarray, departure_m: float, return_m: float) -> int:
    """How many depart-then-return passes a distance-to-reference series has."""
    # 0 = inside the return radius, 2 = beyond the departure radius; the band
    # in between never changes state, so drop it. A crossing is then a 2 -> 0.
    codes = np.where(dist_m <= return_m, 0, np.where(dist_m > departure_m, 2, 1))
    codes = codes[codes != 1]
    if len(codes) < 2:
        return 0
    return int(np.count_nonzero((codes[:-1] == 2) & (codes[1:] == 0)))


def _pick_reference(
    valid: list[tuple[float, float, float]],
    departure_m: float,
    return_m: float,
) -> tuple[float, float]:
    """A start/finish reference point that lies on the racing line.

    Candidates are spaced evenly by distance driven, so time parked in the
    pits contributes one candidate rather than hundreds. Each candidate's
    depart-and-return count is computed; points on the racing line share the
    same count (one per lap), so the most common non-zero count is the lap
    count. That deliberately ignores the maximum, which belongs to spots where
    two parts of the track run within ``return_m`` of each other and would
    split every lap in two. Among candidates with that count, the earliest
    wins -- the first track point after leaving the pits.
    """
    lats = np.array([v[1] for v in valid])
    lons = np.array([v[2] for v in valid])
    # Equirectangular projection: plenty accurate at track scale.
    k = math.radians(1.0) * EARTH_R_M
    ys = lats * k
    xs = lons * k * math.cos(math.radians(float(lats.mean())))

    travelled = np.concatenate(([0.0], np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))))
    marks = np.linspace(0.0, travelled[-1], MAX_REFERENCE_CANDIDATES, endpoint=False)
    candidates = np.unique(np.searchsorted(travelled, marks))

    counts = [
        _count_crossings(np.hypot(xs - xs[i], ys - ys[i]), departure_m, return_m)
        for i in candidates
    ]
    nonzero = [c for c in counts if c > 0]
    if not nonzero:
        return valid[0][1], valid[0][2]
    values, freq = np.unique(nonzero, return_counts=True)
    lap_count = int(values[freq == freq.max()].max())
    best = int(candidates[counts.index(lap_count)])
    return valid[best][1], valid[best][2]


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
    Invalid fixes (lat≈0 and lon≈0, missing, or non-finite) are dropped before
    detection.
    """
    valid: list[tuple[float, float, float]] = []
    for t, la, lo in zip(timestamps_ms, lats, lons):
        if la is None or lo is None:
            continue  # dropout
        if abs(la) > 0.1 and abs(lo) > 0.1 and math.isfinite(la) and math.isfinite(lo):
            valid.append((t, la, lo))
    if len(valid) < 10:
        return []

    ref_lat, ref_lon = _pick_reference(valid, departure_m, return_m)
    first_t, first_lat, first_lon = valid[0]
    prev_dist = _haversine_m(ref_lat, ref_lon, first_lat, first_lon)
    has_departed = False
    # Starting on the line counts as the first crossing; otherwise lap timing
    # begins at the first crossing and everything before it is the out-lap.
    last_crossing_t: Optional[float] = first_t if prev_dist <= return_m else None
    laps: list[dict] = []
    lap_num = 1

    for t, la, lo in valid[1:]:
        dist = _haversine_m(ref_lat, ref_lon, la, lo)
        if not has_departed:
            if dist > departure_m:
                has_departed = True
        else:
            # Look for a falling edge into the return-radius zone — i.e. the
            # sample where we cross from outside RETURN_RADIUS to inside.
            if prev_dist > return_m and dist <= return_m:
                if last_crossing_t is None:
                    last_crossing_t = t
                    has_departed = False
                    prev_dist = dist
                    continue
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


def from_beacon(
    timestamps_ms: list[float],
    values: list[float],
    threshold: Optional[float] = None,
    min_lap_s: float = MIN_LAP_S,
) -> list[dict]:
    """Detect laps from a digital-ish beacon channel.

    The channel is treated as binary around its midpoint (auto-thresholded if
    `threshold` is None). Each rising edge that occurs at least `min_lap_s`
    after the previous one is treated as a lap boundary. Timing starts at the
    first edge -- the logger was usually switched on in the pits, so the time
    before it is the out-lap, not lap 1.
    """
    clean: list[tuple[float, float]] = []
    for t, v in zip(timestamps_ms, values):
        if t is not None and v is not None and math.isfinite(t) and math.isfinite(v):
            clean.append((float(t), float(v)))
    if len(clean) < 10:
        return []
    if threshold is None:
        c_vals = [v for _, v in clean]
        lo, hi = min(c_vals), max(c_vals)
        if hi - lo < 1e-6:
            return []
        threshold = lo + (hi - lo) * 0.5

    laps: list[dict] = []
    last_t: Optional[float] = None
    lap_num = 1
    prev_high = clean[0][1] >= threshold

    for t, v in clean[1:]:
        is_high = v >= threshold
        if is_high and not prev_high:
            if last_t is None:
                last_t = t
                prev_high = is_high
                continue
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


def detect_laps(log, channel_data_fn) -> tuple[list[dict], str]:
    """Run the full fallback chain.

    `channel_data_fn(name)` is a callable that returns
    {'timestamps': [...], 'values': [...]} for a channel name (or None if
    the channel does not exist). This lets callers pass in the existing
    `channel_data` helper without us depending on libxrk types directly.

    Returns (laps, source) where source is one of:
        'device'        — device-reported markers (preferred)
        'gps_auto'      — GPS close-the-loop fallback
        'beacon_auto'   — beacon channel fallback
        'none'          — no laps could be detected
    """
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
        if lat_data and lon_data and lat_data.get("timestamps") and lon_data.get("timestamps"):
            n = min(
                len(lat_data["timestamps"]),
                len(lat_data["values"]),
                len(lon_data["timestamps"]),
                len(lon_data["values"]),
            )
            if n >= 10:
                ts = lat_data["timestamps"][:n]
                ts_offset = min(ts)
                ts_rel = [t - ts_offset for t in ts]
                gps_laps = from_gps(ts_rel, lat_data["values"][:n], lon_data["values"][:n])
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
        if bd and bd.get("timestamps") and bd.get("values"):
            beacon_laps = from_beacon(bd["timestamps"], bd["values"])
            if beacon_laps:
                return beacon_laps, "beacon_auto"

    return [], "none"
