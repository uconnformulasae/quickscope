"""Pair STNC requests with subsequent server STCP-64 acks. Also analyse what
varies in the server byte[16..17] field across frames."""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]

    for label, path in captures:
        c, s = all_frames_from(path)
        all_64 = sorted(
            [f for f in c + s if len(f.payload) == 64 and f.cmd in (b"STNC", b"STCP")],
            key=lambda f: f.raw_offset,
        )
        # Naive interleave by raw_offset stream is not chronological across
        # directions. We can however walk the server-side and report
        # selector + byte[16..17] u16 and byte[24] (ack code) over time.
        s_64 = [f for f in s if f.cmd == b"STCP" and len(f.payload) == 64]
        c_64 = [f for f in c if f.cmd == b"STNC" and len(f.payload) == 64]
        print(f"\n=== {label}  C-stnc:{len(c_64)}  S-stcp64:{len(s_64)} ===")

        # For each ack code (A/I/Q/E), look at byte[16..17] distribution
        # and at the selector at bytes 8..10.
        per_ack: dict[int, list[bytes]] = defaultdict(list)
        for f in s_64:
            per_ack[f.payload[24]].append(f.payload)
        for ack_byte, payloads in sorted(per_ack.items()):
            ack_chr = chr(ack_byte) if 0x20 <= ack_byte < 0x7f else f"0x{ack_byte:02x}"
            print(f"\n  ack={ack_chr!r} ({len(payloads)} frames):")
            sel_counts = Counter(p[8:11] for p in payloads)
            print(f"    selectors: {[(s.hex(), n) for s, n in sel_counts.most_common(8)]}")
            b16_17 = Counter(p[16:18] for p in payloads)
            print(f"    byte[16..17]: {[(s.hex(), n) for s, n in b16_17.most_common(10)]}")
            # As u32 over [16..19]
            b16_19 = Counter(int.from_bytes(p[16:20], "little") for p in payloads)
            print(f"    byte[16..19] u32: {[(hex(v), n) for v, n in b16_19.most_common(10)]}")

        # Live-1 the live cycle has selectors 0x10001 (enumeration), then
        # 0x20003 / 0x20053 (steady state). Confirm:
        print(f"\n  Sequence of selectors (steady-state-only — last 30 frames):")
        for f in c_64[-30:]:
            sel32 = int.from_bytes(f.payload[8:12], "little")
            print(f"    C STNC sel=0x{sel32:08x}")
        for f in s_64[-30:]:
            sel32 = int.from_bytes(f.payload[8:12], "little")
            ack = chr(f.payload[24])
            b16_19 = int.from_bytes(f.payload[16:20], "little")
            print(f"    S STCP sel=0x{sel32:08x} ack={ack!r} b16_19=0x{b16_19:08x}")


if __name__ == "__main__":
    main()
