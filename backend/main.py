"""
QuickScope — Python/libxrk backend
Parses .xrk files using libxrk and serves channel data via FastAPI.
Multi-session with local persistence and AiM device integration.
"""

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from origins import ALLOWED_ORIGINS, ALLOWED_ORIGIN_REGEX
from routes import sessions, analysis, settings, live
from services import session_store
from services.aim_live_logging import setup_aim_live_file_logging

from contextlib import asynccontextmanager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_path = setup_aim_live_file_logging()
    logger.info("AiM live diagnostics log file: %s", log_path)
    result = session_store.migrate_legacy_entries()
    if result["pruned"] or result["cleaned"]:
        logger.info(
            "Migrated session index from cloud-sync era: %d remote-only entries removed, %d cleaned",
            result["pruned"],
            result["cleaned"],
        )
    yield


app = FastAPI(title="QuickScope Backend", lifespan=lifespan)

# Only the local UI may call the API from a browser (see origins.py).
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(analysis.router)
app.include_router(settings.router)
app.include_router(live.router)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("QUICKSCOPE_HOST", "127.0.0.1")
    port = int(os.environ.get("QUICKSCOPE_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
