"""Live dashboard layout + device channel cache routes."""

from fastapi import APIRouter, HTTPException, Query

from services import live_channel_cache, live_layout_store
from services.live_layout_store import LayoutError

router = APIRouter(prefix="/api/live")


@router.get("/layouts")
async def list_layouts():
    """User layouts + selection state. Built-in layouts come from the client."""
    return live_layout_store.load()


@router.put("/layouts/{layout_id}")
async def put_layout(layout_id: str, body: dict):
    try:
        return live_layout_store.put_layout(layout_id, body)
    except LayoutError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/layouts/{layout_id}")
async def delete_layout(layout_id: str):
    if not live_layout_store.delete_layout(layout_id):
        raise HTTPException(status_code=404, detail="Layout not found")
    return {"ok": True}


# Separate path (not /layouts/selection) so it can never collide with a layout id.
@router.put("/layout-selection")
async def update_selection(body: dict):
    return live_layout_store.update_selection(body)


@router.get("/channels")
async def device_channels(vehicle: str = Query(..., pattern="^(ev|ic)$")):
    """Channels this car has sent on any previous live session (for the offline editor)."""
    return live_channel_cache.get(vehicle)
