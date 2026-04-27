"""For each candidate offset in the live frame, show 6 successive frame
values at that offset across multiple type interpretations (u8, u16, u24,
u32, s32, f32, f32 BE). This is the right tool to figure out what the
field IS."""

from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    c, s = all_frames_from(Path(__file__).parent.parent / "live1_tcp_stream0.txt")
    live = [f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 547]
    # Pick frames spread across the capture
    sample = live[::25][:10]

    print(f"# Showing {len(sample)} sample live frames")
    # Header row of frame indices
    indices = [i * 25 for i in range(len(sample))]

    # Offsets of interest from the spec
    of_interest = [
        (8, 4, "u32 [8..11]"),
        (12, 4, "u32 [12..15]"),
        (48, 3, "u24 [48..50]"),
        (52, 3, "u24 [52..54]"),
        (56, 3, "u24 [56..58]"),
        (128, 4, "u32 [128..131]"),
        (140, 4, "u32 [140..143]"),
        (152, 4, "u32 [152..155]"),
        (164, 4, "u32 [164..167]"),
        (176, 4, "u32 [176..179]"),
        (180, 4, "u32 [180..183]"),
        (184, 4, "u32 [184..187]"),
        (192, 4, "u32 [192..195]"),
        (196, 4, "u32 [196..199]"),
        (200, 2, "u16 [200..201]"),
        (200, 4, "u32 [200..203]"),
        (204, 2, "u16 [204..205]"),
        (204, 4, "u32 [204..207]"),
        (208, 4, "u32 [208..211]"),
        (212, 4, "s32 [212..215]"),
        (216, 4, "s32 [216..219]"),
        (220, 4, "s32 [220..223]"),
        (224, 4, "s32 [224..227]"),
        (228, 4, "u32 [228..231]"),
        (240, 4, "f32 [240..243]"),
        (244, 4, "f32 [244..247]"),
        (248, 4, "f32 [248..251]"),
        (252, 4, "f32 [252..255]"),
        (261, 2, "u16 [261..262]"),
        (456, 4, "f32 [456..459]"),
        (460, 4, "f32 [460..463]"),
        (479, 2, "u16 [479..480]"),
        (538, 1, "u8  [538]"),
        (541, 2, "u16 [541..542]"),
    ]

    for off, length, label in of_interest:
        vals = []
        for p in sample:
            sl = p[off:off + length]
            if length == 1:
                vals.append(f"{sl[0]:>5}")
            elif length == 2:
                u16 = int.from_bytes(sl, "little")
                vals.append(f"{u16:>5}")
            elif length == 3:
                u24 = int.from_bytes(sl, "little")
                vals.append(f"{u24:>10}")
            elif length == 4:
                if "f32" in label:
                    f, = struct.unpack("<f", sl)
                    vals.append(f"{f:>14.6g}")
                elif "s32" in label:
                    s, = struct.unpack("<i", sl)
                    vals.append(f"{s:>11}")
                else:
                    u32 = int.from_bytes(sl, "little")
                    vals.append(f"{u32:>11}")
        print(f"  {label:<22}  hex={sample[0][off:off+length].hex()}  vals: {vals}")


if __name__ == "__main__":
    main()
