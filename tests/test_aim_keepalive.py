"""UDP aim-ka keep-alive: cadence, cache refresh, port fallback, client wiring."""

from __future__ import annotations

import asyncio
import socket

from services import aim_live
from services.aim_device_cache import clear_cache_for_tests, get_cached
from services.aim_discovery import DISCOVERY_MAGIC
from services.aim_keepalive import AimKeepalive
from routes import sessions
from services.aim_live import (
    RECONNECT_HANDSHAKE_TIMEOUT_S,
    RECONNECT_HELLO_TIMEOUT_S,
    RECONNECT_TCP_TIMEOUT_S,
    AimLiveClient,
)

_REPLY = b"\xec\x00\x00\x00" + b"\x00" * 120 + b"AiM-EVO5-00740-UConn-EV" + b"\x00" * 97


class _FakeDeviceUdp(asyncio.DatagramProtocol):
    def __init__(self, *, reply: bool = True) -> None:
        self.reply = reply
        self.probes: list[bytes] = []
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport) -> None:  # noqa: ANN001
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:  # noqa: ANN001
        self.probes.append(data)
        if self.reply and self.transport is not None:
            self.transport.sendto(_REPLY, addr)


async def _start_fake_device(*, reply: bool = True) -> tuple[_FakeDeviceUdp, asyncio.DatagramTransport, int]:
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(
        lambda: _FakeDeviceUdp(reply=reply), local_addr=("127.0.0.1", 0)
    )
    return proto, transport, transport.get_extra_info("sockname")[1]


def test_keepalive_sends_periodically_and_refreshes_cache() -> None:
    async def body() -> None:
        clear_cache_for_tests()
        device, device_transport, device_port = await _start_fake_device()
        keepalive = AimKeepalive("127.0.0.1", interval_s=0.05, device_port=device_port, local_port=0)
        try:
            await keepalive.start()
            await asyncio.sleep(0.3)
        finally:
            await keepalive.stop()
            device_transport.close()

        assert len(device.probes) >= 4
        assert all(p == DISCOVERY_MAGIC for p in device.probes)
        assert keepalive.reply_count >= 3
        assert keepalive.last_reply_age_s is not None and keepalive.last_reply_age_s < 1.0
        cached = get_cached()
        assert cached is not None
        assert cached.ip == "127.0.0.1"
        assert cached.serial == "00740"

    asyncio.run(body())


def test_keepalive_falls_back_to_ephemeral_port_when_preferred_is_taken() -> None:
    async def body() -> None:
        device, device_transport, device_port = await _start_fake_device()
        blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        blocker.bind(("0.0.0.0", 0))
        taken_port = blocker.getsockname()[1]
        keepalive = AimKeepalive(
            "127.0.0.1", interval_s=0.05, device_port=device_port, local_port=taken_port
        )
        try:
            await keepalive.start()
            await asyncio.sleep(0.15)
        finally:
            await keepalive.stop()
            device_transport.close()
            blocker.close()

        assert keepalive.bound_port not in (None, taken_port)
        assert device.probes

    asyncio.run(body())


def test_keepalive_stop_is_idempotent_and_stops_sending() -> None:
    async def body() -> None:
        device, device_transport, device_port = await _start_fake_device(reply=False)
        keepalive = AimKeepalive("127.0.0.1", interval_s=0.03, device_port=device_port, local_port=0)
        await keepalive.start()
        await asyncio.sleep(0.1)
        await keepalive.stop()
        await keepalive.stop()
        sent_at_stop = len(device.probes)
        await asyncio.sleep(0.1)
        device_transport.close()

        assert not keepalive.running
        assert keepalive.reply_count == 0
        assert keepalive.last_reply_age_s is None
        assert len(device.probes) == sent_at_stop

    asyncio.run(body())


