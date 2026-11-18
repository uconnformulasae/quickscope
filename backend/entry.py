"""
QuickScope backend — PyInstaller entry point.

Reads host/port from env vars (QUICKSCOPE_HOST, QUICKSCOPE_PORT) so the
Electron wrapper can coordinate. Defaults match the dev setup.
"""

import os
import signal
import sys
import threading

import uvicorn


def _wait_for_process_exit(pid: int) -> None:
    """Block until process ``pid`` exits (Windows). Returns at once if it can't be opened."""
    import ctypes
    from ctypes import wintypes

    synchronize = 0x00100000
    infinite = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return
    try:
        kernel32.WaitForSingleObject(handle, infinite)
    finally:
        kernel32.CloseHandle(handle)


def _exit_when_parent_goes_away() -> None:
    """Shut down when the Electron wrapper is gone.

    Covers the ways it can die without running a quit handler (crash,
    force-kill, Windows logoff). Without this the backend lives on as an
    orphan holding its port and the session files.

    POSIX: the wrapper holds our stdin open and never writes, so EOF means it
    is gone. Windows: wait on the parent process handle instead -- a pending
    blocking read on the stdin pipe stalls other I/O on that handle and froze
    startup before uvicorn bound its port.
    """

    def watch_stdin() -> None:
        try:
            while os.read(0, 1024):
                pass
        except OSError:
            return  # no usable stdin: nothing to watch
        os.kill(os.getpid(), signal.SIGTERM)  # lets uvicorn shut down cleanly

    def watch_parent() -> None:
        _wait_for_process_exit(os.getppid())
        os._exit(0)  # no SIGTERM delivery on Windows; writes are atomic anyway

    target = watch_parent if os.name == "nt" else watch_stdin
    threading.Thread(target=target, name="parent-watch", daemon=True).start()


def main() -> int:
    host = os.environ.get("QUICKSCOPE_HOST", "127.0.0.1")
    port = int(os.environ.get("QUICKSCOPE_PORT", "8000"))

    # Opt-in: a plain terminal launch has no parent holding stdin open.
    if os.environ.get("QUICKSCOPE_EXIT_WITH_PARENT") == "1":
        _exit_when_parent_goes_away()

    from main import app

    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
