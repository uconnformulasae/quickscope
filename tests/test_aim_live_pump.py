"""Fake-device tests for the event-driven live pump (speed-up plan Phase 1).

Spins up a real loopback TCP "device" that scripts the steady-poll exchange
(STNC -> Q-hint -> LIVE) and drives a real `AimLiveClient.stream()` against
it, so these exercise the actual reader/pump tasks and asyncio.Queue -- not
just the pure frame-decode helpers the rest of tests/test_aim_live.py covers.
"""

from __future__ import annotations

import asyncio
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

from services.aim_live import (  # noqa: E402
    PUMP_PERIOD_S,
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    AimLiveClient,
    decode_frame,
    encode_frame,
)
from compare_live_pcaps import analyze_poll_micro_cycles  # noqa: E402


def _stnc_sub(frame) -> int | None:
    if frame.cmd != b"STNC" or len(frame.payload) < 12:
        return None
    return struct.unpack_from("<I", frame.payload, 8)[0]


class _FakeDeviceSession:
    """Scripted steady-poll device: reacts to each client STNC A/B.

    `skip_q_cycle` / `skip_live_cycle` (1-indexed poll cycle number) let a
    test simulate the device withholding its Q-hint or LIVE snapshot for one
    cycle, to check the pump doesn't stall and still keeps micro-acks (1, 1).
    """

    def __init__(
        self,
        *,
        cycles: int,
        skip_live_cycle: int | None = None,
        skip_q_cycle: int | None = None,
    ) -> None:
        self.cycles = cycles
        self.skip_live_cycle = skip_live_cycle
        self.skip_q_cycle = skip_q_cycle
        self.client_frames: list = []
        self.stnc_times: list[float] = []

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        buf = bytearray()
        loop = asyncio.get_running_loop()
        cycle = 0
        try:
            while cycle < self.cycles:
                frame = await self._read_one(reader, buf)
                self.client_frames.append(frame)
                sub = _stnc_sub(frame)
                if sub not in (STNC_LIVE_POLL_A, STNC_LIVE_POLL_B):
                    continue
                cycle += 1
                self.stnc_times.append(loop.time())

                if self.skip_q_cycle == cycle:
                    continue  # device withholds Q this cycle

                await asyncio.sleep(0.003)  # device latency before its Q reply
                q_payload = bytearray(64)
                struct.pack_into("<I", q_payload, 16, 703)  # hint -> 707 B LIVE
                q_payload[24] = ord("Q")
                writer.write(encode_frame(b"STCP", bytes(q_payload)))
                await writer.drain()

                try:
                    micro = await asyncio.wait_for(self._read_one(reader, buf), timeout=0.3)
                    self.client_frames.append(micro)
                except asyncio.TimeoutError:
                    pass

                if self.skip_live_cycle == cycle:
                    continue

                await asyncio.sleep(0.01)  # device latency before LIVE
                live = bytearray(707)
                live[4:8] = b"Syst"
                writer.write(encode_frame(b"STCP", bytes(live)))
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    @staticmethod
    async def _read_one(reader: asyncio.StreamReader, buf: bytearray):
        while True:
            frame, consumed = decode_frame(bytes(buf))
            if frame is not None:
                del buf[:consumed]
                return frame
            chunk = await reader.read(4096)
            if not chunk:
                raise ConnectionError("fake device: client closed")
            buf.extend(chunk)


async def _run_client_against_fake(
    session: _FakeDeviceSession, *, want_snapshots: int
) -> list:
    server = await asyncio.start_server(session.handle, "127.0.0.1", 0)
    host, port = server.sockets[0].getsockname()[:2]
    reader, writer = await asyncio.open_connection(host, port)
    client = AimLiveClient(host=host, port=port)
    client._reader = reader
    client._writer = writer
    client._handshake_done = True

    snaps: list = []
    agen = client.stream()
    try:
        async for snap in agen:
            snaps.append(snap)
            if len(snaps) >= want_snapshots:
                break
    finally:
        await agen.aclose()
        await client.close()
        server.close()
        await server.wait_closed()
    return snaps


