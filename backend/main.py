"""
QuickScope — Python/libxrk backend
Parses .xrk files using libxrk and serves channel data via FastAPI.
Multi-session with local persistence and AiM device integration.
"""

import asyncio
import logging
import os

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

# Only the local UI may call the API from a browser. Any web page can otherwise
# reach a backend on localhost. The packaged Electron app loads from file://
# (Origin: null) and opts in via QUICKSCOPE_ALLOW_NULL_ORIGIN.
_CORS_ORIGINS = ["null"] if os.environ.get("QUICKSCOPE_ALLOW_NULL_ORIGIN") == "1" else []

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(analysis.router)
app.include_router(settings.router)
app.include_router(live.router)


@app.on_event("startup")
async def _startup() -> None:
    log_path = setup_aim_live_file_logging()
    logger.info("AiM live diagnostics log file: %s", log_path)
    get_aim_primary_hub().bind_loop(asyncio.get_running_loop())
    result = session_store.migrate_legacy_entries()
    if result["pruned"] or result["cleaned"]:
        logger.info(
            "Migrated session index from cloud-sync era: %d remote-only entries removed, %d cleaned",
            result["pruned"],
            result["cleaned"],
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
