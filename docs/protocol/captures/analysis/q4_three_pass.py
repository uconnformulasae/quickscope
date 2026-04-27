"""Q4: diff the 3 copies of each inner enumeration command.

Inner cmds are: iMST, iSLV, iHW , iUSR, iPTH, iLCK, iSST, iLTS, iPRL.
Each appears exactly 3 times.

We extract them and look for byte-level differences."""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from, find_inner  # noqa: E402


def hex_diff(a: bytes, b: bytes) -> list[tuple[int, int, int]]:
    """Return [(offset, a_byte, b_byte)] where they differ."""
    out = []
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            out.append((i, x, y))
    if len(a) != len(b):
        # Add tail diffs
        longer = a if len(a) > len(b) else b
        for i in range(min(len(a), len(b)), len(longer)):
            out.append((i, longer[i] if longer is a else None, longer[i] if longer is b else None))
    return out


def main() -> None:
    for label, path in [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]:
        c, s = all_frames_from(path)
        # Collect inner frames per cmd, in order
        per_cmd: dict[bytes, list[bytes]] = defaultdict(list)
        for f in s:  # all enumeration content comes from server
            for cmd, flag, payload, tr, off in find_inner(f.payload):
                per_cmd[cmd].append(payload)
        print(f"\n=== {label} ===")
        for cmd, payloads in per_cmd.items():
            print(f"\n--- {cmd!r}: {len(payloads)} copies ---")
            if len(payloads) < 2:
                continue
            print(f"  lengths: {[len(p) for p in payloads]}")
            # Compare each consecutive pair
            for i in range(1, len(payloads)):
                d = hex_diff(payloads[0], payloads[i])
                print(f"  copy0 vs copy{i}: {len(d)} differing bytes")
                for off, a, b in d[:30]:
                    a_disp = f"0x{a:02x}" if a is not None else "—"
                    b_disp = f"0x{b:02x}" if b is not None else "—"
                    a_chr = chr(a) if a is not None and 0x20 <= a < 0x7f else "."
                    b_chr = chr(b) if b is not None and 0x20 <= b < 0x7f else "."
                    print(f"    [{off:>4}]  {a_disp}/{a_chr}  vs  {b_disp}/{b_chr}")
                if len(d) > 30:
                    print(f"    ... {len(d) - 30} more diffs")


if __name__ == "__main__":
    main()
