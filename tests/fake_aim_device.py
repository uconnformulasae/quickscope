"""In-process fake AiM EVO5 logger for exercising ``AimLiveClient`` without hardware.

It is a real asyncio TCP server on 127.0.0.1 (random port) that answers the
client the way the logger does in the Race Studio captures
(docs/protocol/captures/fixtures/, docs/protocol/aim-live-protocol.md):

* 8 B STCP hello            -> 8 B STCP hello-ack
* STNC 0x00010010 (system)  -> 64 B STCP op 'A'; after the 68 B date follow-up,
                               the channel-layout blob (first pass only), a Q
                               control frame and a >=3400 B enumeration blob
* STNC 0x00010006 (aux)     -> 64 B STCP op 'A' (no blob after the date)
* setup STNCs               -> a Q control frame whose hint is not live-sized
                               (the poll pair is part of setup until 0x00020008)
* live poll STNC A/B        -> Q control (hint = frame length - 4) + live frame,
                               with an occasional 12 B ``kkk`` heartbeat
* session-list STNCs        -> the session CSV in one STCP payload

Knobs on the constructor simulate the failure modes the client has to survive:
a silent hello, a missing enumeration blob, a TCP drop after N snapshots, a
stall (TCP open, no data), and line noise before the first frame.

Everything the client sends is recorded in ``received`` for assertions.
"""

from __future__ import annotations

import asyncio
import struct

from services.aim_live import (
    STNC_ENUM_AUX,
    STNC_GET_SESSIONS,
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    STNC_PREP_SESSIONS,
    STNC_SETUP_FINAL,
    STNC_SYSTEM,
    decode_frame,
    encode_frame,
)

LIVE_FRAME_LEN = 400
ENUM_BLOB_LEN = 3462
HELLO_ACK = b"\x00\x00\x00\x00\x06\x08\x00\x00"

# (name, logical offset, width, type_code, scale, offset)
DEFAULT_FIELDS: list[tuple[str, int, int, int, float, float]] = [
    ("RPM", 0, 4, 2, 1.0, 0.0),  # f32
    ("LFspeed", 4, 2, 0, 0.1, 0.0),  # int16 x 0.1
    ("Pack_Voltage", 8, 4, 2, 1.0, 0.0),  # f32
]

SESSIONS_CSV = (
    "name,size,date,hour,nlap,veicolo,device\r\n"
    "a_0001.xrk,1000,19/10/2026,10:00:00,3,CT16,EVO5\r\n"
    "a_0002.xrk,2000,19/10/2026,11:00:00,0,CT16,EVO5\r\n"
)


def control_frame(op: str, hint: int = 0) -> bytes:
    """64 B STCP control payload: opcode at [24], next-length hint at [16:20]."""
    payload = bytearray(64)
    struct.pack_into("<I", payload, 16, hint)
    payload[24] = ord(op)
    return encode_frame(b"STCP", bytes(payload))


def layout_blob(fields=DEFAULT_FIELDS) -> bytes:
    """Channel-layout STCP payload (``\\0\\0\\0\\0hhh`` + inner ``<hCHAN>`` records)."""
    records = bytearray()
    for name, logical, width, type_code, scale, offset in fields:
        record = bytearray(108)
        encoded = name.encode("latin1")
        record[32 : 32 + len(encoded)] = encoded
        struct.pack_into("<I", record, 68, logical)
        struct.pack_into("<I", record, 72, width)
        struct.pack_into("<I", record, 80, type_code)
        struct.pack_into("<2f", record, 100, scale, offset)
        records += encode_frame(b"CHAN", bytes(record))
    blob = b"\x00\x00\x00\x00hhh\x01" + b"\x00" * 4 + bytes(records)
    return blob.ljust(2400, b"\x00")


def live_frame(index: int, *, length: int = LIVE_FRAME_LEN) -> bytes:
    """Live snapshot payload for DEFAULT_FIELDS: RPM=1000+i, LFspeed=10+0.1*i, Pack_Voltage=380+i."""
    payload = bytearray(length)
    payload[4:8] = b"Syst"
    struct.pack_into("<I", payload, 8, 1000 + 125 * index)
    struct.pack_into("<f", payload, 12, 1000.0 + index)
    struct.pack_into("<h", payload, 16, 100 + index)
    struct.pack_into("<f", payload, 20, 380.0 + index)
    return bytes(payload)


def expected_channels(index: int) -> dict[str, float]:
    return {
        "RPM": 1000.0 + index,
        "LFspeed": (100 + index) * 0.1,
        "Pack_Voltage": 380.0 + index,
    }


