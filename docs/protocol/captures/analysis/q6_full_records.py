"""Full dump of every channel record with decoded fields.
Output a markdown-friendly table.
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
    if cd is None:
        return
    records = parse_records(cd)
    print(f"# {len(records)} channel records")
    print()
    print("| idx | tag | name | u32_at_0 | u32_at_4 | u32_at_8 | u32_at_12 | u32_at_16 | u32_at_20 | u32_at_64 | u32_at_68 | u32_at_72 | u32_at_84 | u32_at_88 | u32_at_92 | scale | offset |")
    print("|----|-----|------|----------|----------|----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-------|--------|")
    for i, (off, length, flag, p) in enumerate(records):
        u32s = struct.unpack_from("<28I", p, 0)
        f32s = struct.unpack_from("<28f", p, 0)
        tag = p[24:28].rstrip(b"\x00").decode("latin1", errors="replace")
        name = p[32:64].rstrip(b"\x00").decode("latin1", errors="replace")
        scale = f32s[25]
        offset_f = f32s[26]
        print(
            f"| {i} | {tag} | {name} | "
            f"{u32s[0]} | {u32s[1]} | {u32s[2]} | {u32s[3]} | {u32s[4]} | {u32s[5]} | "
            f"{u32s[16]} | {u32s[17]} | {u32s[18]} | {u32s[21]} | {u32s[22]} | {u32s[23]} | "
            f"{scale:g} | {offset_f:g} |"
        )


if __name__ == "__main__":
    main()
