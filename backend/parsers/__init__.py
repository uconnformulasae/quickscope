"""
XRK/XRZ parser selection: AiM DLL primary, libxrk fallback.
"""

from __future__ import annotations

import io
import logging
import os
import sys
import warnings
from contextlib import contextmanager
from pathlib import Path

from libxrk import aim_xrk
from libxrk.base import LogFile

from . import aim_dll
from .libxrk_fixup import normalize_libxrk_timestamps

logger = logging.getLogger("quickscope")

_PARSER_OVERRIDE = os.environ.get("QUICKSCOPE_PARSER", "").strip().lower()


@contextmanager
def _suppress_libxrk_noise():
    """Mute libxrk stdout prints and GPS RuntimeWarnings on fallback path."""
    old_filters = list(warnings.filters)
    warnings.filterwarnings("ignore", category=RuntimeWarning, module=r"libxrk\.gps")
    buf = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = buf
    try:
        yield
    finally:
        sys.stdout = old_stdout
        warnings.filters[:] = old_filters


def _parse_libxrk(path: Path) -> LogFile:
    with _suppress_libxrk_noise():
        log = aim_xrk(str(path))
    return normalize_libxrk_timestamps(log)


def parse_xrk(path: str | Path) -> LogFile:
    """
    Parse an XRK/XRZ file using the AiM DLL when available, else libxrk.

    Env overrides:
      QUICKSCOPE_PARSER=libxrk  — force libxrk
      QUICKSCOPE_PARSER=aim_dll — force DLL (raises on failure)
      AIM_XRK_DLL=<path>        — explicit DLL location
    """
    p = Path(path)

    if _PARSER_OVERRIDE == "libxrk":
        log = _parse_libxrk(p)
        logger.info("parsed %s via libxrk (forced)", p.name)
        return log

    if sys.platform == "win32" and aim_dll.dll_available():
        try:
            log = aim_dll.parse(p)
            logger.info("parsed %s via aim_dll", p.name)
            return log
        except Exception as exc:
            if _PARSER_OVERRIDE == "aim_dll":
                raise
            logger.warning(
                "aim_dll failed for %s: %s; falling back to libxrk",
                p.name,
                exc,
            )

    log = _parse_libxrk(p)
    logger.info("parsed %s via libxrk (fallback)", p.name)
    return log
