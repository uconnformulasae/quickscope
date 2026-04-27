"""Live-data WebSocket endpoint.

Wraps `AimLiveClient.stream()` and forwards each snapshot to a WebSocket
client as JSON. One WebSocket = one live session against the device. We
explicitly do NOT support fanning a single device stream out to multiple
WebSocket clients yet — the device only tolerates one TCP poller at a time
and we'd need a session-state machine on top to coordinate. For an FSAE
team's pit-side analysis tool, single-client-at-a-time is fine.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services import aim_live
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/api/live/ws")
async def live_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    settings = load_settings()
    host = settings.get("aim_device_ip", "10.0.0.1")
    client = aim_live.AimLiveClient(host=host)
    try:
        await client.connect()
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close()
        return

    await websocket.send_json({
        "type": "connected",
        "device": {
            "ip": client.identity.ip if client.identity else host,
            "model": client.identity.model if client.identity else "",
            "serial": client.identity.serial if client.identity else "",
            "vehicle": client.identity.vehicle if client.identity else "",
        },
    })

    # Run the live-poll loop in a task so we can also listen for client
    # close/abort messages on the WebSocket.
    stop = asyncio.Event()

    async def _pump_live() -> None:
        try:
            async for snap in client.stream():
                if stop.is_set():
                    break
                await websocket.send_json({
                    "type": "snapshot",
                    "ts": snap.timestamp_ms,
                    "subsystem": snap.subsystem,
                    "raw": snap.raw_b64,
                })
        except Exception as exc:
            logger.exception("live stream pump failed")
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except Exception:
                pass

    pump_task = asyncio.create_task(_pump_live())
    try:
        while True:
            # Receive any client message (we mostly use this to detect disconnect).
            msg = await websocket.receive_text()
            if msg == "stop":
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("live ws receive failed")
    finally:
        stop.set()
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        await client.close()
        try:
            await websocket.close()
        except Exception:
            pass


@router.get("/api/live/status")
async def live_status() -> dict:
    """Quick reachability probe — does NOT establish a TCP session.

    Returns the parsed identity if the device replies to a UDP probe.
    """
    settings = load_settings()
    host = settings.get("aim_device_ip", "10.0.0.1")
    ident = await aim_live.discover(ip=host)
    if ident is None:
        return {"reachable": False, "host": host}
    return {
        "reachable": True,
        "host": host,
        "device": {
            "ip": ident.ip,
            "model": ident.model,
            "serial": ident.serial,
            "vehicle": ident.vehicle,
        },
    }
