"""
Extract every 547-byte server STCP payload (the live-data frame) and produce a
column-by-column diff so we can find which byte offsets carry channel values vs
which are constant. Reveals the live-data layout.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_aim_stream import load_stream, parse_frames  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: extract_547.py <follow_dump.txt>")
        raise SystemExit(2)
    path = Path(sys.argv[1])
    _, s2c = load_stream(path)
    server = parse_frames(s2c, "S")
    payloads = [f.payload for f in server if f.cmd == b"STCP" and len(f.payload) == 547]
    print(f"# Found {len(payloads)} server STCP frames of length 547 in {path.name}")

    if not payloads:
        return

    # Build per-byte counts of distinct values across the first 200 frames
    sample = payloads[: min(200, len(payloads))]
    n = 547
    distinct: list[set[int]] = [set() for _ in range(n)]
    for p in sample:
        for i, b in enumerate(p):
            distinct[i].add(b)

    print(f"# Sampled across {len(sample)} payloads")
    print(f"# Bytes that NEVER vary (constant header/footer):")
    constant_runs = []
    run_start = None
    for i, s in enumerate(distinct):
        if len(s) == 1:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                constant_runs.append((run_start, i - 1))
                run_start = None
    if run_start is not None:
        constant_runs.append((run_start, n - 1))
    for a, b in constant_runs:
        seg = sample[0][a : b + 1]
        ascii_seg = "".join(chr(c) if 0x20 <= c < 0x7F else "." for c in seg)
        print(f"  [{a:>3}..{b:>3}] ({b - a + 1:>3} bytes)  hex={seg.hex()}  ascii={ascii_seg!r}")

    print()
    print("# Variable runs (these carry the live data + sequence/timestamps):")
    var_runs = []
    run_start = None
    for i, s in enumerate(distinct):
        if len(s) > 1:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                var_runs.append((run_start, i - 1))
                run_start = None
    if run_start is not None:
        var_runs.append((run_start, n - 1))
    for a, b in var_runs:
        unique_counts = [len(distinct[i]) for i in range(a, b + 1)]
        print(f"  [{a:>3}..{b:>3}] ({b - a + 1:>3} bytes)  per-byte distinct counts: {unique_counts}")

    # First 5 payloads side by side at the variable offsets
    print()
    print("# First 6 payloads, only variable bytes (showing first 80 bytes of each):")
    for idx, p in enumerate(sample[:6]):
        first80 = p[:80].hex()
        print(f"  [{idx}] {first80}")


if __name__ == "__main__":
    main()
