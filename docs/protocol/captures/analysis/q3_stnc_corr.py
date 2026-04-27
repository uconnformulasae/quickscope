"""Look at STNC byte[8..10] in context — pair each STNC with the immediately
preceding/following server frame to figure out what the values mean.

Use chronological data from segment TSVs to get exact ordering."""

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
        all_frames = sorted(c + s, key=lambda f: (f.direction == "S", f.raw_offset))
        # Build a position-ordered chronological merge by raw_offset within direction
        # Since we have separate streams, "chronological" here is best-effort:
        # interleave by alternating cycles.
        c_list = c
        s_list = s
        print(f"\n=== {label} ===")
        # Walk through sequentially; for each STNC, peek at what server replies
        # (we know server reply contains echo of STNC's selector at offset 8-10)
        stnc = [f for f in c_list if f.cmd == b"STNC"]
        # Build a histogram of byte[8..10] for STNC frames
        by_sel = Counter()
        for f in stnc:
            sel = f.payload[8:11]  # bytes 8, 9, 10
            by_sel[sel] += 1
        print(f"\nSTNC selector (bytes 8,9,10) histogram:")
        for sel, n in by_sel.most_common():
            v32 = int.from_bytes(f.payload[8:12], "little")
            print(f"  {sel.hex()}  x{n}")

        # For each STNC, find the next server STCP frame that includes the
        # same byte triplet (server echoes selector in its 64-byte ack).
        ssrv64 = [f for f in s_list if f.cmd == b"STCP" and len(f.payload) == 64]
        print(f"\nServer STCP-64 frames: {len(ssrv64)}")
        # Show histograms of server payload byte[8..10] and byte[24] (the ack code)
        srv_sel = Counter()
        srv_ack = Counter()
        for f in ssrv64:
            srv_sel[f.payload[8:11]] += 1
            srv_ack[f.payload[24]] += 1
        print(f"\nServer STCP-64 selector histogram (bytes 8,9,10):")
        for sel, n in srv_sel.most_common():
            print(f"  {sel.hex()}  x{n}")
        print(f"\nServer STCP-64 byte[24] histogram (likely the 'A'/'I'/'Q'/'E' ack-code):")
        for v, n in srv_ack.most_common():
            ascii_v = chr(v) if 0x20 <= v < 0x7F else "."
            print(f"  0x{v:02x} ({ascii_v!r})  x{n}")

        # Pair up STNC and server-64s by selector
        by_sel_full = defaultdict(list)
        for f in c_list + s_list:
            if f.cmd in (b"STNC", b"STCP") and len(f.payload) == 64:
                by_sel_full[f.payload[8:11]].append(f)
        # Show what happens for each unique selector
        print(f"\nSelector -> what's in the message:")
        for sel, fs in sorted(by_sel_full.items()):
            dirs = Counter(f.direction for f in fs)
            cmds = Counter(f.cmd for f in fs)
            byte_24 = Counter(f.payload[24] for f in fs)
            byte_24_str = ", ".join(f"{chr(v) if 0x20 <= v < 0x7F else f'0x{v:02x}'}({n})"
                                    for v, n in byte_24.most_common())
            print(f"  selector={sel.hex()}: dirs={dict(dirs)} cmds={dict(cmds)} byte24=[{byte_24_str}]")

        # Look at what the 64-byte server frames say at byte 32, 33 (the I/Q
        # ack code is at byte 24; what's at other offsets?)
        # First 5 server STCP-64 frames in detail
        print(f"\nFirst 6 server STCP-64 frames:")
        for f in ssrv64[:6]:
            print(f"  {f.payload.hex()}")


if __name__ == "__main__":
    main()
