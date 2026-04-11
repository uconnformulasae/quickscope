"""Settings routes."""

from fastapi import APIRouter

from services import settings_store

router = APIRouter(prefix="/api")


@router.get("/settings")
async def get_settings():
    return settings_store.load()


@router.put("/settings")
async def update_settings(body: dict):
    return settings_store.update(body)
