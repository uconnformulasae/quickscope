"""Validate channel-def offset → live-frame offset mapping.
For each channel, sample the byte range across all live frames and see if
they make sense (variable for active channels; INT_MAX/zero for inactive)."""

from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def parse_records(stream: bytes, start_at: int = 12) -> list:
    out = []
    i = start_at
    n = len(stream)
    while i < n:
        idx = stream.find(b"<h", i)
        if idx < 0:
            break
        if idx + 12 > n:
            break
        cmd = stream[idx + 2 : idx + 6]
        length = int.from_bytes(stream[idx + 6 : idx + 10], "little")
        flag = stream[idx + 10]
        if stream[idx + 11 : idx + 12] != b">":
            i = idx + 1
            continue
        ps = idx + 12
        pe = ps + length
        if pe + 8 > n:
            break
        if stream[pe : pe + 1] != b"<":
            i = idx + 1
            continue
        cmd2 = stream[pe + 1 : pe + 5]
        if cmd2 != cmd or stream[pe + 7 : pe + 8] != b">":
            i = idx + 1
            continue
        out.append(stream[ps:pe])
        i = pe + 8
    return out


def main() -> None:
    path = Path(__file__).parent.parent / "live1_tcp_stream0.txt"
    c, s = all_frames_from(path)
    cd = next((f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 13608), None)
    records = parse_records(cd)
    live = [f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 547]

    chans = []
    for p in records:
        u68 = struct.unpack_from("<I", p, 68)[0]
        u72 = struct.unpack_from("<I", p, 72)[0]
        u80 = struct.unpack_from("<I", p, 80)[0]
        tag = p[24:28].rstrip(b"\x00").decode("latin1", errors="replace")
        name = p[32:64].rstrip(b"\x00").decode("latin1", errors="replace")
        chans.append((u68, u72, tag, name, u80))

    print(f"# {len(live)} live frames, {len(chans)} channels")
    print()
    print(f"# {'tag':>5}  {'name':<28}  {'live':>4}..{'end':>3}  {'wd':>3}  {'frame[0] hex':>16}  {'distinct_count_per_byte':<25}  notes")
    for off, width, tag, name, t80 in chans:
        live_off = off + 12
        live_end = live_off + width
        if live_end > 547:
            print(f"  OVERFLOW: {tag} {name} would extend past 547")
            continue
        # Sample byte range
        first = live[0][live_off:live_end]
        # Count distinct per byte
        per_byte = []
        for j in range(width):
            distinct = len(set(p[live_off + j] for p in live))
            per_byte.append(distinct)
        # Check if the bytes match INT_MAX placeholders or change
        is_active = any(d > 1 for d in per_byte)
        notes = ""
        if width == 4:
            u32_vals = [int.from_bytes(p[live_off:live_end], 'little') for p in live]
            if all(v == 0x7fffffff for v in u32_vals):
                notes = "INT32_MAX placeholder (inactive)"
            elif all(v == 0xff80ff80 or v == 0xff800000 for v in u32_vals):
                notes = "f32 -inf placeholder"
        if width == 2:
            u16_vals = [int.from_bytes(p[live_off:live_end], 'little') for p in live]
            if all(v == 0x7fff for v in u16_vals):
                notes = "INT16_MAX placeholder"
        print(f"  {tag:>5}  {name[:28]:<28}  {live_off:>4}..{live_end-1:>3}  {width:>3}  {first.hex():>16}  {per_byte}  {notes}")


if __name__ == "__main__":
    main()
