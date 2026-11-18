"""Which browser origins may talk to the local API.

Any web page can reach a backend on localhost, so only the local UI is
trusted: the Vite dev server / Docker UI on localhost, and the packaged
Electron renderer, which is served from the privileged ``app://quickscope``
scheme (see ``electron/main.cjs``). Ordinary websites can never send that
origin. ``Origin: null`` is deliberately NOT trusted -- any site can produce
it from a sandboxed iframe.

CORS alone is not enough: a "simple" cross-site POST (e.g. a multipart upload)
is sent without a preflight, and a DNS-rebinding page is same-origin as far as
the browser is concerned. ``LocalOnlyMiddleware`` therefore rejects any request
whose ``Origin`` is not a trusted UI or whose ``Host`` is not this machine.
Set ``QUICKSCOPE_ALLOWED_HOSTS`` (comma-separated hostnames/IPs) to also serve
the API to other machines, e.g. a laptop's LAN address.
"""

from __future__ import annotations

import os
import re

ELECTRON_ORIGIN = "app://quickscope"
ALLOWED_ORIGINS = [ELECTRON_ORIGIN]


def _extra_hosts() -> frozenset[str]:
    raw = os.environ.get("QUICKSCOPE_ALLOWED_HOSTS", "")
    return frozenset(h.strip().lower().strip("[]") for h in raw.split(",") if h.strip())


def _origin_regex() -> str:
    hosts = ["localhost", r"127\.0\.0\.1", *(re.escape(h) for h in sorted(_extra_hosts()))]
    return rf"^https?://({'|'.join(hosts)})(:\d+)?$"


# Read once at startup: this is what the CORS middleware is configured with,
# so a UI served from an opted-in host can also read the responses.
ALLOWED_ORIGIN_REGEX = _origin_regex()

_ORIGIN_RE = re.compile(ALLOWED_ORIGIN_REGEX)


def is_allowed_origin(origin: str | None) -> bool:
    """True for a trusted UI origin, or when no Origin header was sent.

    Non-browser clients (scripts, tests) send no Origin; browsers always send
    one on WebSocket handshakes, which is what CORS never covers.
    """
    if origin is None:
        return True
    return origin in ALLOWED_ORIGINS or bool(_ORIGIN_RE.match(origin))


_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _hostname(host_header: str) -> str:
    """``Host`` header without its port; IPv6 literals lose their brackets."""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if ":" in host else host


def is_allowed_host(host_header: str | None) -> bool:
    """True when the request was addressed to this machine by a trusted name.

    A DNS-rebinding page reaches the backend under the attacker's hostname, so
    the ``Host`` header is the one thing that gives it away.
    """
    if not host_header:
        return False
    name = _hostname(host_header)
    return name in _LOCAL_HOSTS or name in _extra_hosts()


def is_allowed_request_origin(origin: str | None) -> bool:
    """Like :func:`is_allowed_origin`, plus UIs served from an opted-in host."""
    if is_allowed_origin(origin):
        return True
    match = re.match(r"^https?://([^/]+)$", origin or "")
    return bool(match) and _hostname(match.group(1)) in _extra_hosts()


class LocalOnlyMiddleware:
    """Reject HTTP and WebSocket requests with a foreign ``Host`` or ``Origin``."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k: v for k, v in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1")
        origin = headers[b"origin"].decode("latin-1") if b"origin" in headers else None
        if is_allowed_host(host) and is_allowed_request_origin(origin):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b'{"detail":"Request not allowed from this host or origin"}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})
