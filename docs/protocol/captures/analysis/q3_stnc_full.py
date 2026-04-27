"""Full structural analysis of all 64-byte STCP and STNC frames."""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def analyse(label: str, frames: list[bytes]) -> None:
    if not frames:
        print(f"{label}: 0 frames")
        return
    n = len(frames[0])
    print(f"\n{label}: {len(frames)} frames of length {n}")
    distinct = [Counter() for _ in range(n)]
    for p in frames:
        for i, b in enumerate(p):
            distinct[i][b] += 1
    for i, c in enumerate(distinct):
        unique = len(c)
        if unique == 1:
            v, _ = c.most_common(1)[0]
            print(f"  [{i:>2}]  CONST 0x{v:02x}")
        else:
            top = c.most_common(8)
            top_str = ", ".join(f"0x{v:02x}({n})" for v, n in top)
            print(f"  [{i:>2}]  {unique:>3} values: {top_str}")


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]
    all_c_stnc = []
    all_c_stcp64 = []
    all_s_stcp64 = []
    for label, path in captures:
        c, s = all_frames_from(path)
        all_c_stnc.extend(f.payload for f in c if f.cmd == b"STNC" and len(f.payload) == 64)
        all_c_stcp64.extend(f.payload for f in c if f.cmd == b"STCP" and len(f.payload) == 64)
        all_s_stcp64.extend(f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 64)

    analyse("Client STNC 64", all_c_stnc)
    analyse("Client STCP 64", all_c_stcp64)
    analyse("Server STCP 64", all_s_stcp64)


if __name__ == "__main__":
    main()
