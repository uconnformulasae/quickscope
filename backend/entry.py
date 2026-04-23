"""
QuickScope backend — PyInstaller entry point.

Reads host/port from env vars (QUICKSCOPE_HOST, QUICKSCOPE_PORT) so the
Electron wrapper can coordinate. Defaults match the dev setup.
"""

import os
import sys

import uvicorn


def main() -> int:
    host = os.environ.get("QUICKSCOPE_HOST", "127.0.0.1")
    port = int(os.environ.get("QUICKSCOPE_PORT", "8000"))

    from main import app

    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
