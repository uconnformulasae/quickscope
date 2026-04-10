"""
QuickScope — Python/libxrk backend
Parses .xrk files using libxrk and serves channel data via FastAPI.
Multi-session with local persistence and Railway/AiM sync.
"""

import io
import csv
import logging
import math
import os
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Query, HTTPException, BackgroundTasks

# Configure logging so AiM connector debug output is visible
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("quickscope")
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from libxrk import aim_xrk, ChannelMetadata

from services import session_store, settings_store, sync_service, aim_connector, railway_client

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
        self.session_id: Optional[str] = None  # local session ID

    def clear(self):
        self.log = None
        self.filename = None
        self.session_id = None

    @property
    def loaded(self) -> bool:
        return self.log is not None

state = SessionState()


def _channel_meta(name: str, table) -> dict:
    """Extract metadata from a channel's PyArrow table."""
    field = table.schema.field(name)
    meta = ChannelMetadata.from_field(field)
    return {
        "units": meta.units or "",
        "function": meta.function or "",
        "source_type": meta.source_type,
    }


def _channel_data(name: str, table) -> dict:
    """Extract timestamps (ms) and values from a channel table."""
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
    """Parse a session file with libxrk. Returns the log object."""
    return aim_xrk(str(file_path))


def _extract_session_info(log, filename: str) -> dict:
    """Extract metadata, channels, duration from a parsed log."""
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

        if n_rows > 0 and not name.lower().startswith("gps"):
            df = table.to_pandas()
            last_tc = float(df['timecodes'].iloc[-1])
            if last_tc < 36_000_000 and last_tc > duration_ms:
                duration_ms = last_tc

        # Compute sample rate from timecodes if available
        sample_rate_hz = 0
        if n_rows >= 2 and not name.lower().startswith("gps"):
            df = table.to_pandas() if 'df' not in dir() or df is None else df
            tcs = table.to_pandas()['timecodes']
            dt = float(tcs.iloc[-1] - tcs.iloc[0])
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


# ─── Session Management Endpoints ──────────────────────────────────────────

@app.get("/api/sessions")
async def list_sessions():
    """List all sessions from the local index."""
    return session_store.list_sessions()


@app.post("/api/sessions/{session_id}/load")
async def load_session(session_id: str):
    """Load a local session into memory for analysis."""
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
    except Exception as e:
        state.clear()
        raise HTTPException(500, f"Failed to parse file: {e}")

    return _extract_session_info(log, entry["filename"])


@app.post("/api/sessions/sync")
async def sync_sessions():
    """Sync with Railway — pull remote session list, push local-only sessions."""
    try:
        result = await sync_service.sync_with_railway()
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Sync failed: {e}")


@app.post("/api/sessions/{session_id}/pull")
async def pull_session(session_id: str):
    """Download a remote-only session's file from Railway."""
    result = await sync_service.pull_session(session_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "Pull failed"))
    return result


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Remove a session from the local index and delete its cached file."""
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    # Delete local file if it exists
    local_path = entry.get("local_path")
    if local_path:
        Path(local_path).unlink(missing_ok=True)

    # Clear active session if it's the one being deleted
    if state.session_id == session_id:
        state.clear()

    session_store.delete_session(session_id)
    return {"ok": True}


# ─── AiM Device Endpoints ──────────────────────────────────────────────────

@app.get("/api/aim/status")
async def aim_status():
    """Check if AiM device is reachable via UDP discovery."""
    connected = aim_connector.is_aim_connected()
    device_info = None
    if connected:
        device_info = aim_connector.discover_device()
    return {
        "connected": connected,
        "device": device_info,
        "device_ip": aim_connector._get_device_ip(),
    }


@app.get("/api/aim/sessions")
async def list_aim_sessions():
    """List sessions available on the AiM device."""
    if not aim_connector.is_aim_connected():
        return {"ok": False, "sessions": [], "error": "AiM device not reachable"}

    sessions = aim_connector.list_aim_sessions()

    # Mark which ones we already have locally
    local_sessions = session_store.list_sessions()
    local_filenames = {s["filename"] for s in local_sessions}

    for s in sessions:
        s["already_downloaded"] = s["filename"] in local_filenames

    return {"ok": True, "sessions": sessions}


@app.post("/api/aim/pull")
async def pull_from_aim(body: dict = None, background_tasks: BackgroundTasks = None):
    """Download selected sessions from AiM device, save locally, queue upload to Railway."""
    if not aim_connector.is_aim_connected():
        raise HTTPException(400, "AiM device not reachable")

    selected_filenames = (body or {}).get("filenames", [])
    if not selected_filenames:
        return {"ok": False, "error": "No files selected", "downloaded": []}

    logger.info("AiM pull: downloading %d selected sessions...", len(selected_filenames))

    downloaded = []
    errors = []
    for filename in selected_filenames:
        aim_s = {"filename": filename}
        logger.info("AiM pull: downloading %s ...", aim_s["filename"])
        try:
            dest = session_store.session_file_path(aim_s["filename"])
            aim_connector.download_aim_session(aim_s["filename"], dest.parent)
            logger.info("AiM pull: saved %s (%d bytes)", dest, dest.stat().st_size)

            # Parse to extract metadata
            try:
                log = _parse_file(dest)
                info = _extract_session_info(log, aim_s["filename"])
                meta = info["metadata"]
            except Exception as parse_err:
                logger.warning("AiM pull: parse failed for %s: %s", aim_s["filename"], parse_err)
                meta = {}
                info = {"durationMs": 0, "lapCount": 0}

            entry = session_store.add_session(
                filename=aim_s["filename"],
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
            logger.error("AiM pull: failed to download %s: %s", aim_s["filename"], e, exc_info=True)
            errors.append(f"{aim_s['filename']}: {e}")

    # Background: sync with Railway to push new sessions
    if downloaded:
        background_tasks.add_task(_background_sync)

    return {"ok": True, "downloaded": downloaded, "errors": errors}


async def _background_sync():
    try:
        await sync_service.sync_with_railway()
    except Exception:
        pass


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

    content = await file.read()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xrk")
    try:
        tmp.write(content)
        tmp.flush()
        tmp.close()
        log = _parse_file(tmp.name)
        state.log = log
        state.filename = file.filename
    except Exception as e:
        state.clear()
        raise HTTPException(500, f"Failed to parse file: {e}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    info = _extract_session_info(log, file.filename)

    # Save to local cache
    dest = session_store.session_file_path(file.filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)

    meta = info["metadata"]
    # Check for duplicate
    existing = session_store.find_by_filename(file.filename)
    if existing:
        state.session_id = existing["id"]
        if background_tasks:
            background_tasks.add_task(_background_sync)
        return info

    entry = session_store.add_session(
        filename=file.filename,
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

    # Background: upload to Railway
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
    basename = (state.filename or "export").rsplit(".", 1)[0]

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
