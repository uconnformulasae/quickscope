"""File logging for AiM live discovery and streaming (mirrors console)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

_LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_live"
_AIM_LIVE_LOGGERS = (
    "services.aim_live",
    "services.aim_discovery",
    "services.aim_live_trace",
    "routes.live",
)

_file_handler: logging.FileHandler | None = None


def setup_aim_live_file_logging() -> Path:
    """Attach a daily rotating file handler to AIM live-related loggers."""
    global _file_handler
    if _file_handler is not None:
        return Path(_file_handler.baseFilename)

    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    log_path = _LOG_DIR / f"aim_live_{day}.log"
    _file_handler = logging.FileHandler(log_path, encoding="utf-8")
    _file_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    )
    for name in _AIM_LIVE_LOGGERS:
        log = logging.getLogger(name)
        log.addHandler(_file_handler)
        log.propagate = True

    logging.getLogger(__name__).info("AiM live file log: %s", log_path)
    return log_path
