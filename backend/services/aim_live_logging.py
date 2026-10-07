"""File logging for AiM live discovery and streaming (mirrors console)."""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

_LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_live"
_AIM_LIVE_LOGGERS = (
    "services.aim_live",
    "services.aim_discovery",
    "services.aim_live_trace",
    "routes.live",
)

_file_handler: logging.handlers.TimedRotatingFileHandler | None = None


def setup_aim_live_file_logging() -> Path:
    """Attach a daily-rotating file handler (UTC midnight, 14 days kept) to AIM live-related loggers."""
    global _file_handler
    if _file_handler is not None:
        return Path(_file_handler.baseFilename)

    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = _LOG_DIR / "aim_live.log"
    _file_handler = logging.handlers.TimedRotatingFileHandler(
        log_path, when="midnight", utc=True, backupCount=14, encoding="utf-8"
    )
    _file_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    )
    for name in _AIM_LIVE_LOGGERS:
        log = logging.getLogger(name)
        log.addHandler(_file_handler)
        log.propagate = True

    logging.getLogger(__name__).info("AiM live file log: %s", log_path)
    return log_path
