"""
QuickScope — Python/libxrk backend
Parses .xrk files using libxrk and serves channel data via FastAPI.
Multi-session with local persistence and Railway/AiM sync.
"""

import asyncio
import io
import csv
import logging
import math
import re
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Query, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from libxrk import aim_xrk, ChannelMetadata

from services import session_store, settings_store, sync_service, aim_connector, railway_client

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("quickscope")

app = FastAPI(title="QuickScope Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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


def _channel_meta(name: str, table) -> dict:
    field = table.schema.field(name)
    meta = ChannelMetadata.from_field(field)
    return {
        "units": meta.units or "",
        "function": meta.function or "",
        "source_type": meta.source_type,
    }


def _channel_data(name: str, table) -> dict:
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


def _parse_file(file_path: str | Path):
    return aim_xrk(str(file_path))


def _extract_session_info(log, filename: str) -> dict:
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
        cm = _channel_meta(name, table)

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
    }


def _sanitize_filename(filename: str) -> str:
    """Strip directory components and dangerous characters from a filename."""
    safe = Path(filename).name
    safe = re.sub(r'[^\w\-.]', '_', safe)
    if not safe:
        raise ValueError("Invalid filename")
    return safe


# ─── Session Management Endpoints ──────────────────────────────────────────

@app.get("/api/sessions")
async def list_sessions():
    return session_store.list_sessions()


@app.post("/api/sessions/{session_id}/load")
async def load_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = entry.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    try:
        log = _parse_file(local_path)
        state.log = log
        state.filename = entry["filename"]
        state.session_id = session_id
    except Exception:
        state.clear()
        logger.exception("Failed to parse session file")
        raise HTTPException(500, "Failed to parse session file")

    return _extract_session_info(log, entry["filename"])


@app.post("/api/sessions/sync")
async def sync_sessions():
    try:
        result = await sync_service.sync_with_railway()
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        logger.exception("Sync failed")
        raise HTTPException(500, "Sync failed")


@app.post("/api/sessions/{session_id}/pull")
async def pull_session(session_id: str):
    result = await sync_service.pull_session(session_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "Pull failed"))
    return result


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = entry.get("local_path")
    if local_path:
        Path(local_path).unlink(missing_ok=True)

    if state.session_id == session_id:
        state.clear()

    session_store.delete_session(session_id)
    return {"ok": True}


# ─── AiM Device Endpoints ──────────────────────────────────────────────────

@app.get("/api/aim/status")
async def aim_status():
    connected = await asyncio.to_thread(aim_connector.is_aim_connected)
    device_info = None
    if connected:
        device_info = await asyncio.to_thread(aim_connector.discover_device)
    return {"connected": connected, "device": device_info}


@app.get("/api/aim/sessions")
async def list_aim_sessions():
    connected = await asyncio.to_thread(aim_connector.is_aim_connected)
    if not connected:
        return {"ok": False, "sessions": [], "error": "AiM device not reachable"}

    sessions = await asyncio.to_thread(aim_connector.list_aim_sessions)

    local_sessions = session_store.list_sessions()
    local_filenames = {s["filename"] for s in local_sessions}

    for s in sessions:
        s["already_downloaded"] = s["filename"] in local_filenames

    return {"ok": True, "sessions": sessions}


class AimPullRequest(BaseModel):
    filenames: list[str]


@app.post("/api/aim/pull")
async def pull_from_aim(body: AimPullRequest, background_tasks: BackgroundTasks):
    connected = await asyncio.to_thread(aim_connector.is_aim_connected)
    if not connected:
        raise HTTPException(400, "AiM device not reachable")

    if not body.filenames:
        return {"ok": False, "error": "No files selected", "downloaded": []}

    logger.info("AiM pull: downloading %d selected sessions...", len(body.filenames))

    downloaded = []
    errors = []
    for raw_filename in body.filenames:
        try:
            filename = _sanitize_filename(raw_filename)
        except ValueError:
            errors.append(f"{raw_filename}: invalid filename")
            continue

        logger.info("AiM pull: downloading %s ...", filename)
        try:
            dest = session_store.session_file_path(filename)
            await asyncio.to_thread(aim_connector.download_aim_session, filename, dest.parent)
            logger.info("AiM pull: saved %s (%d bytes)", dest, dest.stat().st_size)

            try:
                log = _parse_file(dest)
                info = _extract_session_info(log, filename)
                meta = info["metadata"]
            except Exception as parse_err:
                logger.warning("AiM pull: parse failed for %s: %s", filename, parse_err)
                meta = {}
                info = {"durationMs": 0, "lapCount": 0}

            entry = session_store.add_session(
                filename=filename,
                source="aim_device",
                sync_status="local_only",
                local_path=str(dest),
                track_name=meta.get("venue", ""),
                driver_name=meta.get("driver", ""),
                vehicle_name=meta.get("vehicle", ""),
                duration_s=info.get("durationMs", 0) / 1000,
                lap_count=info.get("lapCount", 0),
            )
            downloaded.append(entry["filename"])
        except Exception as e:
            logger.error("AiM pull: failed to download %s: %s", filename, e, exc_info=True)
            errors.append(f"{filename}: {e}")

    if downloaded:
        background_tasks.add_task(_background_sync)

    return {"ok": True, "downloaded": downloaded, "errors": errors}


