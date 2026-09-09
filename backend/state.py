"""
Shared application state and utility functions.

Used across route modules — import from here instead of duplicating.
"""

import asyncio
import logging
import math
import re
from datetime import datetime as _dt
from pathlib import Path
from typing import Optional

from libxrk import ChannelMetadata

from services import sync_service

logger = logging.getLogger("quickscope")

CHART_COLORS = [
    '#4361ee', '#f77f00', '#3de06a', '#a855f7', '#22d3ee',
    '#facc15', '#ec4899', '#06b6d4', '#84cc16', '#f43f5e',
    '#8b5cf6', '#10b981', '#fb923c', '#38bdf8', '#a3e635',
]


# ─── In-memory state (active session for analysis) ──────────────────────────

class SessionState:
    def __init__(self):
        self.log = None
        self.filename: Optional[str] = None
        self.session_id: Optional[str] = None

    def clear(self):
        self.log = None
        self.filename = None
        self.session_id = None

    @property
    def loaded(self) -> bool:
        return self.log is not None


state = SessionState()

# Guard against concurrent sync operations
_sync_lock = asyncio.Lock()


async def background_sync():
    if not sync_service.is_railway_configured():
        logger.debug("Background sync skipped: Railway URL not configured")
        return
    if _sync_lock.locked():
        return
    async with _sync_lock:
        try:
            await sync_service.sync_with_railway()
        except Exception:
            logger.exception("Background sync failed")


# ─── Utility functions ───────────────────────────────────────────────────────

def channel_meta(name: str, table) -> dict:
    field = table.schema.field(name)
    meta = ChannelMetadata.from_field(field)
    return {
        "units": meta.units or "",
        "function": meta.function or "",
        "source_type": meta.source_type,
    }


def channel_data(name: str, table) -> dict:
    df = table.to_pandas()
    timestamps = df['timecodes'].tolist()
    values = df[name].tolist()
    clean_vals = []
    for v in values:
        if isinstance(v, (int, float)) and math.isfinite(v):
            clean_vals.append(float(v))
        else:
            clean_vals.append(0.0)
    return {"timestamps": timestamps, "values": clean_vals}


def parse_file(file_path: str | Path):
    from parsers import parse_xrk
    return parse_xrk(file_path)


def extract_session_info(log, filename: str) -> dict:
    meta = log.metadata or {}
    metadata = {
        "vehicle": meta.get("Vehicle", ""),
        "driver": meta.get("Driver", ""),
        "date": meta.get("Log Date", ""),
        "time": meta.get("Log Time", ""),
        "venue": meta.get("Venue", ""),
        "championship": meta.get("Series", ""),
        "sessionType": meta.get("Session", ""),
        "comment": meta.get("Long Comment", ""),
    }

    channels = []
    total_samples = 0
    duration_ms = 0.0

    for i, (name, table) in enumerate(sorted(log.channels.items())):
        n_rows = table.num_rows
        total_samples += n_rows
        cm = channel_meta(name, table)

        sample_rate_hz = 0
        if n_rows > 0 and not name.lower().startswith("gps"):
            df = table.to_pandas()
            last_tc = float(df['timecodes'].iloc[-1])
            if last_tc < 36_000_000 and last_tc > duration_ms:
                duration_ms = last_tc
            if n_rows >= 2:
                dt = float(df['timecodes'].iloc[-1] - df['timecodes'].iloc[0])
                if dt > 0:
                    sample_rate_hz = round((n_rows - 1) / (dt / 1000), 1)

        channels.append({
            "name": name,
            "units": cm["units"],
            "sampleCount": n_rows,
            "sampleRateHz": sample_rate_hz,
            "color": CHART_COLORS[i % len(CHART_COLORS)],
            "index": i,
        })

    lap_count = log.laps.num_rows if log.laps is not None else 0

    return {
        "metadata": metadata,
        "channels": channels,
        "durationMs": duration_ms,
        "totalSamples": total_samples,
        "lapCount": lap_count,
        "recordedAt": parse_recorded_at(metadata["date"], metadata["time"]),
    }


def parse_recorded_at(date_str: str, time_str: str) -> Optional[str]:
    """Parse XRK 'Log Date' + 'Log Time' into an ISO-8601 datetime string."""
    if not date_str:
        return None
    for fmt in ("%d/%m/%Y", "%m/%d/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            d = _dt.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            continue
    else:
        return None
    if time_str:
        for tfmt in ("%H:%M:%S", "%H:%M"):
            try:
                t = _dt.strptime(time_str.strip(), tfmt)
                d = d.replace(hour=t.hour, minute=t.minute, second=t.second)
                break
            except ValueError:
                continue
    return d.isoformat()


def resolve_aim_recorded_at(
    device_date: str,
    device_hour: str,
    xrk_date: str,
    xrk_time: str,
) -> Optional[str]:
    """Prefer AiM device session-list date/hour over embedded XRK Log Date."""
    device_ts = parse_recorded_at(device_date, device_hour)
    if device_ts:
        xrk_ts = parse_recorded_at(xrk_date, xrk_time)
        if xrk_ts and xrk_ts != device_ts:
            logger.warning(
                "AiM device date %s %s differs from XRK Log Date %s %s; using device date",
                device_date,
                device_hour,
                xrk_date,
                xrk_time,
            )
        return device_ts
    return parse_recorded_at(xrk_date, xrk_time)


def format_recorded_at_display(recorded_at: str) -> tuple[str, str]:
    """Split an ISO-8601 recorded_at into AiM-style date and time strings."""
    try:
        d = _dt.fromisoformat(recorded_at)
    except ValueError:
        return "", ""
    return d.strftime("%d/%m/%Y"), d.strftime("%H:%M:%S")


def apply_stored_recorded_at(info: dict, recorded_at: Optional[str]) -> dict:
    """Override session info metadata with a stored recorded_at timestamp."""
    if not recorded_at:
        return info
    date_str, time_str = format_recorded_at_display(recorded_at)
    if not date_str:
        return info
    info = dict(info)
    info["metadata"] = dict(info["metadata"])
    info["metadata"]["date"] = date_str
    info["metadata"]["time"] = time_str
    info["recordedAt"] = recorded_at
    return info


def sanitize_filename(filename: str) -> str:
    """Strip directory components and dangerous characters from a filename."""
    safe = Path(filename).name
    safe = re.sub(r'[^\w\-.]', '_', safe)
    if not safe:
        raise ValueError("Invalid filename")
    return safe


def interpolate(timestamps, values, t):
    """Binary-search linear interpolation at timestamp t."""
    if not timestamps:
        return None
    if t <= timestamps[0]:
        return values[0]
    if t >= timestamps[-1]:
        return values[-1]
    lo, hi = 0, len(timestamps) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if timestamps[mid] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = timestamps[lo], timestamps[hi]
    if t1 == t0:
        return values[lo]
    frac = (t - t0) / (t1 - t0)
    return values[lo] + frac * (values[hi] - values[lo])
