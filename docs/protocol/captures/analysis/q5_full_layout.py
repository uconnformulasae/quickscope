"""Reconstruct the live-frame structure as 'TLV-like' segments and produce
a clear byte map.

We'll look at every contiguous variable run and compute statistics over all
194 live1 frames (and 33 live2 frames if available)."""

from __future__ import annotations

import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def main() -> None:
    paths = [
        Path(__file__).parent.parent / "live1_tcp_stream0.txt",
        Path(__file__).parent.parent / "live2_tcp_stream0.txt",
    ]
    live: list[bytes] = []
    for path in paths:
        c, s = all_frames_from(path)
        live.extend(f.payload for f in s if f.cmd == b"STCP" and len(f.payload) == 547)
    print(f"# Combined live frames: {len(live)}")

    # Per-byte distinct counts
    n = 547
    distinct_counts = [len(set(p[i] for p in live)) for i in range(n)]

    # Identify segments. Threshold: distinct >= 2 = variable.
    print("\nBYTE MAP (offset -> n_distinct -> hex (first frame) -> annotation)")
    i = 0
    while i < n:
        start = i
        is_var = distinct_counts[i] > 1
        while i < n and (distinct_counts[i] > 1) == is_var:
            i += 1
        end = i - 1
        seg_len = end - start + 1
        segment = live[0][start:end + 1]
        ascii_seg = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in segment)
        if is_var:
            # Show min/max/distinct of first 4 bytes treated as common types
            anno = f"VARIABLE  len={seg_len}"
            if seg_len in (2, 4):
                u = int.from_bytes(segment, "little")
                anno += f"  first u={u}"
            elif seg_len in (3,):
                u = int.from_bytes(segment, "little")
                anno += f"  u24={u}"
            print(f"  [{start:>3}..{end:>3}]  {anno}")
            print(f"      first hex: {segment.hex()}  ({ascii_seg})")
            # As 16/32-bit interpretations
            if seg_len == 4:
                u32_min = min(int.from_bytes(p[start:start+4], 'little') for p in live)
                u32_max = max(int.from_bytes(p[start:start+4], 'little') for p in live)
                s16a = sorted(set(int.from_bytes(p[start:start+2], 'little', signed=True) for p in live))
                s16b = sorted(set(int.from_bytes(p[start+2:start+4], 'little', signed=True) for p in live))
                f32s = [struct.unpack('<f', p[start:start+4])[0] for p in live]
                valid_f = [v for v in f32s if v == v and abs(v) < 1e30]
                print(f"      u32: min={u32_min:>12} max={u32_max:>12}  span={u32_max-u32_min}")
                print(f"      s16 pair: span_low={max(s16a)-min(s16a)} span_high={max(s16b)-min(s16b)}")
                if valid_f:
                    print(f"      f32: min={min(valid_f):.4g} max={max(valid_f):.4g}  ({len(f32s)-len(valid_f)} nan)")
            if seg_len == 2:
                u16_min = min(int.from_bytes(p[start:start+2], 'little') for p in live)
                u16_max = max(int.from_bytes(p[start:start+2], 'little') for p in live)
                s16_min = min(int.from_bytes(p[start:start+2], 'little', signed=True) for p in live)
                s16_max = max(int.from_bytes(p[start:start+2], 'little', signed=True) for p in live)
                print(f"      u16: min={u16_min} max={u16_max} | s16: min={s16_min} max={s16_max}")
            if seg_len > 8 and seg_len % 4 == 0:
                # Show u32 sub-fields
                for sub in range(0, seg_len, 4):
                    sub_off = start + sub
                    vals = [int.from_bytes(p[sub_off:sub_off+4], 'little') for p in live]
                    distinct = len(set(vals))
                    s32_min = min(int.from_bytes(p[sub_off:sub_off+4], 'little', signed=True) for p in live)
                    s32_max = max(int.from_bytes(p[sub_off:sub_off+4], 'little', signed=True) for p in live)
                    f32s = [struct.unpack('<f', p[sub_off:sub_off+4])[0] for p in live]
                    valid_f = [v for v in f32s if v == v and abs(v) < 1e30]
                    f_str = f"f32 [{min(valid_f):.4g}..{max(valid_f):.4g}]" if valid_f else "f32 nan"
                    print(f"        sub [{sub_off:>3}..{sub_off+3}]  distinct={distinct}  s32 [{s32_min}..{s32_max}]  {f_str}")
            if seg_len > 8 and seg_len % 2 == 0 and seg_len % 4 != 0:
                for sub in range(0, seg_len, 2):
                    sub_off = start + sub
                    vals = [int.from_bytes(p[sub_off:sub_off+2], 'little', signed=True) for p in live]
                    distinct = len(set(vals))
                    print(f"        sub [{sub_off:>3}..{sub_off+1}]  s16 distinct={distinct}  range=[{min(vals)}..{max(vals)}]")
        else:
            print(f"  [{start:>3}..{end:>3}]  CONST     len={seg_len:>3}  hex={segment.hex()}  ({ascii_seg})")


if __name__ == "__main__":
    main()
