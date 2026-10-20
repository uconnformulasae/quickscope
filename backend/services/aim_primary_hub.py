"""Shared primary TCP session to the AiM device (Race Studio model).

Wireshark reference: ``connect.pcapng`` stream 29 and ``RS3_PULL_241/242`` — one
TCP socket for connect, live enumeration, live polling, session list *and* log
file download. ``download_sessions`` keeps the whole pull on that socket.

The legacy fallback (``aim_connector.download_aim_session``) opens a fresh TCP;
the device ignores a second port-2000 connection while this one is open, so it
must only run after ``release_for_download``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from services.aim_device_cache import get_cached
from services.aim_discovery import DEFAULT_DEVICE_IP, configured_device_ip
from services.aim_live import AimLiveClient
from services.aim_live_trace import AimLiveTrace
from services.settings_store import load as load_settings

logger = logging.getLogger(__name__)

_hub: Optional[AimPrimaryHub] = None


class AimLiveActiveError(ConnectionError):
    """A pull or list was requested while live view owns the primary TCP."""


FileStartCallback = Callable[[int, str, int], None]
FileDoneCallback = Callable[[str, Path, float, dict], None]
ProgressCallback = Callable[[int, int], None]


@dataclass
class PrimaryPullResult:
    """Outcome of ``download_sessions``: what landed and what still needs a download."""

    device_meta_by_file: dict[str, dict] = field(default_factory=dict)
    downloaded: list[str] = field(default_factory=list)
    remaining: list[str] = field(default_factory=list)
    error: Exception | None = None


def get_aim_primary_hub() -> AimPrimaryHub:
    global _hub
    if _hub is None:
        _hub = AimPrimaryHub()
    return _hub


class AimPrimaryHub:
    """One primary ``AimLiveClient`` TCP; exclusive lock for live vs list."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = asyncio.Lock()
        self._client: AimLiveClient | None = None
        self._live_active = False
        # Session list fetched on the current primary client; reused by the
        # next pull so it can go straight to the file request like RS3.
        self._listed_by: AimLiveClient | None = None
        self._listed_sessions: list[dict] = []

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def can_run_async(self) -> bool:
        return self._loop is not None and self._loop.is_running()

    def run_sync(self, coro):  # noqa: ANN001
        if self._loop is None:
            raise RuntimeError("AiM primary hub has no event loop")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=120)

    def resolve_host(self, host: str | None) -> str:
        """Explicit host, else cached discovery IP, else settings/default."""
        if host:
            return host
        cached = get_cached()
        if cached is not None:
            return cached.ip
        return load_settings().get("aim_device_ip", configured_device_ip() or DEFAULT_DEVICE_IP)

    async def ensure_primary(
        self,
        host: str | None = None,
        *,
        trace: AimLiveTrace | None = None,
    ) -> AimLiveClient:
        """Connect + live handshake on primary TCP if not already up."""
        target = self.resolve_host(host)
        if (
            self._client is not None
            and self._client.connected
            and getattr(self._client, "_handshake_done", False)
            and self._client.host == target
        ):
            if trace is not None:
                # Rebind to the current WS session's trace -- the client
                # itself is being reused (fast reconnect, TCP kept open),
                # but its old trace file was already closed when the
                # previous WS session ended.
                self._client._session_trace = trace
            return self._client

        await self.close_primary()
        logger.info("AiM primary hub: opening TCP to %s (live handshake)", target)
        client = AimLiveClient(host=target, trace=trace)
        try:
            await client.connect()
        except BaseException:
            await client.close()
            raise
        self._client = client
        return client

    async def list_sessions(self, host: str | None = None) -> list[dict]:
        self._raise_if_live("Cannot list AiM sessions while live view is active. Close live view first.")
        async with self._lock:
            self._raise_if_live("Cannot list AiM sessions while live view is active. Close live view first.")
            client = await self.ensure_primary(host)
            return await self._fetch_list(client)

    async def _fetch_list(self, client: AimLiveClient) -> list[dict]:
        sessions = await client.fetch_session_list()
        self._listed_by, self._listed_sessions = client, sessions
        return sessions

    def _cached_list(self, client: AimLiveClient) -> list[dict] | None:
        if self._listed_by is client and self._listed_sessions:
            return self._listed_sessions
        return None

    def _raise_if_live(self, message: str) -> None:
        if self._live_active:
            raise AimLiveActiveError(message)

    async def download_sessions(
        self,
        filenames: list[str],
        dest_dir_for: Callable[[str], Path],
        *,
        host: str | None = None,
        on_file_start: FileStartCallback | None = None,
        on_progress: ProgressCallback | None = None,
        on_file_done: FileDoneCallback | None = None,
    ) -> PrimaryPullResult:
        """Pull ``filenames`` on the primary TCP (RS3_PULL_241/242), keeping it open.

        Stops at the first failure and closes the primary, so the caller can
        retry the rest over the legacy download TCP; that error is returned in
        ``result.error`` rather than raised. Only ``AimLiveActiveError`` raises.
        """
        live_msg = "Close live view before downloading logs from the AiM device."
        self._raise_if_live(live_msg)
        result = PrimaryPullResult(remaining=list(filenames))
        async with self._lock:
            self._raise_if_live(live_msg)
            try:
                client = await self.ensure_primary(host)
                sessions = self._cached_list(client)
                if sessions is None:
                    sessions = await self._fetch_list(client)
                result.device_meta_by_file = _meta_by_file(sessions)
                for index, filename in enumerate(filenames, start=1):
                    meta = result.device_meta_by_file.get(filename, {})
                    expected_size = int(meta.get("size", 0) or 0)
                    if on_file_start is not None:
                        on_file_start(index, filename, expected_size)
                    started = time.monotonic()
                    path = await client.download_file(
                        filename, dest_dir_for(filename), expected_size, on_progress,
                    )
                    result.remaining.remove(filename)
                    result.downloaded.append(filename)
                    if on_file_done is not None:
                        on_file_done(filename, path, time.monotonic() - started, meta)
                    # RS3 re-lists right after every download; it also leaves the
                    # socket in the state the next file request was captured in.
                    result.device_meta_by_file = _meta_by_file(await self._fetch_list(client))
            except (ConnectionError, TimeoutError, RuntimeError, OSError) as exc:
                logger.warning(
                    "AiM primary hub: pull stopped on primary TCP (%s); %d file(s) left",
                    exc,
                    len(result.remaining),
                )
                result.error = exc
                await self.close_primary()
        return result

    async def acquire_for_live(
        self,
        host: str | None = None,
        *,
        trace: AimLiveTrace | None = None,
    ) -> AimLiveClient:
        await self._lock.acquire()
        try:
            self._live_active = True
            return await self.ensure_primary(host, trace=trace)
        except BaseException:
            # BaseException so a cancelled websocket (CancelledError) also releases the lock
            self._live_active = False
            self._lock.release()
            raise

    async def release_live(self) -> None:
        try:
            self._live_active = False
            if self._client is not None:
                await self._client.stop_streaming()
            logger.info("AiM primary hub: live released, TCP kept open")
        finally:
            if self._lock.locked():
                self._lock.release()

    async def release_for_download(self) -> None:
        """Close primary TCP so the legacy ``download_aim_session`` can open its own socket."""
        self._raise_if_live("Close live view before downloading logs from the AiM device.")
        async with self._lock:
            await self.close_primary()
            logger.info("AiM primary hub: released primary TCP for file download")

    async def close_primary(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
        self._listed_by, self._listed_sessions = None, []
        self._live_active = False


def _meta_by_file(sessions: list[dict]) -> dict[str, dict]:
    return {s["filename"]: s for s in sessions if s.get("filename")}
