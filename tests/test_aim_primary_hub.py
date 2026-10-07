"""Hub locking: a cancelled websocket must never wedge the AiM connection."""

from __future__ import annotations

import asyncio

import pytest

from services.aim_primary_hub import AimPrimaryHub


def test_cancel_during_connect_releases_lock(monkeypatch):
    async def scenario():
        hub = AimPrimaryHub()
        started = asyncio.Event()

        async def slow_connect(*_a, **_k):
            started.set()
            await asyncio.sleep(60)

        monkeypatch.setattr(hub, "ensure_primary", slow_connect)
        task = asyncio.create_task(hub.acquire_for_live("10.0.0.1"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return hub

    hub = asyncio.run(scenario())
    assert not hub._lock.locked(), "cancelled acquire left the hub lock held"
    assert hub._live_active is False


def test_failed_connect_releases_lock_and_propagates(monkeypatch):
    async def scenario():
        hub = AimPrimaryHub()

        async def fail(*_a, **_k):
            raise ConnectionRefusedError("device off")

        monkeypatch.setattr(hub, "ensure_primary", fail)
        with pytest.raises(ConnectionRefusedError):
            await hub.acquire_for_live("10.0.0.1")
        return hub

    hub = asyncio.run(scenario())
    assert not hub._lock.locked()
    assert hub._live_active is False


def test_second_acquire_waits_for_first_then_succeeds(monkeypatch):
    async def scenario():
        hub = AimPrimaryHub()
        sentinel = object()

        async def ok(*_a, **_k):
            return sentinel

        monkeypatch.setattr(hub, "ensure_primary", ok)
        assert await hub.acquire_for_live("h") is sentinel
        assert hub._lock.locked()

        second = asyncio.create_task(hub.acquire_for_live("h"))
        await asyncio.sleep(0.05)
        assert not second.done()

        await hub.release_live()
        assert await asyncio.wait_for(second, 1) is sentinel

    asyncio.run(scenario())