class FakeAimDevice:
    def __init__(
        self,
        *,
        answer_hello: bool = True,
        send_layout: bool = True,
        send_enum_blob: bool = True,
        send_q_on_poll: bool = True,
        drop_after_snapshots: int | None = None,
        stall_after_snapshots: int | None = None,
        noise_before_hello_ack: bytes = b"",
        date_request_on_poll: int | None = None,
        sessions_csv: str = SESSIONS_CSV,
    ) -> None:
        self.answer_hello = answer_hello
        self.send_layout = send_layout
        self.send_enum_blob = send_enum_blob
        self.send_q_on_poll = send_q_on_poll
        self.drop_after_snapshots = drop_after_snapshots
        self.stall_after_snapshots = stall_after_snapshots
        self.noise_before_hello_ack = noise_before_hello_ack
        self.date_request_on_poll = date_request_on_poll
        self.sessions_csv = sessions_csv

        self.port = 0
        self.connections = 0
        self.snapshots_sent = 0
        self.polls_received = 0
        # (connection number, cmd, payload) for every frame the client sent
        self.received: list[tuple[int, bytes, bytes]] = []
        self._server: asyncio.base_events.Server | None = None
        self._writers: list[asyncio.StreamWriter] = []

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def start(self) -> "FakeAimDevice":
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def stop(self) -> None:
        for writer in self._writers:
            writer.close()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def __aenter__(self) -> "FakeAimDevice":
        return await self.start()

    async def __aexit__(self, *_exc) -> None:
        await self.stop()

    # ── assertions helpers ─────────────────────────────────────────────────

    def stnc_sub_cmds(self, connection: int | None = None) -> list[int]:
        return [
            struct.unpack_from("<I", payload, 8)[0]
            for conn, cmd, payload in self.received
            if cmd == b"STNC" and (connection is None or conn == connection)
        ]

    def stcp_lengths(self, connection: int | None = None) -> list[int]:
        return [
            len(payload)
            for conn, cmd, payload in self.received
            if cmd == b"STCP" and (connection is None or conn == connection)
        ]

    # ── protocol ───────────────────────────────────────────────────────────

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        conn = self.connections
        self._writers.append(writer)
        state = {"last_stnc": None, "layout_sent": False, "setup_done": False}
        buf = bytearray()
        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    return
                buf.extend(chunk)
                while True:
                    frame, consumed = decode_frame(bytes(buf))
                    if frame is None:
                        break
                    del buf[:consumed]
                    self.received.append((conn, frame.cmd, frame.payload))
                    if not await self._respond(conn, frame, state, writer):
                        writer.close()
                        return
        except (ConnectionError, asyncio.CancelledError):
            return
        finally:
            writer.close()

    async def _respond(self, conn: int, frame, state: dict, writer: asyncio.StreamWriter) -> bool:
        """Answer one client frame. Returns False to drop the TCP connection."""
        out = bytearray()
        payload = frame.payload
        if frame.cmd == b"STCP":
            if len(payload) == 8 and self.answer_hello:
                out += self.noise_before_hello_ack
                out += encode_frame(b"STCP", HELLO_ACK)
            elif len(payload) == 68 and state["last_stnc"] == STNC_SYSTEM:
                # Date follow-up to a system enumeration pass.
                if self.send_layout and not state["layout_sent"]:
                    out += encode_frame(b"STCP", layout_blob())
                    state["layout_sent"] = True
                out += control_frame("Q", ENUM_BLOB_LEN - 4)
                if self.send_enum_blob:
                    out += encode_frame(b"STCP", b"<hiM" + b"\x01" * (ENUM_BLOB_LEN - 4))
        elif frame.cmd == b"STNC":
            sub = struct.unpack_from("<I", payload, 8)[0]
            state["last_stnc"] = sub
            if sub in (STNC_SYSTEM, STNC_ENUM_AUX):
                out += control_frame("A")
            elif sub == STNC_SETUP_FINAL:
                state["setup_done"] = True
                out += control_frame("Q", 60)
            elif sub in (STNC_LIVE_POLL_A, STNC_LIVE_POLL_B) and state["setup_done"]:
                self.polls_received += 1
                if self.stall_after_snapshots is not None and conn == 1 and self.snapshots_sent >= self.stall_after_snapshots:
                    return True  # TCP stays open, nothing comes back
                if self.date_request_on_poll is not None and self.polls_received == self.date_request_on_poll:
                    out += control_frame("A")
                if self.send_q_on_poll:
                    out += control_frame("Q", LIVE_FRAME_LEN - 4)
                out += encode_frame(b"STCP", live_frame(self.snapshots_sent))
                self.snapshots_sent += 1
                if self.snapshots_sent % 2 == 0:
                    out += encode_frame(b"STCP", b"\x00\x00\x00\x00kkk\x01\x00\x00\x00\x00")
                    out += encode_frame(b"STCP", b"\x00\x00\x00\x00")
                if (
                    self.drop_after_snapshots is not None
                    and conn == 1
                    and self.snapshots_sent >= self.drop_after_snapshots
                ):
                    writer.write(bytes(out))
                    await writer.drain()
                    return False
            elif sub == STNC_GET_SESSIONS:
                out += control_frame("A")
                out += encode_frame(b"STCP", b"\x00\x00\x00\x00" + self.sessions_csv.encode("ascii"))
                out += encode_frame(b"STCP", b"\x00\x00\x00\x00")
            elif sub == STNC_PREP_SESSIONS:
                pass
            else:
                # One-shot setup selectors (including the poll pair before setup
                # finishes): a Q whose hint is not a live frame size.
                out += control_frame("Q", 60)
        if out:
            writer.write(bytes(out))
            await writer.drain()
        return True
