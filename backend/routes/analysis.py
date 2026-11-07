"""Analysis routes — upload, channel data, laps, GPS, export, derived channels."""

import asyncio
import math
import os
import time
import uuid

from fastapi import APIRouter, UploadFile, File, Query, HTTPException, Request
from pydantic import BaseModel

from sanitize import (
    InvalidInput, clean_text, is_finite_number,
    validate_channel_payload,
)
from services import session_store, lap_detection, upload_log, gps_preview, derived_eval
from services.session_cache import session_cache
from state import (
    state, logger, CHART_COLORS,
    parse_file, extract_session_info, parse_recorded_at,
    sanitize_filename, channel_meta, channel_data, interpolate,
)

router = APIRouter(prefix="/api")


class _NotAnXrkFile(Exception):
    pass


# Largest XRK/XRZ accepted. Real endurance logs are tens of MB; the cap only
# stops a runaway or hostile upload from filling the disk.
MAX_UPLOAD_BYTES = int(os.environ.get("QUICKSCOPE_MAX_UPLOAD_MB", "1024")) * 1024 * 1024
_UPLOAD_CHUNK_BYTES = 1024 * 1024


class _UploadTooLarge(Exception):
    pass


async def _save_upload(file: UploadFile, tmp_dest) -> int:
    """Stream the upload to ``tmp_dest``; raise _UploadTooLarge past the cap."""
    size = 0
    try:
        with open(tmp_dest, "wb") as out:
            while chunk := await file.read(_UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise _UploadTooLarge()
                out.write(chunk)
    except BaseException:
        tmp_dest.unlink(missing_ok=True)
        raise
    return size


# ─── Upload ──────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
):
    started = time.monotonic()
    client_ip = request.client.host if request.client else "?"
    user_agent = request.headers.get("user-agent", "")[:200]
    # Logged and echoed as-is otherwise: strip control characters and bound it.
    raw_filename = clean_text(file.filename or "", max_len=255, truncate=True)

    if not raw_filename or not raw_filename.lower().endswith((".xrk", ".xrz")):
        upload_log.record(
            filename=raw_filename, size=0, duration_s=time.monotonic() - started,
            client_ip=client_ip, user_agent=user_agent,
            status="upload_failed", error="invalid extension",
        )
        raise HTTPException(400, "Only .xrk/.xrz files are supported")

    try:
        filename = sanitize_filename(raw_filename)
    except ValueError:
        upload_log.record(
            filename=raw_filename, size=0, duration_s=time.monotonic() - started,
            client_ip=client_ip, user_agent=user_agent,
            status="upload_failed", error="invalid filename",
        )
        raise HTTPException(400, "Invalid filename")

    dest = session_store.session_file_path(filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Keep the real extension last: the AiM DLL may pick the format from it.
    tmp_dest = dest.with_name(f".upload-{uuid.uuid4().hex}-{dest.name}")
    try:
        size = await _save_upload(file, tmp_dest)
    except _UploadTooLarge:
        upload_log.record(
            filename=filename, size=MAX_UPLOAD_BYTES, duration_s=time.monotonic() - started,
            client_ip=client_ip, user_agent=user_agent,
            status="upload_failed", error="file too large",
        )
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")

    # Parse before replacing: a bad re-upload must not destroy the stored session file.
    try:
        log = await asyncio.to_thread(parse_file, tmp_dest)
        # libxrk returns an empty log for bytes that aren't an XRK file instead of raising.
        if not log.channels:
            raise _NotAnXrkFile("file contains no channels")
        os.replace(tmp_dest, dest)
        state.log = log
        state.filename = filename
    except Exception as exc:
        tmp_dest.unlink(missing_ok=True)
        state.discard_pending()
        logger.exception("Failed to parse uploaded file")
        upload_log.record(
            filename=filename, size=size, duration_s=time.monotonic() - started,
            client_ip=client_ip, user_agent=user_agent,
            status="parse_failed", error=str(exc)[:200],
        )
        if isinstance(exc, _NotAnXrkFile):
            raise HTTPException(400, "Not a valid XRK/XRZ file")
        raise HTTPException(500, "Failed to parse file")

    info = await asyncio.to_thread(extract_session_info, log, filename)
    meta = info["metadata"]

    # Check for duplicate
    existing = session_store.find_by_filename(filename)
    if existing:
        state.session_id = existing["id"]
        session_cache.rebind_file(existing["id"], dest, filename)
        try:
            await asyncio.to_thread(gps_preview.warm_from_log, existing["id"], dest, log)
        except Exception:
            logger.exception("Failed to warm GPS preview cache for %s", filename)
        upload_log.record(
            filename=filename, size=size, duration_s=time.monotonic() - started,
            client_ip=client_ip, user_agent=user_agent, status="ok",
        )
        return {**info, "sessionId": existing["id"]}

    entry = session_store.add_session(
        filename=filename,
        source="manual_upload",
        local_path=str(dest),
        track_name=meta.get("venue", ""),
        driver_name=meta.get("driver", ""),
        vehicle_name=meta.get("vehicle", ""),
        recorded_at=parse_recorded_at(meta.get("date", ""), meta.get("time", "")),
        duration_s=info["durationMs"] / 1000,
        lap_count=info["lapCount"],
    )
    state.session_id = entry["id"]
    session_cache.rebind_file(entry["id"], dest, filename)

    try:
        await asyncio.to_thread(gps_preview.warm_from_log, entry["id"], dest, log)
    except Exception:
        logger.exception("Failed to warm GPS preview cache for %s", filename)

    upload_log.record(
        filename=filename, size=size, duration_s=time.monotonic() - started,
        client_ip=client_ip, user_agent=user_agent, status="ok",
    )
    logger.info(
        "upload ok: %s (%d bytes in %.2fs from %s)",
        filename, size, time.monotonic() - started, client_ip,
    )
    return {**info, "sessionId": entry["id"]}


@router.get("/uploads/log")
async def get_upload_log():
    """Recent uploads, newest first. In-memory only — clears on restart."""
    return {"entries": upload_log.list_recent()}


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
            result[name] = channel_data(name, state.log.channels[name], drop_gaps=True)
    return result


# ─── Laps & GPS ──────────────────────────────────────────────────────────────

@router.get("/laps")
async def get_laps():
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    def _channel_data(name: str):
        if name in state.log.channels:
            return channel_data(name, state.log.channels[name])
        return None

    laps, source = lap_detection.detect_laps(state.log, _channel_data)
    return {"laps": laps, "source": source}


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
    speed_data = channel_data(speed_name, ch[speed_name], drop_gaps=True) if speed_name else None

    ts_offset = min(ts) if ts else 0

    for i in range(len(ts)):
        la, lo = lat[i], lon[i]
        if la is None or lo is None:
            continue
        if abs(la) > 0.1 and abs(lo) > 0.1:
            filtered["timestamps"].append(ts[i] - ts_offset)
            filtered["lat"].append(la)
            filtered["lon"].append(lo)
            # Match speed to the fix by time: the speed channel can run at a different rate.
            speed = (
                interpolate(speed_data["timestamps"], speed_data["values"], ts[i])
                if speed_data else None
            )
            filtered["speed"].append(speed if speed is not None else 0.0)

    if not filtered["lat"]:
        return {"gps": None}

    # Units of the speed channel so the client can convert the trail colours;
    # speed is null (not zeros) when the session has no GPS speed channel.
    filtered["speedUnits"] = channel_meta(speed_name, ch[speed_name])["units"] if speed_name else ""
    if not speed_name:
        filtered["speed"] = None

    return {"gps": filtered}


# ─── Export ──────────────────────────────────────────────────────────────────

@router.get("/export")
async def export_csv(channels: str = Query(...), convert: str | None = Query(None)):
    """``convert`` (optional) is JSON ``{name: {"unit", "scale", "offset"}}``:
    the client's display-unit conversion, applied as ``value * scale + offset``."""
    if not state.loaded:
        raise HTTPException(400, "No file loaded")

    from services.csv_export import parse_conversions, streaming_csv_response

    try:
        conversions = parse_conversions(convert)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    names = [n.strip() for n in channels.split(",") if n.strip()]
    if not names:
        raise HTTPException(400, "No channels specified")

    entry = session_store.get_session(state.session_id) if state.session_id else None
    aim_session_id = entry.get("aim_session_id") if entry else None

    try:
        return streaming_csv_response(
            state.log, state.filename, names, aim_session_id=aim_session_id,
            conversions=conversions,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


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
def evaluate_derived_channel(body: DerivedChannelRequest):
    """
    Evaluate a Python expression against channel data.
    The expression receives: channels (dict), np (numpy), math, interpolate(ch, t).
    Must assign result = { 'timestamps': [...], 'values': [...] }.
    Scripts are restricted — see services/derived_eval.py.
    """
    if not _HAS_NUMPY:
        raise HTTPException(500, "numpy is not installed on the server")

    if len(body.expression) > _MAX_EXPRESSION_LEN:
        raise HTTPException(400, f"Expression too long (max {_MAX_EXPRESSION_LEN} characters)")
    try:
        validate_channel_payload(body.channels)
    except InvalidInput as e:
        raise HTTPException(400, str(e))

    try:
        local_vars = derived_eval.run(
            body.expression, body.channels,
            np=np, math_module=math, interpolate=_interp_helper,
            timeout=_EVAL_TIMEOUT_SECONDS,
        )
    except derived_eval.ScriptRejected as e:
        raise HTTPException(400, str(e))
    except TimeoutError:
        raise HTTPException(400, f"Script timed out after {_EVAL_TIMEOUT_SECONDS} seconds")
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

    if not isinstance(ts_out, (list, tuple)) or not isinstance(vals_out, (list, tuple)):
        raise HTTPException(400, "result 'timestamps' and 'values' must be lists or arrays")
    if len(ts_out) != len(vals_out):
        raise HTTPException(400, "timestamps and values must have the same length")

    # Filter non-finite values
    clean_ts = []
    clean_vals = []
    for t, v in zip(ts_out, vals_out):
        if is_finite_number(t) and is_finite_number(v):
            clean_ts.append(float(t))
            clean_vals.append(float(v))

    return {"timestamps": clean_ts, "values": clean_vals}
