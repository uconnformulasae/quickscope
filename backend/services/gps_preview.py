"""
Per-session GPS thumbnail preview.

Extracts the GPS track from a session's .xrk file, downsamples it to a small
fixed-size point list, and normalizes the coordinates into a 0..1 unit
square. The frontend can render this directly as an SVG polyline next to
each session row without ever fetching the full GPS data.

Computed on first request, cached in memory keyed by (session_id, mtime) so
the cache invalidates if the file is replaced.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Optional, TypedDict

from libxrk import aim_xrk

logger = logging.getLogger(__name__)


PREVIEW_POINTS = 96
"""Target downsampled point count for the thumbnail polyline."""


class GPSPreview(TypedDict):
    points: list[list[float]]   # [[x, y], ...] in 0..1 normalized coords (y inverted for SVG)
    bounds: dict                # {"minLat": ..., "maxLat": ..., "minLon": ..., "maxLon": ...}
    pointCount: int             # original (pre-downsample) valid-fix count


_cache: dict[tuple[str, float], Optional[GPSPreview]] = {}


def _haversine_aspect(min_lat: float, max_lat: float, min_lon: float, max_lon: float) -> tuple[float, float]:
    """
    Return (lon_span_m, lat_span_m). Used to keep the thumbnail's aspect ratio
    correct: longitude degrees compress as latitude moves away from the equator.
    """
    mid_lat = (min_lat + max_lat) / 2
    lat_m = (max_lat - min_lat) * 111_320.0
    lon_m = (max_lon - min_lon) * 111_320.0 * math.cos(math.radians(mid_lat))
    return lon_m, lat_m


def _downsample(values: list[tuple[float, float]], target: int) -> list[tuple[float, float]]:
    if len(values) <= target:
        return values
    step = len(values) / target
    return [values[int(i * step)] for i in range(target)]


def compute_preview(local_path: str | Path) -> Optional[GPSPreview]:
    p = Path(local_path)
    if not p.exists():
        return None

    key = (str(p), p.stat().st_mtime)
    if key in _cache:
        return _cache[key]

    try:
        log = aim_xrk(str(p))
    except Exception:
        logger.exception("Failed to parse %s for GPS preview", p)
        _cache[key] = None
        return None

    channels = log.channels
    lat_name = next((n for n in channels if "latitude" in n.lower()), None)
    lon_name = next((n for n in channels if "longitude" in n.lower()), None)
    if not lat_name or not lon_name:
        _cache[key] = None
        return None

    lat_table = channels[lat_name].to_pandas()
    lon_table = channels[lon_name].to_pandas()

    # Pair lat+lon by index (assume same timebase, same row count — this is
    # how libxrk emits the derived GPS channels).
    n = min(len(lat_table), len(lon_table))
    valid: list[tuple[float, float]] = []
    for i in range(n):
        la = float(lat_table[lat_name].iloc[i])
        lo = float(lon_table[lon_name].iloc[i])
        if (
            math.isfinite(la)
            and math.isfinite(lo)
            and abs(la) > 0.1
            and abs(lo) > 0.1
        ):
            valid.append((la, lo))
    if len(valid) < 4:
        _cache[key] = None
        return None

    min_lat = min(v[0] for v in valid)
    max_lat = max(v[0] for v in valid)
    min_lon = min(v[1] for v in valid)
    max_lon = max(v[1] for v in valid)
    lat_span = max_lat - min_lat
    lon_span = max_lon - min_lon
    if lat_span < 1e-7 or lon_span < 1e-7:
        # Stationary "fix" — useless preview
        _cache[key] = None
        return None

    # Aspect-correct: scale the smaller span up so the thumbnail isn't squashed.
    lon_m, lat_m = _haversine_aspect(min_lat, max_lat, min_lon, max_lon)
    span_m = max(lon_m, lat_m)
    if span_m <= 0:
        _cache[key] = None
        return None

    downsampled = _downsample(valid, PREVIEW_POINTS)

    # Map (lon, lat) → (x, y) in 0..1 with y inverted for SVG. We expand the
    # smaller axis to span_m so the bounding box is square; the polyline will
    # be centered within it.
    def _normalize(la: float, lo: float) -> tuple[float, float]:
        # x: longitude axis (m offset) / span_m
        x_m = (lo - min_lon) * 111_320.0 * math.cos(math.radians((min_lat + max_lat) / 2))
        y_m = (la - min_lat) * 111_320.0
        cx = (span_m - lon_m) / 2
        cy = (span_m - lat_m) / 2
        x = (x_m + cx) / span_m
        y = 1.0 - (y_m + cy) / span_m  # SVG y grows downward
        return x, y

    points = [list(_normalize(la, lo)) for la, lo in downsampled]
    preview: GPSPreview = {
        "points": points,
        "bounds": {
            "minLat": min_lat,
            "maxLat": max_lat,
            "minLon": min_lon,
            "maxLon": max_lon,
        },
        "pointCount": len(valid),
    }
    _cache[key] = preview
    return preview
