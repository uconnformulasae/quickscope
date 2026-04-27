"""Q6: decode the 13608-byte channel definitions frame.

Discover the per-channel record layout. Hypothesis: fixed-size struct with
4-byte tag (e.g. 'MCLK'), name, units, sample-rate, scale, offset, type-code.
"""

from __future__ import annotations

import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from, find_inner  # noqa: E402


def hex_dump(data: bytes, start: int = 0, length: int | None = None,
             cols: int = 16) -> str:
    if length is None:
        length = len(data) - start
    end = min(start + length, len(data))
    out = []
    for off in range(start, end, cols):
        row = data[off:off + cols]
        hex_part = " ".join(f"{b:02x}" for b in row)
        ascii_part = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in row)
        out.append(f"  {off:>5}: {hex_part:<{cols * 3}}  {ascii_part}")
    return "\n".join(out)


def main() -> None:
    path = Path(__file__).parent.parent / "live1_tcp_stream0.txt"
    c, s = all_frames_from(path)
    # Find the 13608-byte STCP payload (channel-def frame)
    cd = None
    for f in s:
        if f.cmd == b"STCP" and len(f.payload) == 13608:
            cd = f.payload
            break
    if cd is None:
        # Look at any large STCP
        for f in s:
            if f.cmd == b"STCP" and len(f.payload) > 5000:
                print(f"Found STCP len={len(f.payload)}")
                cd = f.payload
                break
    if cd is None:
        print("no big payload found")
        return
    print(f"Channel-def payload len: {len(cd)}")
    print("\nFirst 256 bytes:")
    print(hex_dump(cd, 0, 256))
    print("\nBytes 0-30 ASCII:")
    print(repr(cd[:30].decode("latin1", errors="replace")))

    # Find inner sub-frames
    for cmd, flag, payload, tr, off in find_inner(cd):
        print(f"\nInner cmd {cmd!r} at offset {off}, len {len(payload)}, tr=0x{tr:04x}")
        print(hex_dump(payload, 0, min(256, len(payload))))


if __name__ == "__main__":
    main()
