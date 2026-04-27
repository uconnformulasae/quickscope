"""Q7: kkk heartbeat. Confirm payload is always 12 bytes
`00 00 00 00 6b 6b 6b 01 00 00 00 00`. Test for any variation."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    for label, path in [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
        ("siblA", Path("/Users/mdabek/dev/Data-Development/aim_tcp_stream0.txt")),
    ]:
        if not path.exists():
            continue
        c, s = all_frames_from(path)
        kkks = []
        for f in c + s:
            if f.cmd == b"STCP" and 8 <= len(f.payload) <= 16 and b"kkk" in f.payload:
                kkks.append(f.payload)
        print(f"\n{label}: {len(kkks)} 'kkk' frames")
        cc = Counter(kkks)
        for p, n in cc.most_common():
            ascii_p = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in p)
            print(f"  {p.hex()}  ({ascii_p!r})  x{n}")

        # Look for the byte after kkk
        if kkks:
            print(f"\nbyte after 'kkk' (offset 7) histogram:")
            seven = Counter(p[7] for p in kkks)
            for v, n in seven.most_common():
                print(f"  0x{v:02x}  x{n}")
            # Bytes [8..11]
            eight = Counter(p[8:12] for p in kkks)
            print(f"bytes [8..11] histogram:")
            for v, n in eight.most_common():
                print(f"  {v.hex()}  x{n}")


if __name__ == "__main__":
    main()
