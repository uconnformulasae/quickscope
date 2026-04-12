"""
Sync service — bidirectional sync between local session index and Railway.

Pull: fetch remote session list, add missing ones as remote_only.
Push: upload local_only sessions to Railway.
"""

import logging

from pathlib import Path

from services import session_store, railway_client

logger = logging.getLogger(__name__)


async def sync_with_railway() -> dict:
    """Full bidirectional sync with Railway.

    Returns a summary of what happened.
    """
    stats = {"pulled": 0, "pushed": 0, "errors": []}

    # --- Pull: discover remote sessions ---
    try:
        remote_sessions = await railway_client.list_remote_sessions()
    except Exception as exc:
        stats["errors"].append(f"Failed to fetch remote sessions: {exc}")
        return stats

    # Metadata fields to sync from Railway
    _meta_keys = ("track_name", "driver_name", "vehicle_name", "recorded_at",
                  "duration_s", "lap_count", "championship_name")

    for remote in remote_sessions:
        remote_id = remote["id"]
        remote_meta = {k: remote[k] for k in _meta_keys if k in remote and remote[k]}

        # Check if we already know this session
        existing = session_store.find_by_remote_id(remote_id)
        if existing:
            # Update metadata from Railway so edits made remotely are reflected
            if remote_meta:
                session_store.update_session(existing["id"], **remote_meta)
            continue

        # Also check by filename or aim_session_id
        filename = remote.get("filename", "")
        aim_id = remote.get("aim_session_id", "")
        by_name = session_store.find_by_filename(filename) if filename else None
        if not by_name and aim_id:
            by_name = session_store.find_by_aim_session_id(aim_id)
        if by_name:
            session_store.update_session(
                by_name["id"],
                remote_id=remote_id,
                sync_status="synced" if by_name.get("local_path") else "remote_only",
                **remote_meta,
            )
            continue

        # New remote session — add as remote_only
        session_store.add_session(
            filename=filename,
            source="railway",
            sync_status="remote_only",
            remote_id=remote_id,
            aim_session_id=remote.get("aim_session_id", ""),
            track_name=remote.get("track_name", ""),
            driver_name=remote.get("driver_name", ""),
            vehicle_name=remote.get("vehicle_name", ""),
            recorded_at=remote.get("recorded_at"),
            duration_s=remote.get("duration_s", 0),
            lap_count=remote.get("lap_count", 0),
        )
        stats["pulled"] += 1

    # --- Push: upload local_only sessions ---
    local_sessions = session_store.list_sessions()
    for local in local_sessions:
        if local["sync_status"] != "local_only":
            continue
        if not local.get("local_path"):
            continue

        file_path = Path(local["local_path"])
        if not file_path.exists():
            continue

        try:
            session_store.update_session(local["id"], sync_status="uploading")
            result = await railway_client.upload_session_file(file_path)
            if result.get("ok"):
                session_store.update_session(
                    local["id"],
                    sync_status="synced",
                )
                stats["pushed"] += 1
            else:
                session_store.update_session(local["id"], sync_status="local_only")
                stats["errors"].append(f"Upload failed for {local['filename']}: {result}")
        except Exception as exc:
            session_store.update_session(local["id"], sync_status="local_only")
            stats["errors"].append(f"Upload failed for {local['filename']}: {exc}")

    return stats


async def pull_session(session_id: str) -> dict:
    """Download a specific remote_only session's file from Railway."""
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    remote_id = entry.get("remote_id")
    if not remote_id:
        return {"ok": False, "error": "No remote ID for this session"}

    dest = session_store.session_file_path(entry["filename"])

    try:
        session_store.update_session(session_id, sync_status="downloading")
        await railway_client.download_session_file(remote_id, dest)

        # Fetch latest metadata from Railway so edits are preserved
        update_fields = {"local_path": str(dest), "sync_status": "synced"}
        try:
            remote_data = await railway_client.get_remote_session(remote_id)
            for key in ("track_name", "driver_name", "vehicle_name",
                        "recorded_at", "duration_s", "lap_count", "championship_name"):
                if key in remote_data and remote_data[key]:
                    update_fields[key] = remote_data[key]
        except Exception:
            logger.warning("Could not fetch remote metadata for session %s", remote_id)

        session_store.update_session(session_id, **update_fields)
        return {"ok": True, "local_path": str(dest)}
    except Exception as exc:
        session_store.update_session(session_id, sync_status="remote_only")
        return {"ok": False, "error": str(exc)}
