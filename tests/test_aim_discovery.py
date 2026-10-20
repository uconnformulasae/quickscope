"""Tests for shared AiM UDP discovery (no real sockets)."""

from __future__ import annotations

import socket

import pytest

from services import aim_discovery, settings_store


class FakeSocket:
    """Records socket calls and replays a scripted ``recvfrom`` outcome."""

    instances: list["FakeSocket"] = []
    reply: object = None  # bytes, (bytes, addr) tuple, or an exception instance

    def __init__(self, *_args):
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.opts: list[tuple] = []
        self.timeout: float | None = None
        FakeSocket.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def settimeout(self, timeout):
        self.timeout = timeout

    def setsockopt(self, *args):
        self.opts.append(args)

    def sendto(self, data, addr):
        self.sent.append((data, addr))

    def recvfrom(self, _bufsize):
        reply = FakeSocket.reply
        if isinstance(reply, BaseException):
            raise reply
        if isinstance(reply, tuple):
            return reply
        return reply, (self.sent[-1][1][0], aim_discovery.DISCOVERY_PORT)


@pytest.fixture
def fake_socket(monkeypatch):
    FakeSocket.instances = []
    FakeSocket.reply = None
    monkeypatch.setattr(aim_discovery.socket, "socket", FakeSocket)
    return FakeSocket


# ── candidate IPs ──────────────────────────────────────────────────────────


def test_configured_device_ip_defaults_to_10_0_0_1():
    assert aim_discovery.configured_device_ip() == "10.0.0.1"


def test_candidate_ips_put_configured_ip_first_without_duplicates():
    settings_store.update({"aim_device_ip": "192.168.4.1"})

    candidates = aim_discovery.candidate_device_ips()

    assert candidates[0] == "192.168.4.1"
    assert candidates.count("192.168.4.1") == 1
    assert set(candidates) == {"192.168.4.1", "10.0.0.1", "192.168.137.1", "192.168.1.1"}


def test_candidate_ips_append_defaults_after_custom_ip():
    settings_store.update({"aim_device_ip": "172.16.0.9"})

    assert aim_discovery.candidate_device_ips() == [
        "172.16.0.9",
        "10.0.0.1",
        "192.168.137.1",
        "192.168.1.1",
        "192.168.4.1",
    ]


# ── udp_probe ──────────────────────────────────────────────────────────────


def test_udp_probe_sends_magic_and_returns_reply(fake_socket):
    fake_socket.reply = b"AiM-EVO5-00740-Car"

    assert aim_discovery.udp_probe("10.0.0.1", timeout=0.5) == b"AiM-EVO5-00740-Car"
    sock = fake_socket.instances[0]
    assert sock.sent == [(b"aim-ka", ("10.0.0.1", 36002))]
    assert sock.timeout == 0.5


def test_udp_probe_returns_none_on_empty_reply(fake_socket):
    fake_socket.reply = b""
    assert aim_discovery.udp_probe("10.0.0.1") is None


def test_udp_probe_returns_none_on_timeout(fake_socket):
    fake_socket.reply = socket.timeout()
    assert aim_discovery.udp_probe("10.0.0.1") is None


def test_udp_probe_returns_none_on_os_error(fake_socket):
    fake_socket.reply = OSError("network unreachable")
    assert aim_discovery.udp_probe("10.0.0.1") is None


# ── broadcast_probe ────────────────────────────────────────────────────────


def test_broadcast_probe_returns_sender_ip_and_reply(fake_socket):
    fake_socket.reply = (b"AiM-EVO5-1-Car", ("10.0.0.7", 36002))

    assert aim_discovery.broadcast_probe(timeout=0.25) == ("10.0.0.7", b"AiM-EVO5-1-Car")
    sock = fake_socket.instances[0]
    assert sock.sent == [(b"aim-ka", ("255.255.255.255", 36002))]
    assert (socket.SOL_SOCKET, socket.SO_BROADCAST, 1) in sock.opts
    assert sock.timeout == 0.25


def test_broadcast_probe_returns_none_on_empty_reply(fake_socket):
    fake_socket.reply = (b"", ("10.0.0.7", 36002))
    assert aim_discovery.broadcast_probe() is None


