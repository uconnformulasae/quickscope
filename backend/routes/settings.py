"""Settings routes."""

from fastapi import APIRouter, HTTPException

from services import settings_store

router = APIRouter(prefix="/api")


@router.get("/settings")
async def get_settings():
    return settings_store.load()


@router.put("/settings")
async def update_settings(body: dict):
    try:
        return settings_store.update(body)
    except settings_store.SettingsError as exc:
        raise HTTPException(400, str(exc))
