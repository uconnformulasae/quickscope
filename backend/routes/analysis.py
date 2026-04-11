"""Analysis routes — upload, channel data, laps, GPS, export, derived channels."""

import io
import csv
import math
import re

from fastapi import APIRouter, UploadFile, File, Query, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services import session_store
from state import (
    state, logger, background_sync, CHART_COLORS,
    parse_file, extract_session_info, parse_recorded_at,
    sanitize_filename, channel_meta, channel_data, interpolate,
)

router = APIRouter(prefix="/api")


# ─── Upload ──────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(file: UploadFile = File(...), background_tasks: BackgroundTasks = None):
    if not file.filename or not file.filename.lower().endswith((".xrk", ".xrz")):
        raise HTTPException(400, "Only .xrk/.xrz files are supported")

    filename = sanitize_filename(file.filename)
    content = await file.read()

    dest = session_store.session_file_path(filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)

    try:
        log = parse_file(dest)
        state.log = log
        state.filename = filename
    except Exception:
        dest.unlink(missing_ok=True)
        state.clear()
        logger.exception("Failed to parse uploaded file")
        raise HTTPException(500, "Failed to parse file")

    info = extract_session_info(log, filename)
    meta = info["metadata"]

    # Check for duplicate
    existing = session_store.find_by_filename(filename)
    if existing:
        state.session_id = existing["id"]
        if background_tasks:
            background_tasks.add_task(background_sync)
        return info

    entry = session_store.add_session(
        filename=filename,
        source="manual_upload",
        sync_status="local_only",
        local_path=str(dest),
        track_name=meta.get("venue", ""),
        driver_name=meta.get("driver", ""),
        vehicle_name=meta.get("vehicle", ""),
        recorded_at=parse_recorded_at(meta.get("date", ""), meta.get("time", "")),
        duration_s=info["durationMs"] / 1000,
        lap_count=info["lapCount"],
    )
    state.session_id = entry["id"]

    if background_tasks:
        background_tasks.add_task(background_sync)

    return info


# ─── Channel Data ────────────────────────────────────────────────────────────

@router.get("/channels")
async def get_channels():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")
    channels = []
    for i, (name, table) in enumerate(sorted(state.log.channels.items())):
        cm = channel_meta(name, table)
        channels.append({
            "name": name,
            "units": cm["units"],
            "sampleCount": table.num_rows,
            "color": CHART_COLORS[i % len(CHART_COLORS)],
            "index": i,
        })
    return {"channels": channels}


@router.get("/data")
async def get_channel_data(channels: str = Query(...)):
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    names = [n.strip() for n in channels.split(",") if n.strip()]
    result = {}
    for name in names:
        if name in state.log.channels:
            result[name] = channel_data(name, state.log.channels[name])
    return result


# ─── Laps & GPS ──────────────────────────────────────────────────────────────

@router.get("/laps")
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


@router.get("/gps")
async def get_gps():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    ch = state.log.channels
    lat_name = next((n for n in ch if "latitude" in n.lower()), None)
    lon_name = next((n for n in ch if "longitude" in n.lower()), None)
    speed_name = next((n for n in ch if "gps" in n.lower() and "speed" in n.lower()), None)

    if not lat_name or not lon_name:
        return {"gps": None}

    lat_data = channel_data(lat_name, ch[lat_name])
    lon_data = channel_data(lon_name, ch[lon_name])

    lat = lat_data["values"]
    lon = lon_data["values"]
    ts = lat_data["timestamps"]

    filtered = {"timestamps": [], "lat": [], "lon": [], "speed": []}
    speed_data = channel_data(speed_name, ch[speed_name]) if speed_name else None

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


# ─── Export ──────────────────────────────────────────────────────────────────

@router.get("/export")
async def export_csv(channels: str = Query(...)):
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    names = [n.strip() for n in channels.split(",") if n.strip()]
    if not names:
        raise HTTPException(400, "No channels specified")

    ch_data = {}
    for name in names:
        if name in state.log.channels:
            ch_data[name] = channel_data(name, state.log.channels[name])

    if not ch_data:
        raise HTTPException(400, "None of the specified channels found")

    timebase_name = max(ch_data, key=lambda n: len(ch_data[n]["timestamps"]))
    timebase_ts = ch_data[timebase_name]["timestamps"]

    units_map = {}
    for name in ch_data:
        if name in state.log.channels:
            cm = channel_meta(name, state.log.channels[name])
            units_map[name] = cm["units"]

    output = io.StringIO()
    writer = csv.writer(output)
    headers = ["Time (s)"]
    for name in ch_data:
        u = units_map.get(name, "")
        headers.append(f"{name} ({u})" if u else name)
    writer.writerow(headers)

    for ts in timebase_ts:
        row = [f"{ts / 1000:.6f}"]
        for name in ch_data:
            cd = ch_data[name]
            val = interpolate(cd["timestamps"], cd["values"], ts)
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


# ─── Derived Channels ───────────────────────────────────────────────────────

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    np = None
    _HAS_NUMPY = False

_MAX_EXPRESSION_LEN = 50_000
_EVAL_TIMEOUT_SECONDS = 10


def _interp_helper(ch_data, t):
    """Interpolate channel value at timestamp t (wrapper for derived channel sandbox)."""
    return interpolate(ch_data["timestamps"], ch_data["values"], t) or 0.0


class DerivedChannelRequest(BaseModel):
    expression: str
    channels: dict  # { channelName: { timestamps: [...], values: [...] } }


@router.post("/derived/evaluate")
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
