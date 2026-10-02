"""
Per-session GPS thumbnail preview.

Extracts the GPS track from a session's .xrk file, downsamples it to a small
fixed-size point list, and normalizes the coordinates into a 0..1 unit
square. The frontend can render this directly as an SVG polyline next to
each session row without ever fetching the full GPS data.

Cached in memory keyed by (path, mtime) and on disk keyed by session_id so
restarts do not re-parse unchanged files.
"""

from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
from typing import Any, Optional, TypedDict

from parsers.parse_gate import PRIORITY_PREVIEW
from services import session_store
from services.session_cache import session_cache
from state import parse_file, state

logger = logging.getLogger(__name__)


PREVIEW_POINTS = 96
"""Target downsampled point count for the thumbnail polyline."""


class GPSPreview(TypedDict):
    points: list[list[float]]   # [[x, y], ...] in 0..1 normalized coords (y inverted for SVG)
    bounds: dict                # {"minLat": ..., "maxLat": ..., "minLon": ..., "maxLon": ...}
    pointCount: int             # original (pre-downsample) valid-fix count


_cache: dict[tuple[str, float], Optional[GPSPreview]] = {}


def _disk_cache_dir() -> Path:
    d = session_store.DATA_DIR / "cache" / "gps_preview"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _disk_cache_path(session_id: str) -> Path:
    safe = session_id.replace("/", "_").replace("\\", "_")
    return _disk_cache_dir() / f"{safe}.json"


def _file_fingerprint(p: Path) -> tuple[int, int]:
    st = p.stat()
    mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
    return mtime_ns, st.st_size


def _try_read_disk_cache(session_id: str | None, p: Path) -> tuple[bool, Optional[GPSPreview]]:
    if not session_id:
        return False, None
    path = _disk_cache_path(session_id)
    if not path.is_file():
        return False, None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        mtime_ns, size = _file_fingerprint(p)
        if raw.get("mtime_ns") != mtime_ns or raw.get("size") != size:
            return False, None
        preview = raw.get("preview")
        if preview is None:
            return True, None
        return True, preview
    except (json.JSONDecodeError, OSError, TypeError):
        logger.warning("Ignoring corrupt GPS preview cache %s", path)
        return False, None


def _write_disk_cache(session_id: str | None, p: Path, preview: Optional[GPSPreview]) -> None:
    if not session_id:
        return
    mtime_ns, size = _file_fingerprint(p)
    payload: dict[str, Any] = {
        "mtime_ns": mtime_ns,
        "size": size,
        "preview": preview,
    }
    dest = _disk_cache_path(session_id)
    tmp = dest.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, dest)
    except OSError:
        logger.exception("Failed to write GPS preview cache for %s", session_id)
        tmp.unlink(missing_ok=True)


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


def _preview_from_log(log) -> Optional[GPSPreview]:
    channels = log.channels
    lat_name = next((n for n in channels if "latitude" in n.lower()), None)
    lon_name = next((n for n in channels if "longitude" in n.lower()), None)
    if not lat_name or not lon_name:
        return None

    lat_table = channels[lat_name].to_pandas()
    lon_table = channels[lon_name].to_pandas()

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
        return None

    min_lat = min(v[0] for v in valid)
    max_lat = max(v[0] for v in valid)
    min_lon = min(v[1] for v in valid)
    max_lon = max(v[1] for v in valid)
    lat_span = max_lat - min_lat
    lon_span = max_lon - min_lon
    if lat_span < 1e-7 or lon_span < 1e-7:
        return None

    lon_m, lat_m = _haversine_aspect(min_lat, max_lat, min_lon, max_lon)
    span_m = max(lon_m, lat_m)
    if span_m <= 0:
        return None

    downsampled = _downsample(valid, PREVIEW_POINTS)

    def _normalize(la: float, lo: float) -> tuple[float, float]:
        x_m = (lo - min_lon) * 111_320.0 * math.cos(math.radians((min_lat + max_lat) / 2))
        y_m = (la - min_lat) * 111_320.0
        cx = (span_m - lon_m) / 2
        cy = (span_m - lat_m) / 2
        x = (x_m + cx) / span_m
        y = 1.0 - (y_m + cy) / span_m
        return x, y

    points = [list(_normalize(la, lo)) for la, lo in downsampled]
    return {
        "points": points,
        "bounds": {
            "minLat": min_lat,
            "maxLat": max_lat,
            "minLon": min_lon,
            "maxLon": max_lon,
        },
        "pointCount": len(valid),
    }


def warm_from_log(session_id: str, local_path: str | Path, log) -> None:
    """Persist a GPS preview after an interactive parse (upload / pull)."""
    p = Path(local_path)
    if not p.is_file():
        return
    preview = _preview_from_log(log)
    key = (str(p), p.stat().st_mtime)
    _cache[key] = preview
    _write_disk_cache(session_id, p, preview)


def compute_preview(
    local_path: str | Path,
    session_id: str | None = None,
) -> Optional[GPSPreview]:
    p = Path(local_path)
    if not p.exists():
        return None

    hit, disk_preview = _try_read_disk_cache(session_id, p)
    if hit:
        key = (str(p), p.stat().st_mtime)
        _cache[key] = disk_preview
        return disk_preview

    key = (str(p), p.stat().st_mtime)
    if key in _cache:
        return _cache[key]

    try:
        log = None
        if session_id:
            cached = session_cache.get_valid(session_id, p)
            if cached is not None:
                log = cached[0]
        if log is None and (
            state.loaded
            and state.filename == p.name
            and state.log is not None
        ):
            log = state.log
        if log is None:
            log = parse_file(p, priority=PRIORITY_PREVIEW)
    except Exception:
        logger.exception("Failed to parse %s for GPS preview", p)
        _cache[key] = None
        _write_disk_cache(session_id, p, None)
        return None

    preview = _preview_from_log(log)
    _cache[key] = preview
    _write_disk_cache(session_id, p, preview)
    return preview
