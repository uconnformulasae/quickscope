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


def _exit_when_parent_goes_away() -> None:
    """Shut down when stdin closes.

    The Electron wrapper holds our stdin open and never writes to it, so EOF
    means the wrapper is gone -- including the ways it can die without running
    a quit handler (crash, force-kill, Windows logoff). Without this the
    backend lives on as an orphan holding its port and the session files.
    """

    def watch() -> None:
        try:
            while os.read(0, 1024):
                pass
        except OSError:
            return  # no usable stdin: nothing to watch
        if os.name == "nt":
            os._exit(0)  # no SIGTERM delivery on Windows; writes are atomic anyway
        os.kill(os.getpid(), signal.SIGTERM)  # lets uvicorn shut down cleanly

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


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