def test_pump_one_micro_per_q_and_no_post_snapshot_ack() -> None:
    async def body() -> None:
        # The fake device replies to every individual STNC (A and B), so each
        # full A/B pair yields 2 snapshots here (real RS3 pacing sends one
        # LIVE per pair) -- 6 snapshots comfortably covers several full
        # (STNC_A, micro, STNC_B, micro) cycles for analyze_poll_micro_cycles.
        session = _FakeDeviceSession(cycles=8)
        snaps = await _run_client_against_fake(session, want_snapshots=6)
        assert len(snaps) >= 6

        mc = analyze_poll_micro_cycles(session.client_frames)
        assert mc["cycle_count"] >= 2
        assert mc["bad_cycles"] == 0
        assert mc["all_rs3_micro"]

    asyncio.run(body())


def test_pump_keeps_period_when_snapshot_delayed() -> None:
    """The pump must not block on a missing snapshot (RS3 doesn't either)."""

    async def body() -> None:
        session = _FakeDeviceSession(cycles=8, skip_live_cycle=2)
        snaps = await _run_client_against_fake(session, want_snapshots=4)
        assert len(snaps) >= 4

        gaps = [b - a for a, b in zip(session.stnc_times, session.stnc_times[1:])]
        assert gaps, "expected multiple STNC cycles"
        # Old fixed-schedule loop would stall up to the full 2s snapshot
        # timeout when a snapshot was missing; the pump must stay near its
        # fixed period regardless.
        assert all(g < PUMP_PERIOD_S * 4 for g in gaps), gaps

    asyncio.run(body())


def test_pump_pays_fallback_micro_when_q_never_arrives() -> None:
    """No Q for one cycle -> pump's fallback still pays exactly one micro."""

    async def body() -> None:
        session = _FakeDeviceSession(cycles=6, skip_q_cycle=2)
        await _run_client_against_fake(session, want_snapshots=3)

        mc = analyze_poll_micro_cycles(session.client_frames)
        assert mc["bad_cycles"] == 0

    asyncio.run(body())


def test_autorespond_drain_consumes_control_frames_without_acking() -> None:
    """Regression test: `_autorespond_drain(respond_stcp_control=False)` is
    used by every handshake phase (setup STNCs, aux enum, pre/post-poll
    sync) and depends on `_ingest_stcp_control_frame`. That method was
    deleted in a previous cleanup pass because it looked unused from
    `stream()`'s new reader/pump split -- but this call site was missed, so
    every real connection failed immediately with
    `AttributeError: 'AimLiveClient' object has no attribute
    '_ingest_stcp_control_frame'`. No existing test called
    `_autorespond_drain(respond_stcp_control=False)` directly, which is why
    it slipped through.
    """

    async def fake_device(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # One Q-64 frame, then go idle -- exactly what the setup/aux-enum
        # phases see between real replies.
        q_payload = bytearray(64)
        struct.pack_into("<I", q_payload, 16, 703)
        q_payload[24] = ord("Q")
        writer.write(encode_frame(b"STCP", bytes(q_payload)))
        await writer.drain()
        await asyncio.sleep(1.0)
        writer.close()

    async def body() -> None:
        server = await asyncio.start_server(fake_device, "127.0.0.1", 0)
        host, port = server.sockets[0].getsockname()[:2]
        reader, writer = await asyncio.open_connection(host, port)
        client = AimLiveClient(host=host, port=port)
        client._reader = reader
        client._writer = writer
        try:
            # Must return via the idle timeout, not raise AttributeError.
            await client._autorespond_drain(
                idle_s=0.05,
                overall_timeout=0.5,
                label="test",
                respond_stcp_control=False,
            )
        finally:
            await client.close()
            server.close()
            await server.wait_closed()

    asyncio.run(body())