async def _background_sync():
    if _sync_lock.locked():
        return
    async with _sync_lock:
        try:
            await sync_service.sync_with_railway()
        except Exception:
            logger.exception("Background sync failed")


# ─── Settings Endpoints ────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_settings():
    return settings_store.load()


@app.put("/api/settings")
async def update_settings(body: dict):
    return settings_store.update(body)


# ─── Original Endpoints (analysis — operate on loaded session) ──────────────

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), background_tasks: BackgroundTasks = None):
    if not file.filename or not file.filename.lower().endswith((".xrk", ".xrz")):
        raise HTTPException(400, "Only .xrk/.xrz files are supported")

    filename = _sanitize_filename(file.filename)
    content = await file.read()

    # Save to local cache first, then parse from there (avoids temp file issues)
    dest = session_store.session_file_path(filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)

    try:
        log = _parse_file(dest)
        state.log = log
        state.filename = filename
    except Exception:
        dest.unlink(missing_ok=True)
        state.clear()
        logger.exception("Failed to parse uploaded file")
        raise HTTPException(500, "Failed to parse file")

    info = _extract_session_info(log, filename)
    meta = info["metadata"]

    # Check for duplicate
    existing = session_store.find_by_filename(filename)
    if existing:
        state.session_id = existing["id"]
        if background_tasks:
            background_tasks.add_task(_background_sync)
        return info

    entry = session_store.add_session(
        filename=filename,
        source="manual_upload",
        sync_status="local_only",
        local_path=str(dest),
        track_name=meta.get("venue", ""),
        driver_name=meta.get("driver", ""),
        vehicle_name=meta.get("vehicle", ""),
        duration_s=info["durationMs"] / 1000,
        lap_count=info["lapCount"],
    )
    state.session_id = entry["id"]

    if background_tasks:
        background_tasks.add_task(_background_sync)

    return info


@app.get("/api/channels")
async def get_channels():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")
    channels = []
    for i, (name, table) in enumerate(sorted(state.log.channels.items())):
        cm = _channel_meta(name, table)
        channels.append({
            "name": name,
            "units": cm["units"],
            "sampleCount": table.num_rows,
            "color": CHART_COLORS[i % len(CHART_COLORS)],
            "index": i,
        })
    return {"channels": channels}


@app.get("/api/data")
async def get_channel_data(channels: str = Query(...)):
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    names = [n.strip() for n in channels.split(",") if n.strip()]
    result = {}
    for name in names:
        if name in state.log.channels:
            result[name] = _channel_data(name, state.log.channels[name])
    return result


@app.get("/api/laps")
async def get_laps():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    laps = []
    if state.log.laps is not None and state.log.laps.num_rows > 0:
        for i in range(state.log.laps.num_rows):
            laps.append({
                "lapNumber": state.log.laps.column("num")[i].as_py(),
                "startTime": state.log.laps.column("start_time")[i].as_py(),
                "endTime": state.log.laps.column("end_time")[i].as_py(),
            })
    return {"laps": laps}


@app.get("/api/gps")
async def get_gps():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    ch = state.log.channels
    lat_name = next((n for n in ch if "latitude" in n.lower()), None)
    lon_name = next((n for n in ch if "longitude" in n.lower()), None)
    speed_name = next((n for n in ch if "gps" in n.lower() and "speed" in n.lower()), None)

    if not lat_name or not lon_name:
        return {"gps": None}

    lat_data = _channel_data(lat_name, ch[lat_name])
    lon_data = _channel_data(lon_name, ch[lon_name])

    lat = lat_data["values"]
    lon = lon_data["values"]
    ts = lat_data["timestamps"]

    filtered = {"timestamps": [], "lat": [], "lon": [], "speed": []}
    speed_data = _channel_data(speed_name, ch[speed_name]) if speed_name else None

    ts_offset = min(ts) if ts else 0

    for i in range(len(ts)):
        la, lo = lat[i], lon[i]
        if abs(la) > 0.1 and abs(lo) > 0.1 and math.isfinite(la) and math.isfinite(lo):
            filtered["timestamps"].append(ts[i] - ts_offset)
            filtered["lat"].append(la)
            filtered["lon"].append(lo)
            if speed_data and i < len(speed_data["values"]):
                filtered["speed"].append(speed_data["values"][i])
            else:
                filtered["speed"].append(0.0)

    if not filtered["lat"]:
        return {"gps": None}

    return {"gps": filtered}


