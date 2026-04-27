"""Analyse the 547-byte live-data frame in detail.

Pull all 547-byte frames in chronological order. For each candidate offset
(suggested in the spec), interpret the bytes as:
  - LE u32 / u24
  - LE float32

Then:
  - Plot the time-series of values (pretty-print min/max/mean/distinct count
    + first 20 values + last 20 values)
  - Look for physically plausible signatures
"""

from __future__ import annotations

import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


CANDIDATES = {
    "ts_u32 [8..11]": ("u32", 8),
    "ts_low_u24 [48..50]": ("u24", 48),
    "ts_low_u24 [52..54]": ("u24", 52),
    "ts_low_u24 [56..58]": ("u24", 56),
    "ts_low_u24 [128..130]": ("u24", 128),
    "ts_low_u24 [140..142]": ("u24", 140),
    "ts_low_u24 [152..154]": ("u24", 152),
    "ts_low_u24 [164..166]": ("u24", 164),
    "ts_low_u24 [176..178]": ("u24", 176),
    "ts_low_u24 [180..182]": ("u24", 180),
    "ts_low_u24 [184..186]": ("u24", 184),
    "u32 [128..131]": ("u32", 128),
    "u32 [140..143]": ("u32", 140),
    "u32 [152..155]": ("u32", 152),
    "u32 [164..167]": ("u32", 164),
    "u32 [176..179]": ("u32", 176),
    "u32 [180..183]": ("u32", 180),
    "u32 [184..187]": ("u32", 184),
    "u32 [196..199]": ("u32", 196),
    "u32 [200..203]": ("u32", 200),
    "u32 [204..207]": ("u32", 204),
    "f32 [212..215]": ("f32", 212),
    "f32 [216..219]": ("f32", 216),
    "f32 [220..223]": ("f32", 220),
    "u32 [212..215]": ("u32", 212),
    "u32 [216..219]": ("u32", 216),
    "u32 [220..223]": ("u32", 220),
    "u32 [228..231]": ("u32", 228),
    "u32 [232..235]": ("u32", 232),
    "u32 [240..243]": ("u32", 240),
    "u32 [244..247]": ("u32", 244),
    "u32 [248..251]": ("u32", 248),
    "u32 [252..255]": ("u32", 252),
    "f32 [240..243]": ("f32", 240),
    "f32 [244..247]": ("f32", 244),
    "f32 [248..251]": ("f32", 248),
    "f32 [252..255]": ("f32", 252),
    "u32 [261..264]": ("u32", 261),
    "u32 [456..459]": ("u32", 456),
    "u32 [460..463]": ("u32", 460),
}


def get(p: bytes, kind: str, off: int) -> float:
    if kind == "u32":
        if off + 4 > len(p):
            return float("nan")
        return float(int.from_bytes(p[off:off + 4], "little"))
    if kind == "u24":
        if off + 3 > len(p):
            return float("nan")
        return float(int.from_bytes(p[off:off + 3], "little"))
    if kind == "f32":
        if off + 4 > len(p):
            return float("nan")
        return struct.unpack_from("<f", p, off)[0]
    raise ValueError(kind)


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]
    for label, path in captures:
        c, s = all_frames_from(path)
        live = [f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 547]
        print(f"\n=== {label}: {len(live)} live frames ===")
        if not live:
            continue
        # Subsystem tags (bytes [4..7]) — group by tag
        tags = Counter(p[4:8] for p in live)
        print(f"\nSubsystem tags (bytes 4..7) histogram:")
        for tag, n in tags.most_common(10):
            ascii_t = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in tag)
            print(f"  {tag.hex()}  ({ascii_t!r})  x{n}")

        # Bytes 12..14 (subsystem flags)
        flags1214 = Counter(p[12:15] for p in live)
        print(f"\nBytes [12..14] (subsystem flags) histogram:")
        for v, n in flags1214.most_common(10):
            print(f"  {v.hex()}  x{n}")

        # Per-candidate
        print(f"\nPer candidate (only those with >1 distinct value):")
        for label_c, (kind, off) in CANDIDATES.items():
            values = [get(p, kind, off) for p in live]
            uniq = sorted(set(values))
            if len(uniq) <= 1:
                continue
            mn = min(values)
            mx = max(values)
            mean = sum(values) / len(values)
            print(f"  {label_c:<30}  distinct={len(uniq):>4}  min={mn:>14.3f}  max={mx:>14.3f}  mean={mean:>14.3f}")
            # First 8 + last 8
            print(f"    first8: {[f'{v:.3f}' if isinstance(v, float) else v for v in values[:8]]}")
            print(f"    last8 : {[f'{v:.3f}' if isinstance(v, float) else v for v in values[-8:]]}")


if __name__ == "__main__":
    main()
