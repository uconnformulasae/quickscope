"""Detailed catalog of every short STCP/STNC payload, with direction,
length, hex, and decoded u32s. Also process sibling capture for cross-check."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
        ("siblA", Path("/Users/mdabek/dev/Data-Development/aim_tcp_stream0.txt")),
        ("siblB", Path("/Users/mdabek/dev/Data-Development/aim_tcp_stream1.txt")),
    ]
    for label, path in captures:
        if not path.exists():
            print(f"\n=== {label} (missing) ===")
            continue
        c, s = all_frames_from(path)
        print(f"\n=== {label}: {len(c)+len(s)} frames ===")
        cc = Counter()
        for f in c + s:
            if len(f.payload) <= 16:
                cc[(f.direction, f.cmd, len(f.payload), f.payload)] += 1
        print("Direction, cmd, len, payload, count:")
        for (d, cmd, ln, p), n in cc.most_common():
            ascii_p = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in p)
            print(f"  {d} {cmd!r} len={ln:>2}  {p.hex()}  ({ascii_p!r})  x{n}")


if __name__ == "__main__":
    main()