def test_broadcast_probe_returns_none_on_timeout(fake_socket):
    fake_socket.reply = socket.timeout()
    assert aim_discovery.broadcast_probe() is None


def test_broadcast_probe_returns_none_on_os_error(fake_socket):
    fake_socket.reply = OSError("permission denied")
    assert aim_discovery.broadcast_probe() is None


# ── probe_device_ips ───────────────────────────────────────────────────────


def test_probe_device_ips_returns_first_candidate_that_replies(monkeypatch):
    probed: list[str] = []

    def fake_udp_probe(ip, timeout=2.0):
        probed.append(ip)
        return b"reply" if ip == "192.168.137.1" else None

    monkeypatch.setattr(aim_discovery, "udp_probe", fake_udp_probe)
    monkeypatch.setattr(
        aim_discovery, "broadcast_probe", lambda timeout=2.0: pytest.fail("broadcast not expected")
    )

    assert aim_discovery.probe_device_ips() == ("192.168.137.1", b"reply")
    assert probed == ["10.0.0.1", "192.168.137.1"]


def test_probe_device_ips_falls_back_to_broadcast(monkeypatch):
    monkeypatch.setattr(aim_discovery, "udp_probe", lambda ip, timeout=2.0: None)
    monkeypatch.setattr(
        aim_discovery, "broadcast_probe", lambda timeout=2.0: ("10.1.2.3", b"bcast")
    )

    assert aim_discovery.probe_device_ips() == ("10.1.2.3", b"bcast")


def test_probe_device_ips_returns_none_when_nothing_replies(monkeypatch):
    monkeypatch.setattr(aim_discovery, "udp_probe", lambda ip, timeout=2.0: None)
    monkeypatch.setattr(aim_discovery, "broadcast_probe", lambda timeout=2.0: None)

    assert aim_discovery.probe_device_ips() is None


def test_probe_device_ips_forwards_timeout(monkeypatch):
    timeouts: list[float] = []

    def fake_udp_probe(ip, timeout=2.0):
        timeouts.append(timeout)
        return None

    def fake_broadcast(timeout=2.0):
        timeouts.append(timeout)
        return None

    monkeypatch.setattr(aim_discovery, "udp_probe", fake_udp_probe)
    monkeypatch.setattr(aim_discovery, "broadcast_probe", fake_broadcast)

    aim_discovery.probe_device_ips(timeout=0.1)

    assert timeouts and all(t == 0.1 for t in timeouts)


# ── parse_discovery_text ───────────────────────────────────────────────────


def _discovery_reply(device_name: str, ssid_text: str) -> bytes:
    data = bytearray(0x80)
    name = device_name.encode("ascii")
    data[0x14 : 0x14 + len(name)] = name
    ssid = ssid_text.encode("ascii")
    data[0x58 : 0x58 + len(ssid)] = ssid
    return bytes(data)


def test_parse_discovery_text_extracts_model_serial_vehicle_and_name():
    info = aim_discovery.parse_discovery_text(
        "10.0.0.1", _discovery_reply("EVO5 Logger", "AiM-EVO5-00740-UConn EV")
    )

    assert info == {
        "ip": "10.0.0.1",
        "ssid": "AiM-EVO5-00740-UConn",
        "device_name": "EVO5 Logger",
        "model": "EVO5",
        "serial": "00740",
        "vehicle": "UConn EV",
    }


def test_parse_discovery_text_short_reply_skips_device_name():
    info = aim_discovery.parse_discovery_text("10.0.0.1", b"AiM-MXS-123-Kart\x00")

    assert info["model"] == "MXS"
    assert info["serial"] == "123"
    assert info["vehicle"] == "Kart"
    assert info["device_name"] == ""


def test_parse_discovery_text_unrecognised_payload_returns_blank_fields():
    info = aim_discovery.parse_discovery_text("1.2.3.4", b"\x01\x02garbage")

    assert info == {
        "ip": "1.2.3.4",
        "ssid": "",
        "device_name": "",
        "model": "",
        "serial": "",
        "vehicle": "",
    }


def test_parse_discovery_text_ignores_non_printable_device_name():
    data = bytearray(0x80)
    data[0x14:0x17] = b"\x01\x02\x03"

    assert aim_discovery.parse_discovery_text("10.0.0.1", bytes(data))["device_name"] == ""
