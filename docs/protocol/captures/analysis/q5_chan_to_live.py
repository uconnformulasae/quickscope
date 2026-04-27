"""For each channel-def record, list the (logical_offset, width) tuple.
For each variable byte range in the actual live frame, list its
(start, end). Print side by side.

The hypothesis we're TESTING: live_frame_offset = channel_def_offset + HEADER_BYTES
where HEADER_BYTES is some constant (12, 36, 64, 128 — probably 12).
"""

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
        out.append((idx, length, flag, stream[ps:pe]))
        i = pe + 8
    return out


def main() -> None:
    path = Path(__file__).parent.parent / "live1_tcp_stream0.txt"
    c, s = all_frames_from(path)
    cd = next((f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 13608), None)
    records = parse_records(cd)

    # Channel info: (offset, width, tag, name, type80)
    chans = []
    for _, length, flag, p in records:
        u68 = struct.unpack_from("<I", p, 68)[0]
        u72 = struct.unpack_from("<I", p, 72)[0]
        u80 = struct.unpack_from("<I", p, 80)[0]
        u64 = struct.unpack_from("<I", p, 64)[0]
        tag = p[24:28].rstrip(b"\x00").decode("latin1", errors="replace")
        name = p[32:64].rstrip(b"\x00").decode("latin1", errors="replace")
        chans.append((u68, u72, tag, name, u80, u64))
    chans.sort()

    print(f"# {len(chans)} channels, sorted by buffer offset")
    print(f"#  offset+12 (proposed live offset)")
    print(f"#  channels are coalesced into 'subsystems' which dictate the snapshot cadence")
    print(f"# {'logical_off':>11} {'live_off':>9} {'end':>4} {'width':>5} {'type':>4} {'sample-rate-us':>14}  {'tag':>5}  {'name':<30}")
    for off, width, tag, name, t80, t64 in chans:
        live_off = off + 12
        live_end = off + 12 + width - 1
        print(f"  {off:>10} {live_off:>9} {live_end:>4}  {width:>5}  {t80:>4}  {t64:>14}  {tag:>5}  {name[:30]}")


if __name__ == "__main__":
    main()
