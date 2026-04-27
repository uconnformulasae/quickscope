"""Decode iLTS payload. The diff at offset 67 hints it's a timestamp seconds field."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from, find_inner  # noqa: E402


def main() -> None:
    for label, path in [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
    ]:
        c, s = all_frames_from(path)
        copies = []
        for f in s:
            for cmd, flag, payload, tr, _ in find_inner(f.payload):
                if cmd == b"iLTS":
                    copies.append(payload)
        for i, p in enumerate(copies):
            ascii_p = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in p)
            print(f"copy{i} ({len(p)} bytes):")
            print(f"  hex   : {p.hex()}")
            print(f"  ascii : {ascii_p}")
            print(f"  decode: {p.decode('latin1')}")


if __name__ == "__main__":
    main()
