"""Verify SUM16(payload) == trailer hypothesis end-to-end.
Also check inner-frame trailers."""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from, find_inner  # noqa: E402


def sum16(data: bytes) -> int:
    return sum(data) & 0xFFFF


def main() -> None:
    captures = [
        Path(__file__).parent.parent / "live1_tcp_stream0.txt",
        Path(__file__).parent.parent / "live2_tcp_stream0.txt",
    ]
    total_outer = 0
    total_inner = 0
    bad_outer = 0
    bad_inner_per_cmd: Counter = Counter()
    inner_per_cmd: Counter = Counter()
    bad_outer_examples = []

    for cap in captures:
        c, s = all_frames_from(cap)
        for f in c + s:
            total_outer += 1
            if sum16(f.payload) != f.trailer:
                bad_outer += 1
                if len(bad_outer_examples) < 5:
                    bad_outer_examples.append(
                        (cap.name, f.direction, f.cmd, len(f.payload),
                         f.trailer, sum16(f.payload))
                    )
            for cmd, flag, payload, tr, _ in find_inner(f.payload):
                total_inner += 1
                inner_per_cmd[cmd] += 1
                if sum16(payload) != tr:
                    bad_inner_per_cmd[cmd] += 1

    print(f"Outer frames: {total_outer}, mismatches: {bad_outer}")
    if bad_outer_examples:
        print("First few outer mismatches:")
        for ex in bad_outer_examples:
            print(f"  {ex}")
    print()
    print(f"Inner frames: {total_inner}")
    print("Per-command inner trailer mismatches (cmd: bad/total):")
    for cmd, total in inner_per_cmd.most_common():
        print(f"  {cmd!r}: {bad_inner_per_cmd[cmd]}/{total}")


if __name__ == "__main__":
    main()
