"""Session management routes — CRUD, rename, sync, AiM device integration."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from services import session_store, sync_service, aim_connector, railway_client, gps_preview
from state import (
    state, logger, background_sync,
    parse_file, extract_session_info, parse_recorded_at, sanitize_filename,
)

router = APIRouter(prefix="/api")


# ─── Session CRUD ────────────────────────────────────────────────────────────

@router.get("/sessions")
async def list_sessions():
    return session_store.list_sessions()


@router.post("/sessions/{session_id}/load")
async def load_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = entry.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    try:
        log = parse_file(local_path)
        state.log = log
        state.filename = entry["filename"]
        state.session_id = session_id
    except Exception:
        state.clear()
        logger.exception("Failed to parse session file")
        raise HTTPException(500, "Failed to parse session file")

    return extract_session_info(log, entry["filename"])


@router.post("/sessions/sync")
async def sync_sessions():
    try:
        result = await sync_service.sync_with_railway()
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        logger.exception("Sync failed")
        raise HTTPException(500, "Sync failed")


@router.post("/sessions/{session_id}/pull")
async def pull_session(session_id: str):
    result = await sync_service.pull_session(session_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "Pull failed"))
    return result


class RenameRequest(BaseModel):
    filename: str


@router.post("/sessions/{session_id}/rename")
async def rename_session(session_id: str, body: RenameRequest):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    try:
        new_filename = sanitize_filename(body.filename)
    except ValueError:
        raise HTTPException(400, "Invalid filename")

    # Preserve original extension if the user omitted it
    old_ext = Path(entry["filename"]).suffix
    if old_ext and not Path(new_filename).suffix:
        new_filename += old_ext

    # Check for conflicts
    existing = session_store.find_by_filename(new_filename)
    if existing and existing["id"] != session_id:
        raise HTTPException(409, "A session with that filename already exists")

    # Rename physical file on disk
    old_path = entry.get("local_path")
    new_path = None
    if old_path and Path(old_path).exists():
        new_path = str(session_store.session_file_path(new_filename))
        Path(old_path).rename(new_path)

    # Rename on Railway if synced
    remote_id = entry.get("remote_id")
    if remote_id:
        try:
            await railway_client.rename_session(remote_id, Path(new_filename).stem)
        except Exception as exc:
            # Roll back local file rename
            if new_path and Path(new_path).exists():
                Path(new_path).rename(old_path)
            logger.warning("Failed to rename session on Railway: %s", exc)
            raise HTTPException(502, "Failed to update remote: " + str(exc))

    updated = session_store.update_session(
        session_id,
        filename=new_filename,
        aim_session_id=Path(new_filename).stem,
        local_path=new_path or old_path,
    )
    return updated


@router.get("/sessions/{session_id}/gps-preview")
async def get_gps_preview(session_id: str):
    """Returns a downsampled GPS thumbnail for the SessionBrowser UI.

    Returns 200 with `{"preview": null}` if the session has no usable GPS
    track (so the frontend can cache the absence and skip the icon). Only
    returns 404 when the session itself doesn't exist.
    """
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")
    local_path = entry.get("local_path")
    if not local_path:
        return {"preview": None}
    preview = await asyncio.to_thread(gps_preview.compute_preview, local_path)
    return {"preview": preview}


class LapSetpoint(BaseModel):
    lat: float
    lon: float
    radius_m: float


class SetpointsRequest(BaseModel):
    setpoints: list[LapSetpoint]


_MAX_SETPOINTS = 16
# Radius is fixed at 2 m by the UI; the bounds here just reject typo'd
# requests. Older sessions persisted radius_m=15 — those keep working,
# but new pins must land in [1, 10].
_RADIUS_MIN_M = 1.0
_RADIUS_MAX_M = 10.0


@router.get("/sessions/{session_id}/setpoints")
async def get_setpoints(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")
    return {"setpoints": entry.get("lap_setpoints") or []}


@router.put("/sessions/{session_id}/setpoints")
async def put_setpoints(session_id: str, body: SetpointsRequest):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    if len(body.setpoints) > _MAX_SETPOINTS:
        raise HTTPException(400, f"Too many setpoints (max {_MAX_SETPOINTS})")

    cleaned: list[dict] = []
    import math as _math
    for i, sp in enumerate(body.setpoints):
        if not (_math.isfinite(sp.lat) and -90.0 <= sp.lat <= 90.0):
            raise HTTPException(400, f"Setpoint {i}: lat must be in [-90, 90]")
        if not (_math.isfinite(sp.lon) and -180.0 <= sp.lon <= 180.0):
            raise HTTPException(400, f"Setpoint {i}: lon must be in [-180, 180]")
        if not (_math.isfinite(sp.radius_m) and _RADIUS_MIN_M <= sp.radius_m <= _RADIUS_MAX_M):
            raise HTTPException(
                400,
                f"Setpoint {i}: radius_m must be in [{_RADIUS_MIN_M}, {_RADIUS_MAX_M}]",
            )
        cleaned.append({"lat": sp.lat, "lon": sp.lon, "radius_m": sp.radius_m})

    updated = session_store.update_session(session_id, lap_setpoints=cleaned)
    return updated


@router.delete("/sessions/{session_id}")
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


# ─── AiM Device ──────────────────────────────────────────────────────────────

@router.get("/aim/status")
async def aim_status():
    connected = await asyncio.to_thread(aim_connector.is_aim_connected)
    device_info = None
    if connected:
        device_info = await asyncio.to_thread(aim_connector.discover_device)
    return {"connected": connected, "device": device_info}


@router.get("/aim/sessions")
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


@router.post("/aim/pull")
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
            filename = sanitize_filename(raw_filename)
        except ValueError:
            errors.append(f"{raw_filename}: invalid filename")
            continue

        logger.info("AiM pull: downloading %s ...", filename)
        try:
            dest = session_store.session_file_path(filename)
            await asyncio.to_thread(aim_connector.download_aim_session, filename, dest.parent)
            logger.info("AiM pull: saved %s (%d bytes)", dest, dest.stat().st_size)

            try:
                log = parse_file(dest)
                info = extract_session_info(log, filename)
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
                recorded_at=parse_recorded_at(meta.get("date", ""), meta.get("time", "")),
                duration_s=info.get("durationMs", 0) / 1000,
                lap_count=info.get("lapCount", 0),
            )
            downloaded.append(entry["filename"])
        except Exception as e:
            logger.error("AiM pull: failed to download %s: %s", filename, e, exc_info=True)
            errors.append(f"{filename}: {e}")

    if downloaded:
        background_tasks.add_task(background_sync)

    return {"ok": True, "downloaded": downloaded, "errors": errors}