@app.get("/api/export")
async def export_csv(channels: str = Query(...)):
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    names = [n.strip() for n in channels.split(",") if n.strip()]
    if not names:
        raise HTTPException(400, "No channels specified")

    channel_data = {}
    for name in names:
        if name in state.log.channels:
            channel_data[name] = _channel_data(name, state.log.channels[name])

    if not channel_data:
        raise HTTPException(400, "None of the specified channels found")

    timebase_name = max(channel_data, key=lambda n: len(channel_data[n]["timestamps"]))
    timebase_ts = channel_data[timebase_name]["timestamps"]

    units_map = {}
    for name in channel_data:
        if name in state.log.channels:
            cm = _channel_meta(name, state.log.channels[name])
            units_map[name] = cm["units"]

    output = io.StringIO()
    writer = csv.writer(output)
    headers = ["Time (s)"]
    for name in channel_data:
        u = units_map.get(name, "")
        headers.append(f"{name} ({u})" if u else name)
    writer.writerow(headers)

    for ts in timebase_ts:
        row = [f"{ts / 1000:.6f}"]
        for name in channel_data:
            cd = channel_data[name]
            val = _interpolate(cd["timestamps"], cd["values"], ts)
            row.append(f"{val:.5f}" if val is not None else "")
        writer.writerow(row)

    csv_bytes = output.getvalue().encode("utf-8")
    output.close()
    basename = re.sub(r'[^\w\-.]', '_', (state.filename or "export").rsplit(".", 1)[0])

    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{basename}_export.csv"'},
    )


def _interpolate(timestamps, values, t):
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


try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    np = None
    _HAS_NUMPY = False

# Maximum expression length and execution timeout
_MAX_EXPRESSION_LEN = 50_000
_EVAL_TIMEOUT_SECONDS = 10


def _interp_helper(ch_data, t):
    """Interpolate channel value at timestamp t."""
    ts = ch_data["timestamps"]
    vals = ch_data["values"]
    if not ts:
        return 0.0
    if t <= ts[0]:
        return vals[0]
    if t >= ts[-1]:
        return vals[-1]
    lo, hi = 0, len(ts) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if ts[mid] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = ts[lo], ts[hi]
    if t1 == t0:
        return vals[lo]
    frac = (t - t0) / (t1 - t0)
    return vals[lo] + frac * (vals[hi] - vals[lo])


class DerivedChannelRequest(BaseModel):
    expression: str
    channels: dict  # { channelName: { timestamps: [...], values: [...] } }


@app.post("/api/derived/evaluate")
async def evaluate_derived_channel(body: DerivedChannelRequest):
    """
    Evaluate a Python expression against channel data.
    The expression receives: channels (dict), np (numpy), math, interpolate(ch, t).
    Must assign result = { 'timestamps': [...], 'values': [...] }.
    """
    if not _HAS_NUMPY:
        raise HTTPException(500, "numpy is not installed on the server")

    if len(body.expression) > _MAX_EXPRESSION_LEN:
        raise HTTPException(400, f"Expression too long (max {_MAX_EXPRESSION_LEN} characters)")

    local_vars: dict = {}
    global_env = {
        "__builtins__": {
            "range": range,
            "len": len,
            "min": min,
            "max": max,
            "abs": abs,
            "round": round,
            "sum": sum,
            "zip": zip,
            "enumerate": enumerate,
            "map": map,
            "filter": filter,
            "list": list,
            "dict": dict,
            "tuple": tuple,
            "float": float,
            "int": int,
            "bool": bool,
            "str": str,
            "sorted": sorted,
            "reversed": reversed,
            "isinstance": isinstance,
            "True": True,
            "False": False,
            "None": None,
            "print": lambda *a, **kw: None,
        },
        "channels": body.channels,
        "np": np,
        "interpolate": _interp_helper,
        "math": math,
    }

    import signal

    def _timeout_handler(signum, frame):
        raise TimeoutError("Script exceeded time limit")

    try:
        old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(_EVAL_TIMEOUT_SECONDS)
        try:
            exec(body.expression, global_env, local_vars)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    except TimeoutError:
        raise HTTPException(400, f"Script timed out after {_EVAL_TIMEOUT_SECONDS} seconds")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Execution error: {type(e).__name__}: {e}")

    result = local_vars.get("result")
    if result is None:
        raise HTTPException(400, "Script must assign a 'result' variable with { 'timestamps': [...], 'values': [...] }")

    if not isinstance(result, dict) or "timestamps" not in result or "values" not in result:
        raise HTTPException(400, "result must be a dict with 'timestamps' and 'values' keys")

    ts_out = result["timestamps"]
    vals_out = result["values"]

    # Convert numpy arrays to lists if needed
    if hasattr(ts_out, "tolist"):
        ts_out = ts_out.tolist()
    if hasattr(vals_out, "tolist"):
        vals_out = vals_out.tolist()

    if len(ts_out) != len(vals_out):
        raise HTTPException(400, "timestamps and values must have the same length")

    # Filter non-finite values
    clean_ts = []
    clean_vals = []
    for t, v in zip(ts_out, vals_out):
        if isinstance(v, (int, float)) and math.isfinite(v):
            clean_ts.append(float(t))
            clean_vals.append(float(v))

    return {"timestamps": clean_ts, "values": clean_vals}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
