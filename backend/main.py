"""
QuickScope — Python/libxrk backend
Parses .xrk files using libxrk and serves channel data via FastAPI.
Multi-session with local persistence and Railway/AiM sync.
"""

import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import sessions, analysis, settings, live
from services import session_store
from services.aim_live_logging import setup_aim_live_file_logging
from services.aim_primary_hub import get_aim_primary_hub

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="QuickScope Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(analysis.router)
app.include_router(settings.router)
app.include_router(live.router)


@app.on_event("startup")
async def _recover_stale_sync_state() -> None:
    """If the previous run crashed mid-sync, sessions can be stuck in
    'uploading' or 'downloading' forever. Reset them on boot so they re-enter
    the normal sync flow and the user sees them, instead of the silent
    "phone upload never showed up" experience."""
    log_path = setup_aim_live_file_logging()
    logger.info("AiM live diagnostics log file: %s", log_path)
    get_aim_primary_hub().bind_loop(asyncio.get_running_loop())
    reset = session_store.reset_stale_sync_states()
    if reset:
        logger.warning("Reset %d session(s) from stale uploading/downloading state", reset)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
