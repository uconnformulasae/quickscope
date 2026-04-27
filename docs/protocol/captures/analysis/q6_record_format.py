"""Detailed dump of a single 112-byte channel record + comparison across
several records to identify the field layout."""

from __future__ import annotations

import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def parse_records(stream: bytes, start_at: int = 12) -> list[tuple[int, bytes]]:
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
        out.append((idx, stream[ps:pe]))
        i = pe + 8
    return out


def hex_dump(data: bytes, cols: int = 16) -> str:
    out = []
    for off in range(0, len(data), cols):
        row = data[off:off + cols]
        hex_part = " ".join(f"{b:02x}" for b in row)
        ascii_part = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in row)
        out.append(f"  {off:>3}: {hex_part:<{cols * 3}}  {ascii_part}")
    return "\n".join(out)


def main() -> None:
    path = Path(__file__).parent.parent / "live1_tcp_stream0.txt"
    c, s = all_frames_from(path)
    cd = next((f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 13608), None)
    if cd is None:
        return
    records = parse_records(cd)

    # Pick records of interest: MCLK, RPM, VBat, GPS, SOC, TPS, BTMP
    targets = ["MCLK", "RPM", "VBat", "VBAT", "GPS", "SOC", "TPS", "BTMP", "ODO",
               "InlA", "LatA", "VerA", "Roll", "Ptch", "YawR", "BSE", "RBRK"]
    keep = []
    for off, p in records:
        tag = p[24:28].rstrip(b"\x00").decode("latin1", errors="replace")
        if tag in targets:
            keep.append((off, tag, p))

    for off, tag, p in keep[:10]:
        print(f"\n=== record at offset {off}, tag={tag!r} ({len(p)} bytes) ===")
        print(hex_dump(p))
        # Decode candidate fields
        u32s = struct.unpack_from("<28I", p, 0)  # 112/4 = 28 u32s
        print(f"  As 28× u32 LE:")
        for i, v in enumerate(u32s):
            print(f"    [{i*4:>3}..{i*4+3}]  0x{v:08x}  ({v})")
        # As floats
        f32s = struct.unpack_from("<28f", p, 0)
        print(f"  As 28× f32 LE (only show plausible):")
        for i, v in enumerate(f32s):
            if 1e-30 < abs(v) < 1e10:
                print(f"    [{i*4:>3}..{i*4+3}]  {v:>20g}")


if __name__ == "__main__":
    main()
