"""
Parse a tshark `follow,tcp,raw` dump of the AiM Race Studio <-> EVO5 conversation
into framed protocol messages. Produces a labeled stream that we can use to
write the canonical protocol spec.

Frame format (observed from live1.pcapng / live2.pcapng):
    Header :  '<h' <CMD:4> <LEN:u32 LE> <FLAG:u8> '>'
    Payload:  LEN bytes
    Trailer:  '<' <CMD:4> <TRAILER:u16 LE> '>'

Where <CMD> is a 4-byte ASCII command code (e.g. b'STCP', b'iMST').
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Frame:
    direction: str          # 'C' (client -> device) or 'S' (device -> client)
    cmd: bytes              # 4-byte command code
    flag: int               # 1-byte flag from the header
    payload: bytes
    trailer: int            # u16 from the closing tag
    raw_offset: int         # offset within the per-direction stream


# tshark "follow,tcp,raw" emits one node's bytes unindented and the other's
# tab-indented. WHICH node is which depends on which side initiated the
# conversation — Node 0 is the originator. For us the device is on :2000;
# whichever Node line names :2000 is the device (server side). Without this
# detection, Live 2 (where the device happens to be on Node 0) silently has
# every direction labeled wrong.


def load_stream(path: Path) -> tuple[bytes, bytes]:
    """Returns (client_to_server_bytes, server_to_client_bytes)."""
    text = path.read_text()
    # First pass: figure out which prefix maps to which direction. tshark
    # emits "Node 0: 10.0.0.1:2000" and "Node 1: 10.0.0.10:60025" headers;
    # Node 0 is unindented, Node 1 is tab-indented. The device is the one
    # listening on :2000.
    server_is_indented = True  # default to old behaviour if header missing
    for raw_line in text.splitlines():
        if raw_line.startswith("Node 0:"):
            if ":2000" in raw_line:
                server_is_indented = False  # device is unindented
        elif raw_line.startswith("Node 1:"):
            if ":2000" in raw_line:
                server_is_indented = True   # device is tab-indented

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
        is_indented = raw_line.startswith("\t")
        is_server = is_indented if server_is_indented else not is_indented
        hex_text = raw_line.strip()
        if not re.fullmatch(r"[0-9a-fA-F]+", hex_text):
            continue
        chunk = bytes.fromhex(hex_text)
        if is_server:
            s2c.extend(chunk)
        else:
            c2s.extend(chunk)
    return bytes(c2s), bytes(s2c)


def parse_frames(stream: bytes, direction: str) -> list[Frame]:
    """Walk the byte stream extracting <h<CMD><LEN><FLAG>>...<...> frames."""
    frames: list[Frame] = []
    i = 0
    n = len(stream)
    while i < n:
        # Find the next '<h' header start.
        start = stream.find(b"<h", i)
        if start < 0:
            break
        # Header: '<h' + 4 cmd + 4 len + 1 flag + '>'   = 12 bytes
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
        payload_start = start + 12
        payload_end = payload_start + length
        # Trailer: '<' + 4 cmd + 2 trailer + '>' = 8 bytes
        if payload_end + 8 > n:
            break
        if stream[payload_end : payload_end + 1] != b"<":
            # Bad framing — skip this header and try again
            i = start + 1
            continue
        cmd2 = stream[payload_end + 1 : payload_end + 5]
        trailer = int.from_bytes(stream[payload_end + 5 : payload_end + 7], "little")
        if stream[payload_end + 7 : payload_end + 8] != b">":
            i = start + 1
            continue
        if cmd2 != cmd:
            # Mismatched cmd codes — try next header
            i = start + 1
            continue
        payload = stream[payload_start:payload_end]
        frames.append(Frame(direction, cmd, flag, payload, trailer, start))
        i = payload_end + 8
    return frames


def merge_chronological(c_frames: list[Frame], s_frames: list[Frame]) -> list[Frame]:
    # We have no per-frame timestamps after `follow` reduction, but the order
    # within each direction is preserved. We cannot exactly interleave without
    # timing info, so we just emit client frames first, then server frames —
    # most analysis below works per direction anyway. The protocol spec writer
    # will cross-reference using timestamps from a separate pass.
    return c_frames + s_frames


def summary(frames: list[Frame]) -> str:
    out = []
    cmd_counts = Counter(f.cmd for f in frames)
    out.append("Command frequency:")
    for cmd, count in cmd_counts.most_common():
        out.append(f"  {cmd!r}: {count}")
    return "\n".join(out)


def find_inner_frames(payload: bytes) -> list[Frame]:
    """Recursively find <h<CMD>...><CMD>...> sub-frames inside a payload."""
    inner: list[Frame] = []
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
        trailer = int.from_bytes(payload[pe + 5 : pe + 7], "little")
        if payload[pe + 7 : pe + 8] != b">" or cmd2 != cmd:
            i = start + 1
            continue
        inner.append(Frame("?", cmd, flag, payload[ps:pe], trailer, start))
        i = pe + 8
    return inner


def first_n_per_command(frames: list[Frame], n: int = 2) -> str:
    """Show the first N payloads for each command, hex + ASCII."""
    seen: Counter = Counter()
    out = []
    for f in frames:
        if seen[f.cmd] >= n:
            continue
        seen[f.cmd] += 1
        out.append(
            f"[{f.direction}] {f.cmd!r} flag=0x{f.flag:02x} len={len(f.payload):>5} "
            f"trailer=0x{f.trailer:04x}"
        )
        hex_preview = f.payload[:160].hex()
        ascii_preview = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in f.payload[:160])
        out.append(f"    hex  : {hex_preview}{'…' if len(f.payload) > 160 else ''}")
        out.append(f"    ascii: {ascii_preview}{'…' if len(f.payload) > 160 else ''}")
        # Look for inner sub-frames
        for inner in find_inner_frames(f.payload):
            sub_ascii = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in inner.payload[:80])
            out.append(
                f"      ↳ inner {inner.cmd!r} flag=0x{inner.flag:02x} "
                f"len={len(inner.payload):>4} trail=0x{inner.trailer:04x}: {sub_ascii}"
            )
    return "\n".join(out)


def inner_command_summary(frames: list[Frame]) -> Counter:
    """Count all inner sub-frame commands across the whole stream."""
    c: Counter = Counter()
    for f in frames:
        for inner in find_inner_frames(f.payload):
            c[inner.cmd] += 1
    return c


def stage_dump(frames: list[Frame], stage_name: str, start: int, end: int) -> str:
    """Print frames in the index range [start, end) within the merged list."""
    out = [f"\n=== {stage_name} (frames {start}..{end - 1}) ==="]
    for idx, f in enumerate(frames[start:end], start=start):
        ascii_preview = "".join(
            chr(b) if 0x20 <= b < 0x7F else "." for b in f.payload[:80]
        )
        out.append(
            f"  #{idx:04d} [{f.direction}] {f.cmd!r} flag=0x{f.flag:02x} "
            f"len={len(f.payload):>5} | {ascii_preview}"
        )
    return "\n".join(out)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: parse_aim_stream.py <tshark_follow_dump.txt>")
        raise SystemExit(2)
    path = Path(sys.argv[1])
    c2s, s2c = load_stream(path)
    print(f"# {path.name}")
    print(f"client→device bytes: {len(c2s)}")
    print(f"device→client bytes: {len(s2c)}")
    c_frames = parse_frames(c2s, "C")
    s_frames = parse_frames(s2c, "S")
    print(f"client frames parsed: {len(c_frames)}")
    print(f"server frames parsed: {len(s_frames)}")
    print()
    print("--- CLIENT-SIDE COMMAND FREQUENCY ---")
    print(summary(c_frames))
    print()
    print("--- SERVER-SIDE COMMAND FREQUENCY ---")
    print(summary(s_frames))
    print()
    print("--- FIRST 2 PAYLOADS PER COMMAND (CLIENT) ---")
    print(first_n_per_command(c_frames, 2))
    print()
    print("--- FIRST 2 PAYLOADS PER COMMAND (SERVER) ---")
    print(first_n_per_command(s_frames, 2))
    print()
    print("--- INNER COMMAND FREQUENCY (CLIENT) ---")
    for cmd, count in inner_command_summary(c_frames).most_common():
        print(f"  {cmd!r}: {count}")
    print()
    print("--- INNER COMMAND FREQUENCY (SERVER) ---")
    for cmd, count in inner_command_summary(s_frames).most_common():
        print(f"  {cmd!r}: {count}")


if __name__ == "__main__":
    main()
