"""Live-data WebSocket endpoint.

Wraps the shared primary ``AimLiveClient`` (same TCP as session list). One WebSocket
client at a time; log download uses a separate TCP via ``aim_connector``.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.aim_primary_hub import get_aim_primary_hub
from services.aim_discovery import DEFAULT_DEVICE_IP
from services.aim_device_cache import get_cached
from services import aim_live
from services.aim_live import user_visible_error
from services.aim_live_trace import AimLiveTrace
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/api/live/ws")
async def live_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    settings = load_settings()
    host = settings.get("aim_device_ip", DEFAULT_DEVICE_IP)
    cached = get_cached()
    if cached is not None:
        host = cached.ip
    logger.info(
        "Live WS: client connected (configured_host=%s cached=%s)",
        settings.get("aim_device_ip", DEFAULT_DEVICE_IP),
        cached.ip if cached else None,
    )
    trace = AimLiveTrace(configured_host=host)
    hub = get_aim_primary_hub()
    try:
        client = await hub.acquire_for_live(host, trace=trace)
    except Exception as exc:
        msg = user_visible_error(exc)
        trace.log("connect_failed", error=msg, exc_type=type(exc).__name__)
        logger.warning("Live WS: AiM connect failed: %s (trace=%s)", msg, trace.path)
        await websocket.send_json({"type": "error", "message": msg})
        trace.close(outcome="connect_failed")
        await websocket.close()
        return

    device_ip = client.identity.ip if client.identity else host
    logger.info(
        "Live WS: streaming to client (device_ip=%s model=%s serial=%s)",
        device_ip,
        client.identity.model if client.identity else "",
        client.identity.serial if client.identity else "",
    )

    await websocket.send_json({
        "type": "connected",
        "device": {
            "ip": client.identity.ip if client.identity else host,
            "model": client.identity.model if client.identity else "",
            "serial": client.identity.serial if client.identity else "",
            "vehicle": client.identity.vehicle if client.identity else "",
        },
    })

    # `raw_b64` is ~1 KB/snapshot and the UI only reads `channels` -- only
    # pay for it when a client explicitly asks (e.g. for offline debugging).
    send_raw = websocket.query_params.get("raw") == "1"

    # The device-facing pump and the WebSocket sender run as separate tasks
    # joined by a bounded queue, so a slow browser (a busy tab, backpressure
    # on the socket) can never hold up the loop that acks the AiM device --
    # `await websocket.send_json(...)` used to run inline in the same loop
    # that read `client.stream()`, which meant a slow client directly slowed
    # down the live poll. New snapshots crowd out old ones once the queue
    # fills, since only the latest data is useful to a live view.
    stop = asyncio.Event()
    device_dropped = False
    queue: asyncio.Queue = asyncio.Queue(maxsize=32)
    _SENTINEL = None

    def _snapshot_message(snap) -> dict:
        msg = {
            "type": "snapshot",
            "ts": snap.timestamp_ms,
            "subsystem": snap.subsystem,
            "channels": snap.channels,
        }
        if send_raw:
            msg["raw"] = snap.raw_b64
        return msg

    def _enqueue(item: dict) -> None:
        if queue.full():
            try:
                queue.get_nowait()  # drop the oldest, keep the newest
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(item)

    async def _pump_device() -> None:
        nonlocal device_dropped
        try:
            async for snap in client.stream():
                if stop.is_set():
                    break
                _enqueue(_snapshot_message(snap))
        except ConnectionError as exc:
            device_dropped = True
            logger.info("Live WS: device closed TCP during stream: %s", exc)
            _enqueue({
                "type": "error",
                "message": "AiM device closed the live connection. Close Race Studio live if open and retry.",
            })
        except Exception as exc:
            logger.exception("live stream pump failed")
            _enqueue({"type": "error", "message": str(exc)})
        finally:
            await queue.put(_SENTINEL)

    async def _send_loop() -> None:
        """Drain the queue and send to the browser, batching whatever piled
        up while a send was in flight so a burst costs one WS frame, not N."""
        while True:
            item = await queue.get()
            if item is _SENTINEL:
                return
            batch = [item]
            while not queue.empty():
                nxt = queue.get_nowait()
                if nxt is _SENTINEL:
                    await _send_batch(batch)
                    return
                batch.append(nxt)
            await _send_batch(batch)

    async def _send_batch(batch: list[dict]) -> None:
        try:
            if len(batch) == 1:
                await websocket.send_json(batch[0])
            else:
                await websocket.send_json({"type": "batch", "messages": batch})
        except Exception:
            logger.debug("Live WS: send failed (client likely disconnected)")
            raise

    pump_task = asyncio.create_task(_pump_device())
    send_task = asyncio.create_task(_send_loop())
    try:
        while True:
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
        send_task.cancel()
        for task in (pump_task, send_task):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if device_dropped:
            logger.info("Live WS: session ending, closing primary TCP after device drop")
            await hub.close_primary()
        else:
            logger.info("Live WS: session ending, releasing primary TCP (keep open)")
        await hub.release_live()
        trace.close(
            outcome="device_drop" if device_dropped else "normal",
            snapshots=client._snapshots_yielded,
            poll_a_timeouts=client._poll_a_timeouts,
        )
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
    host = settings.get("aim_device_ip", DEFAULT_DEVICE_IP)
    cached = get_cached()
    if cached is not None:
        logger.debug(
            "Live status: using cached device %s (age %.1fs)",
            cached.ip,
            cached.age_s(),
        )
        return {
            "reachable": True,
            "host": cached.ip,
            "source": "cache",
            "device": {
                "ip": cached.ip,
                "model": cached.model,
                "serial": cached.serial,
                "vehicle": cached.vehicle,
            },
        }
    ident = await aim_live.discover()
    if ident is None:
        logger.info("Live status: unreachable (configured_host=%s)", host)
        return {"reachable": False, "host": host}
    logger.debug(
        "Live status: reachable at %s model=%s serial=%s",
        ident.ip,
        ident.model,
        ident.serial,
    )
    return {
        "reachable": True,
        "host": ident.ip,
        "device": {
            "ip": ident.ip,
            "model": ident.model,
            "serial": ident.serial,
            "vehicle": ident.vehicle,
        },
    }
