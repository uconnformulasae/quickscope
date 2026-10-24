"""Which browser origins may talk to the local API.

Any web page can reach a backend on localhost, so only the local UI is
trusted: the Vite dev server / Docker UI on localhost, and the packaged
Electron renderer, which is served from the privileged ``app://quickscope``
scheme (see ``electron/main.cjs``). Ordinary websites can never send that
origin. ``Origin: null`` is deliberately NOT trusted -- any site can produce
it from a sandboxed iframe.
"""

from __future__ import annotations

import re

ELECTRON_ORIGIN = "app://quickscope"
ALLOWED_ORIGINS = [ELECTRON_ORIGIN]
ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

_ORIGIN_RE = re.compile(ALLOWED_ORIGIN_REGEX)


def is_allowed_origin(origin: str | None) -> bool:
    """True for a trusted UI origin, or when no Origin header was sent.

    Non-browser clients (scripts, tests) send no Origin; browsers always send
    one on WebSocket handshakes, which is what CORS never covers.
    """
    if origin is None:
        return True
    return origin in ALLOWED_ORIGINS or bool(_ORIGIN_RE.match(origin))
