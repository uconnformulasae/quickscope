"""Q3: decode the structure of every STNC 64-byte client→server payload.

For each byte offset 0..63, find:
  - distinct values across all observed STNC payloads
  - frequency
  - is it constant, monotonic, or correlated with neighbouring frames?
"""

from __future__ import annotations

import sys
import struct
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]
    all_payloads: list[bytes] = []
    for label, path in captures:
        c, _ = all_frames_from(path)
        stnc = [f for f in c if f.cmd == b"STNC"]
        print(f"\n=== {label}: {len(stnc)} client STNC frames ===")
        if not stnc:
            continue
        # All same length?
        lens = Counter(len(f.payload) for f in stnc)
        print(f"  payload lengths: {dict(lens)}")
        # Show first 3
        for i, f in enumerate(stnc[:3]):
            print(f"  [{i}] {f.payload.hex()}")
        all_payloads.extend(f.payload for f in stnc)

    if not all_payloads:
        return

    # Per-byte distinct values across all STNC payloads (assuming same length)
    n = len(all_payloads[0])
    if not all(len(p) == n for p in all_payloads):
        print("WARNING: STNC payload lengths vary!")
        return

    print(f"\nTotal STNC payloads: {len(all_payloads)} of length {n}")

    distinct = [Counter() for _ in range(n)]
    for p in all_payloads:
        for i, b in enumerate(p):
            distinct[i][b] += 1

    print("\nPer-byte variability:")
    for i, c in enumerate(distinct):
        unique = len(c)
        if unique == 1:
            v, _ = c.most_common(1)[0]
            print(f"  [{i:>2}]  CONST 0x{v:02x}")
        else:
            top = c.most_common(5)
            top_str = ", ".join(f"0x{v:02x}({n})" for v, n in top)
            print(f"  [{i:>2}]  {unique:>3} values: {top_str}")

    # Look for u32 fields aligned at common offsets
    print("\nAs 16× u32 LE (first frame):")
    p0 = all_payloads[0]
    for i in range(0, n, 4):
        v = int.from_bytes(p0[i:i+4], "little")
        print(f"  [{i:>2}..{i+3}]  0x{v:08x}  ({v})")

    # Time evolution of variable u32 fields
    print("\nVariable u32 fields across all STNC frames:")
    for i in range(0, n, 4):
        if any(distinct[j].most_common(1)[0][1] != len(all_payloads)
               for j in range(i, i+4)):
            vals = [int.from_bytes(p[i:i+4], "little") for p in all_payloads]
            uvals = sorted(set(vals))
            head = vals[:8]
            tail = vals[-8:]
            print(
                f"  [{i:>2}..{i+3}]  distinct={len(uvals):>4}  "
                f"min=0x{min(uvals):08x} max=0x{max(uvals):08x}  "
                f"first8={[hex(v) for v in head]}  last8={[hex(v) for v in tail]}"
            )

    # Show first 10 STNC payloads stacked
    print("\nFirst 10 STNC payloads (column-aligned):")
    for i, p in enumerate(all_payloads[:10]):
        print(f"  {i:>3}: {p.hex()}")
    print()
    print("Last 10 STNC payloads:")
    for i, p in enumerate(all_payloads[-10:]):
        print(f"  {i:>3}: {p.hex()}")


if __name__ == "__main__":
    main()
