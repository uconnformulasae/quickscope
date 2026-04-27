"""Shared frame parser used by the deep-dive analysis scripts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class Frame:
    direction: str          # 'C' or 'S'
    cmd: bytes              # outer 4-byte command
    flag: int               # outer flag byte
    payload: bytes          # outer payload (LEN bytes)
    trailer: int            # outer trailer u16
    raw_offset: int         # offset of '<h' within the per-direction stream
    header_bytes: bytes     # 12 bytes ('<h'+CMD+LEN+FLAG+'>')
    trailer_bytes: bytes    # 8 bytes ('<'+CMD+TR+'>')


def load_stream(path: Path) -> tuple[bytes, bytes]:
    """Returns (client_to_server_bytes, server_to_client_bytes).

    tshark's `Follow: tcp,raw` dump uses Node 0 = unindented and Node 1 =
    tab-indented. Whether Node 0 is the client or the device depends on
    which side initiated the connection (which Wireshark observed first).
    We auto-detect by parsing the Node 0:/Node 1: header lines and looking
    for ":2000" which is the AiM device port.
    """
    text = path.read_text()
    node0_is_device = False
    for line in text.splitlines():
        if line.startswith("Node 0:"):
            node0_is_device = ":2000" in line
            break
    c2s = bytearray()
    s2c = bytearray()
    in_data = False
    for raw_line in text.splitlines():
        if raw_line.startswith("======="):
            in_data = not in_data
            continue
        if not in_data:
            continue
        if raw_line.startswith(("Follow:", "Filter:", "Node 0:", "Node 1:")):
            continue
        if raw_line.startswith("\t"):
            hex_text = raw_line.strip()
            if re.fullmatch(r"[0-9a-fA-F]+", hex_text):
                # tab-indented = Node 1
                if node0_is_device:
                    c2s.extend(bytes.fromhex(hex_text))
                else:
                    s2c.extend(bytes.fromhex(hex_text))
        else:
            hex_text = raw_line.strip()
            if re.fullmatch(r"[0-9a-fA-F]+", hex_text):
                # unindented = Node 0
                if node0_is_device:
                    s2c.extend(bytes.fromhex(hex_text))
                else:
                    c2s.extend(bytes.fromhex(hex_text))
    return bytes(c2s), bytes(s2c)


def parse_frames(stream: bytes, direction: str) -> list[Frame]:
    out: list[Frame] = []
    i = 0
    n = len(stream)
    while i < n:
        start = stream.find(b"<h", i)
        if start < 0:
            break
        if start + 12 > n:
            break
        cmd = stream[start + 2 : start + 6]
        if not all(0x20 <= b < 0x7F for b in cmd):
            i = start + 1
            continue
        length = int.from_bytes(stream[start + 6 : start + 10], "little")
        flag = stream[start + 10]
        if stream[start + 11 : start + 12] != b">":
            i = start + 1
            continue
        ps = start + 12
        pe = ps + length
        if pe + 8 > n:
            break
        if stream[pe : pe + 1] != b"<":
            i = start + 1
            continue
        cmd2 = stream[pe + 1 : pe + 5]
        if stream[pe + 7 : pe + 8] != b">" or cmd2 != cmd:
            i = start + 1
            continue
        trailer = int.from_bytes(stream[pe + 5 : pe + 7], "little")
        out.append(
            Frame(
                direction=direction,
                cmd=cmd,
                flag=flag,
                payload=stream[ps:pe],
                trailer=trailer,
                raw_offset=start,
                header_bytes=stream[start : start + 12],
                trailer_bytes=stream[pe : pe + 8],
            )
        )
        i = pe + 8
    return out


def all_frames_from(path: Path) -> tuple[list[Frame], list[Frame]]:
    c, s = load_stream(path)
    return parse_frames(c, "C"), parse_frames(s, "S")


def find_inner(payload: bytes) -> list[tuple[bytes, int, bytes, int, int]]:
    """Return list of (cmd, flag, payload, trailer, start_offset) for every
    inner <h<CMD>...<CMD>...> sub-frame inside payload."""
    out = []
    i = 0
    n = len(payload)
    while i < n:
        start = payload.find(b"<h", i)
        if start < 0:
            break
        if start + 12 > n:
            break
        cmd = payload[start + 2 : start + 6]
        if not all(0x20 <= b < 0x7F for b in cmd):
            i = start + 1
            continue
        length = int.from_bytes(payload[start + 6 : start + 10], "little")
        flag = payload[start + 10]
        if payload[start + 11 : start + 12] != b">":
            i = start + 1
            continue
        ps = start + 12
        pe = ps + length
        if pe + 8 > n:
            break
        if payload[pe : pe + 1] != b"<":
            i = start + 1
            continue
        cmd2 = payload[pe + 1 : pe + 5]
        if payload[pe + 7 : pe + 8] != b">" or cmd2 != cmd:
            i = start + 1
            continue
        tr = int.from_bytes(payload[pe + 5 : pe + 7], "little")
        out.append((cmd, flag, payload[ps:pe], tr, start))
        i = pe + 8
    return out