def test_reconnect_with_retry_uses_short_timeouts(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        client = AimLiveClient(host="127.0.0.1")
        calls: list[dict] = []

        async def fake_reconnect(**kwargs) -> None:  # noqa: ANN003
            calls.append(kwargs)

        client._reconnect = fake_reconnect  # type: ignore[method-assign]
        await client._reconnect_with_retry()

        assert calls == [
            {
                "timeout": RECONNECT_HANDSHAKE_TIMEOUT_S,
                "hello_timeout": RECONNECT_HELLO_TIMEOUT_S,
                "tcp_timeout": RECONNECT_TCP_TIMEOUT_S,
            }
        ]

    asyncio.run(body())


def test_unanswered_hello_on_reconnect_fails_fast(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        async def silent_device(reader, writer) -> None:  # noqa: ANN001
            while await reader.read(100):
                pass
            writer.close()

        server = await asyncio.start_server(silent_device, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(aim_live, "get_cached", lambda: None)
        client = AimLiveClient(host="127.0.0.1", port=port)
        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            try:
                await client.connect(discover_first=False, timeout=15.0, hello_timeout=0.2)
            except ConnectionError as exc:
                assert "hello-ack" in str(exc)
            else:
                raise AssertionError("connect should fail when hello is never answered")
            assert loop.time() - started < 2.0
        finally:
            await client.close()
            server.close()
            await server.wait_closed()

    asyncio.run(body())


class _FakeKeepalive:
    instances: list["_FakeKeepalive"] = []

    def __init__(self, host: str, *, fail: bool = False) -> None:
        self.host = host
        self.fail = fail
        self.running = False
        self.stopped = False
        self.bound_port = 36002
        self.sent_count = 0
        self.reply_count = 0
        self.last_reply_age_s = None
        _FakeKeepalive.instances.append(self)

    async def start(self) -> None:
        if self.fail:
            raise OSError("no socket")
        self.running = True

    async def stop(self) -> None:
        self.running = False
        self.stopped = True


def _install_fake_keepalive(monkeypatch, *, fail: bool = False) -> None:  # noqa: ANN001
    _FakeKeepalive.instances = []
    monkeypatch.setattr(aim_live, "AimKeepalive", lambda host: _FakeKeepalive(host, fail=fail))
    monkeypatch.setattr(aim_live, "get_cached", lambda: None)


async def _connect_to_closed_port(client: AimLiveClient) -> None:
    try:
        await client.connect(discover_first=False, tcp_timeout=1.0)
    except ConnectionError:
        pass


def _closed_tcp_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def test_live_connect_starts_keepalive_before_tcp(monkeypatch) -> None:  # noqa: ANN001
    """QS_Live_long_reconnect.pcapng: no aim-ka during live -> device FIN every 30.8 s."""

    async def body() -> None:
        _install_fake_keepalive(monkeypatch)
        client = AimLiveClient(host="127.0.0.1", port=_closed_tcp_port())
        await _connect_to_closed_port(client)

        assert len(_FakeKeepalive.instances) == 1
        assert _FakeKeepalive.instances[0].host == "127.0.0.1"
        assert _FakeKeepalive.instances[0].running

        await client.close()
        assert _FakeKeepalive.instances[0].stopped

    asyncio.run(body())


def test_live_reconnect_reuses_running_keepalive(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        _install_fake_keepalive(monkeypatch)
        client = AimLiveClient(host="127.0.0.1", port=_closed_tcp_port())
        await _connect_to_closed_port(client)
        await _connect_to_closed_port(client)

        assert len(_FakeKeepalive.instances) == 1
        await client.close()

    asyncio.run(body())


def test_live_keepalive_retargets_when_host_changes(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        _install_fake_keepalive(monkeypatch)
        client = AimLiveClient(host="127.0.0.1", port=_closed_tcp_port())
        await _connect_to_closed_port(client)
        client.host = "127.0.0.2"
        await client._ensure_keepalive()

        first, second = _FakeKeepalive.instances
        assert first.stopped
        assert second.host == "127.0.0.2" and second.running
        await client.close()

    asyncio.run(body())


def test_live_keepalive_start_failure_is_non_fatal(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        _install_fake_keepalive(monkeypatch, fail=True)
        client = AimLiveClient(host="127.0.0.1", port=_closed_tcp_port())
        try:
            await client.connect(discover_first=False, tcp_timeout=1.0)
        except ConnectionError as exc:
            # Windows times out on a closed port; POSIX refuses it.
            assert "TCP" in str(exc)
        else:
            raise AssertionError("closed port should still fail at TCP, not keepalive")
        assert client._keepalive is None
        await client.close()

    asyncio.run(body())


def test_hub_failed_connect_stops_keepalive(monkeypatch) -> None:  # noqa: ANN001
    from services.aim_primary_hub import AimPrimaryHub

    async def body() -> None:
        _install_fake_keepalive(monkeypatch)
        port = _closed_tcp_port()

        class _ClosedPortClient(AimLiveClient):
            def __init__(self, host: str, trace=None) -> None:  # noqa: ANN001
                super().__init__(host=host, port=port, trace=trace)

            async def connect(self, **kwargs) -> None:  # noqa: ANN003
                await super().connect(discover_first=False, tcp_timeout=1.0)

        from services import aim_primary_hub

        monkeypatch.setattr(aim_primary_hub, "AimLiveClient", _ClosedPortClient)
        hub = AimPrimaryHub()
        try:
            await hub.ensure_primary("127.0.0.1")
        except ConnectionError:
            pass
        else:
            raise AssertionError("closed port should fail")

        assert _FakeKeepalive.instances and all(k.stopped for k in _FakeKeepalive.instances)

    asyncio.run(body())


def test_download_keepalive_starts_and_stops(monkeypatch) -> None:  # noqa: ANN001

    async def body() -> None:
        device, device_transport, device_port = await _start_fake_device()
        real_keepalive = AimKeepalive

        def local_keepalive(host: str) -> AimKeepalive:
            return real_keepalive(host, interval_s=0.05, device_port=device_port, local_port=0)

        monkeypatch.setattr(sessions, "AimKeepalive", local_keepalive)
        keepalive = await sessions._start_download_keepalive("127.0.0.1")
        assert keepalive is not None and keepalive.running
        await asyncio.sleep(0.2)
        assert device.probes

        await keepalive.stop()
        device_transport.close()
        assert not keepalive.running

    asyncio.run(body())


def test_download_keepalive_start_failure_is_non_fatal(monkeypatch) -> None:  # noqa: ANN001
    async def body() -> None:
        class Broken:
            def __init__(self, host: str) -> None:
                pass

            async def start(self) -> None:
                raise OSError("no socket")

        monkeypatch.setattr(sessions, "AimKeepalive", Broken)
        assert await sessions._start_download_keepalive("127.0.0.1") is None

    asyncio.run(body())
