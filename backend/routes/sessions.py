"""Session management routes — CRUD, rename, AiM device integration."""

import asyncio
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import (
    session_store,
    aim_connector,
    gps_preview,
    aim_pull_log,
)
from services.aim_keepalive import AimKeepalive
from services.aim_primary_hub import get_aim_primary_hub
from parsers.parse_gate import PRIORITY_INTERACTIVE
from services.session_cache import session_cache
from state import (
    state, logger,
    parse_file, extract_session_info, sanitize_filename,
    resolve_aim_recorded_at, apply_stored_recorded_at,
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

    local_path = session_store.repair_session_path(session_id, entry)
    if local_path is None:
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    cached = session_cache.get_valid(session_id, local_path)
    if cached is not None:
        log, _ = cached
        session_cache.set_active(session_id)
        state.filename = entry["filename"]
    else:
        try:
            log = await asyncio.to_thread(
                parse_file, local_path, PRIORITY_INTERACTIVE,
            )
        except Exception:
            logger.exception("Failed to parse session file")
            raise HTTPException(500, "Failed to parse session file")
        session_cache.put(session_id, log, entry["filename"], local_path)
        session_cache.set_active(session_id)
        state.filename = entry["filename"]

    info = extract_session_info(log, entry["filename"])
    if entry.get("source") == "aim_device" and entry.get("recorded_at"):
        info = apply_stored_recorded_at(info, entry["recorded_at"])
    return info


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
    old_path = session_store.resolve_session_path(entry)
    new_path = None
    if old_path and old_path.exists():
        new_path = str(session_store.session_file_path(new_filename))
        old_path.rename(new_path)

    updated = session_store.update_session(
        session_id,
        filename=new_filename,
        aim_session_id=Path(new_filename).stem,
        local_path=new_path or (str(old_path) if old_path else entry.get("local_path")),
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
    local_path = session_store.resolve_session_path(entry)
    if local_path is None:
        return {"preview": None}
    preview = await asyncio.to_thread(
        gps_preview.compute_preview, local_path, session_id,
    )
    return {"preview": preview}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = session_store.resolve_session_path(entry)
    if local_path:
        local_path.unlink(missing_ok=True)

    if state.session_id == session_id:
        state.clear()
    session_cache.evict(session_id)

    session_store.delete_session(session_id)
    return {"ok": True}


# ─── AiM Device ──────────────────────────────────────────────────────────────

@router.get("/aim/status")
async def aim_status():
    device_info = await asyncio.to_thread(aim_connector.discover_device)
    connected = device_info is not None
    return {"connected": connected, "device": device_info}


@router.get("/aim/sessions")
async def list_aim_sessions():
    started = time.monotonic()
    device = await asyncio.to_thread(aim_connector.discover_device)
    device_ip = device["ip"] if device else ""

    sessions = []
    try:
        hub = get_aim_primary_hub()
        sessions = await hub.list_sessions(device_ip or None)
    except ConnectionError as exc:
        aim_pull_log.record(
            action="list",
            status="list_failed",
            device_ip=device_ip,
            duration_s=time.monotonic() - started,
            session_count=0,
            error=str(exc)[:200],
        )
        return {
            "ok": False,
            "sessions": [],
            "error": "Could not connect to AiM device. Check WiFi connection and device IP in Settings.",
        }
    duration_s = time.monotonic() - started

    aim_pull_log.record(
        action="list",
        status="list_ok",
        device_ip=device_ip,
        duration_s=duration_s,
        session_count=len(sessions),
    )

    local_sessions = session_store.list_sessions()
    local_filenames = {s["filename"] for s in local_sessions}

    for s in sessions:
        s["already_downloaded"] = s["filename"] in local_filenames

    return {"ok": True, "sessions": sessions}


@router.get("/aim/pull/log")
async def get_aim_pull_log():
    """Recent AiM list/pull attempts, newest first. In-memory only."""
    return {"entries": aim_pull_log.list_recent()}


@router.get("/aim/download/trace")
async def list_aim_download_traces():
    """List persisted AiM download trace logs (newest first)."""
    log_dir = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_download"
    if not log_dir.is_dir():
        return {"traces": []}
    files = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {
        "traces": [
            {
                "path": str(path),
                "name": path.name,
                "size": path.stat().st_size,
                "modified_at": path.stat().st_mtime,
            }
            for path in files[:20]
        ]
    }


@router.get("/aim/download/trace/{name}")
async def get_aim_download_trace(name: str):
    """Return one AiM download trace log file."""
    log_dir = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_download"
    path = (log_dir / Path(name).name).resolve()
    if not path.is_file() or not path.is_relative_to(log_dir.resolve()):
        raise HTTPException(404, "Trace log not found")
    return {"name": path.name, "lines": path.read_text(encoding="utf-8").splitlines()}


class AimPullRequest(BaseModel):
    filenames: list[str]


@router.post("/aim/pull")
async def pull_from_aim(body: AimPullRequest):
    if not body.filenames:
        return {"ok": False, "error": "No files selected", "downloaded": [], "results": []}

    device = await asyncio.to_thread(aim_connector.discover_device)
    device_ip = device["ip"] if device else ""

    logger.info("AiM pull: downloading %d selected sessions...", len(body.filenames))

    hub = get_aim_primary_hub()
    # Must run on the primary TCP *before* it is released: the device ignores a
    # second port-2000 connection while the primary is open (QS_Pull_241/242).
    device_meta_by_file: dict[str, dict] = {}
    try:
        aim_sessions = await hub.list_sessions(device_ip or None)
        device_meta_by_file = {
            s["filename"]: s for s in aim_sessions if s.get("filename")
        }
    except (ConnectionError, TimeoutError, RuntimeError, OSError) as exc:
        logger.warning("AiM pull: could not fetch device session list for dates: %s", exc)

    try:
        await hub.release_for_download()
    except ConnectionError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "downloaded": [],
            "errors": [str(exc)],
            "results": [],
        }

    keepalive = await _start_download_keepalive(hub.resolve_host(device_ip or None))
    try:
        downloaded, errors, results = await _download_selected(
            body.filenames,
            device_meta_by_file=device_meta_by_file,
            device_ip=device_ip,
        )
    finally:
        if keepalive is not None:
            await keepalive.stop()

    return {"ok": True, "downloaded": downloaded, "errors": errors, "results": results}


async def _start_download_keepalive(host: str) -> AimKeepalive | None:
    """Race Studio keeps ``aim-ka`` running during downloads (RS3_PULL_241/242);
    without it the device drops port 2000 ~30 s after the last datagram."""
    keepalive = AimKeepalive(host)
    try:
        await keepalive.start()
    except OSError as exc:
        logger.warning("AiM pull: keepalive could not start (%s); long downloads may drop", exc)
        return None
    return keepalive


async def _download_selected(
    filenames: list[str],
    *,
    device_meta_by_file: dict[str, dict],
    device_ip: str,
) -> tuple[list[str], list[str], list[dict]]:
    downloaded = []
    errors = []
    results = []

    for raw_filename in filenames:
        try:
            filename = sanitize_filename(raw_filename)
        except ValueError:
            errors.append(f"{raw_filename}: invalid filename")
            aim_pull_log.record(
                action="pull",
                status="download_failed",
                device_ip=device_ip,
                filename=raw_filename,
                error="invalid filename",
            )
            continue

        logger.info("AiM pull: downloading %s ...", filename)
        started = time.monotonic()
        try:
            dest = session_store.session_file_path(filename)
            device_meta = device_meta_by_file.get(filename, {})
            expected_size = int(device_meta.get("size", 0) or 0)
            await asyncio.to_thread(
                aim_connector.download_aim_session,
                filename,
                dest.parent,
                expected_size,
            )
            file_bytes = dest.stat().st_size
            duration_s = time.monotonic() - started
            if expected_size > 0 and file_bytes < expected_size:
                raise RuntimeError(
                    f"Incomplete download: got {file_bytes} bytes, expected {expected_size} bytes"
                )
            logger.info(
                "AiM pull: saved %s (%d bytes%s)",
                dest,
                file_bytes,
                f", expected {expected_size}" if expected_size else "",
            )

            parse_ok = True
            try:
                log = parse_file(dest)
                info = extract_session_info(log, filename)
                meta = info["metadata"]
            except Exception as parse_err:
                parse_ok = False
                logger.warning("AiM pull: parse failed for %s: %s", filename, parse_err)
                meta = {}
                info = {"durationMs": 0, "lapCount": 0}
                aim_pull_log.record(
                    action="pull",
                    status="parse_failed",
                    device_ip=device_ip,
                    filename=filename,
                    size=file_bytes,
                    duration_s=duration_s,
                    error=str(parse_err)[:200],
                )

            device_meta = device_meta_by_file.get(filename, {})
            recorded_at = resolve_aim_recorded_at(
                device_meta.get("date", ""),
                device_meta.get("hour", ""),
                meta.get("date", ""),
                meta.get("time", ""),
            )

            entry = session_store.add_session(
                filename=filename,
                source="aim_device",
                local_path=str(dest),
                track_name=meta.get("venue", ""),
                driver_name=meta.get("driver", ""),
                vehicle_name=meta.get("vehicle", ""),
                recorded_at=recorded_at,
                duration_s=info.get("durationMs", 0) / 1000,
                lap_count=info.get("lapCount", 0),
            )
            downloaded.append(entry["filename"])

            if parse_ok:
                session_cache.put(entry["id"], log, filename, dest)
                try:
                    gps_preview.warm_from_log(entry["id"], dest, log)
                except Exception:
                    logger.exception("Failed to warm GPS preview cache for %s", filename)
                aim_pull_log.record(
                    action="pull",
                    status="ok",
                    device_ip=device_ip,
                    filename=filename,
                    size=file_bytes,
                    duration_s=duration_s,
                    session_id=entry["id"],
                )

            results.append({
                "filename": filename,
                "bytes": file_bytes,
                "duration_s": round(duration_s, 3),
                "session_id": entry["id"],
                "parse_ok": parse_ok,
                "local_path": str(dest),
            })
        except Exception as e:
            duration_s = time.monotonic() - started
            logger.error("AiM pull: failed to download %s: %s", filename, e, exc_info=True)
            errors.append(f"{filename}: {e}")
            aim_pull_log.record(
                action="pull",
                status="download_failed",
                device_ip=device_ip,
                filename=filename,
                duration_s=duration_s,
                error=str(e)[:200],
            )

    return downloaded, errors, results
