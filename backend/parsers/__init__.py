"""
XRK/XRZ parser selection: AiM DLL primary, libxrk fallback.
"""

from __future__ import annotations

import io
import logging
import os
import sys
import threading
import warnings
from contextlib import contextmanager
from pathlib import Path

from libxrk import aim_xrk
from libxrk.base import LogFile

from . import aim_dll
from .libxrk_fixup import normalize_libxrk_timestamps
from .parse_gate import PARSE_GATE, PRIORITY_INTERACTIVE

logger = logging.getLogger("quickscope")


def _parser_override() -> str:
    return os.environ.get("QUICKSCOPE_PARSER", "").strip().lower()


def _packaged_backend() -> bool:
    """PyInstaller-frozen backend shipped inside Electron installers (all platforms)."""
    return bool(getattr(sys, "frozen", False))


class _MutedForThread(io.TextIOBase):
    """``sys.stdout`` stand-in that drops one thread's writes and passes on the rest.

    ``sys.stdout`` is shared by the whole process, and parses run in worker
    threads: swapping in a plain buffer also swallowed whatever any other
    thread printed while a parse was running.
    """

    def __init__(self, target, thread_id: int) -> None:  # noqa: ANN001
        self._target = target
        self._thread_id = thread_id

    def write(self, text: str) -> int:
        # No console at all (windowed build): there is nowhere to pass it on to.
        if self._target is None or threading.get_ident() == self._thread_id:
            return len(text)
        return self._target.write(text)

    def flush(self) -> None:
        if self._target is not None:
            self._target.flush()

    def __getattr__(self, name: str):
        return getattr(self._target, name)


@contextmanager
def _suppress_libxrk_noise():
    """Mute libxrk stdout prints and GPS RuntimeWarnings on fallback path."""
    old_filters = list(warnings.filters)
    warnings.filterwarnings("ignore", category=RuntimeWarning, module=r"libxrk\.gps")
    old_stdout = sys.stdout
    sys.stdout = _MutedForThread(old_stdout, threading.get_ident())
    try:
        yield
    finally:
        sys.stdout = old_stdout
        warnings.filters[:] = old_filters


def _parse_libxrk(path: Path) -> LogFile:
    with _suppress_libxrk_noise():
        log = aim_xrk(str(path))
    return normalize_libxrk_timestamps(log)


def _parse_xrk_unlocked(p: Path) -> LogFile:
    if _packaged_backend():
        log = _parse_libxrk(p)
        logger.info("parsed %s via libxrk (packaged)", p.name)
        return log

    if _parser_override() == "libxrk":
        log = _parse_libxrk(p)
        logger.info("parsed %s via libxrk (forced)", p.name)
        return log

    if sys.platform == "win32" and aim_dll.dll_available():
        try:
            log = aim_dll.parse(p)
            logger.info("parsed %s via aim_dll", p.name)
            return log
        except Exception as exc:
            if _parser_override() == "aim_dll":
                raise
            logger.warning(
                "aim_dll failed for %s: %s; falling back to libxrk",
                p.name,
                exc,
            )

    log = _parse_libxrk(p)
    logger.info("parsed %s via libxrk (fallback)", p.name)
    return log


def parse_xrk(path: str | Path, priority: int = PRIORITY_INTERACTIVE) -> LogFile:
    """
    Parse an XRK/XRZ file using the AiM DLL when available (dev Windows), else libxrk.

    PyInstaller-frozen backends (desktop installers) always use libxrk.

    Env overrides:
      QUICKSCOPE_PARSER=libxrk  — force libxrk
      QUICKSCOPE_PARSER=aim_dll — force DLL (raises on failure)
      AIM_XRK_DLL=<path>        — explicit DLL location

    ``priority``: lower runs first when multiple parses are queued (see parse_gate).
    """
    p = Path(path)
    with PARSE_GATE.hold(priority):
        return _parse_xrk_unlocked(p)
