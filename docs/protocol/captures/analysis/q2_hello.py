"""Q2: STCP hello payloads.

Hypothesis: client sends 8 bytes `00 00 00 00 06 08 00 00`. Device replies
`00 00 00 00 06 19 00 00`. We want to know:

  - Is the second u32 a sub-command code?
  - Does 0x806 mean something specific?
  - Does 0x1906 differ in a meaningful way?

Also catalog every short STCP payload (4, 8, 12, 64 bytes) we see, with their
exact payloads, frequencies, and where they appear in the sequence.
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    for cap_label, path in [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]:
        c, s = all_frames_from(path)
        print(f"\n=== {cap_label} ===")
        all_frames = sorted(c + s, key=lambda f: f.raw_offset)

        # Count first STCP frames in each direction
        first_c = next((f for f in c if f.cmd == b"STCP"), None)
        first_s = next((f for f in s if f.cmd == b"STCP"), None)
        print(f"First client STCP: {first_c.payload.hex()} (len={len(first_c.payload)})")
        print(f"First server STCP: {first_s.payload.hex()} (len={len(first_s.payload)})")

        # All distinct 8-byte STCP payloads
        eight = Counter()
        for f in c + s:
            if f.cmd == b"STCP" and len(f.payload) == 8:
                eight[(f.direction, f.payload)] += 1
        print("\n8-byte STCP payloads (dir, hex, count):")
        for (dirn, hexp), count in eight.most_common():
            print(f"  {dirn}  {hexp.hex()}  ({count}x)")

        # All distinct 4-byte STCP payloads
        four = Counter()
        for f in c + s:
            if f.cmd == b"STCP" and len(f.payload) == 4:
                four[(f.direction, f.payload)] += 1
        print("\n4-byte STCP payloads (dir, hex, count):")
        for (dirn, hexp), count in four.most_common():
            print(f"  {dirn}  {hexp.hex()}  ({count}x)")

        # All 12-byte STCP payloads
        twelve = Counter()
        for f in c + s:
            if f.cmd == b"STCP" and len(f.payload) == 12:
                twelve[(f.direction, f.payload)] += 1
        print("\n12-byte STCP payloads (dir, hex, count):")
        for (dirn, hexp), count in twelve.most_common(20):
            print(f"  {dirn}  {hexp.hex()}  ({count}x)")

        # Decode the 8-byte payloads as 2x u32 LE
        print("\nDecoded 8-byte payloads as 2× u32 LE:")
        for (dirn, hexp), count in eight.most_common():
            u1 = int.from_bytes(hexp[:4], "little")
            u2 = int.from_bytes(hexp[4:], "little")
            print(f"  {dirn}  u1=0x{u1:08x}  u2=0x{u2:08x}  ({count}x)")


if __name__ == "__main__":
    main()
