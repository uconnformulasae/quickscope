"""
Reconstruct AiM TCP frames in chronological order using per-segment timestamps
from `tshark -T fields ... tcp.payload` output. Reassembles per-direction byte
streams using TCP sequence numbers, then walks each stream extracting framed
messages and merging the two directions by the timestamp of the *last* segment
that contributed to each frame.

Outputs a single ordered log:  ts  dir  outer_cmd  flag  len  inner_cmd  ascii_preview
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Segment:
    frame_no: int
    ts: float
    src: str
    seq: int
    payload: bytes


def load_segments(tsv_path: Path) -> list[Segment]:
    out: list[Segment] = []
    for line in tsv_path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        frame_no, ts, src, seq, length, payload_hex = parts[:6]
        if not payload_hex:
            continue
        out.append(
            Segment(
                frame_no=int(frame_no),
                ts=float(ts),
                src=src,
                seq=int(seq),
                payload=bytes.fromhex(payload_hex),
            )
        )
    return out


def reassemble(segments: list[Segment], src_filter: str) -> tuple[bytes, list[tuple[int, float]]]:
    """Returns concatenated bytes + a list of (byte_offset_at_segment_end, ts)
    so callers can map a byte offset back to the timestamp of the last segment
    containing that byte."""
    # Sort by raw seq number (handles 32-bit wrap by ordering as observed).
    subset = [s for s in segments if s.src == src_filter]
    subset.sort(key=lambda s: s.frame_no)
    buf = bytearray()
    offset_ts: list[tuple[int, float]] = []
    for s in subset:
        buf.extend(s.payload)
        offset_ts.append((len(buf), s.ts))
    return bytes(buf), offset_ts


def find_inner_cmd(payload: bytes) -> str:
    """Return the first inner command code as ASCII, or empty string."""
    i = payload.find(b"<h")
    if i < 0 or i + 6 > len(payload):
        return ""
    cmd = payload[i + 2 : i + 6]
    if all(0x20 <= b < 0x7F for b in cmd):
        return cmd.decode("ascii", errors="replace")
    return ""


def parse_frames_with_ts(
    stream: bytes,
    offset_ts: list[tuple[int, float]],
    direction: str,
) -> list[tuple[float, str, str, int, int, str, bytes]]:
    """Yields tuples (ts, dir, outer_cmd, flag, len, inner_cmd, payload_first_120)."""
    out = []
    i = 0
    n = len(stream)
    while i < n:
        start = stream.find(b"<h", i)
        if start < 0:
            break
        if start + 12 > n:
            break
        cmd = stream[start + 2 : start + 6]
        if not all(0x20 <= b < 0x7F for b in cmd):
            i = start + 1
            continue
        length = int.from_bytes(stream[start + 6 : start + 10], "little")
        flag = stream[start + 10]
        if stream[start + 11 : start + 12] != b">":
            i = start + 1
            continue
        ps = start + 12
        pe = ps + length
        if pe + 8 > n:
            break
        if stream[pe : pe + 1] != b"<":
            i = start + 1
            continue
        cmd2 = stream[pe + 1 : pe + 5]
        if stream[pe + 7 : pe + 8] != b">" or cmd2 != cmd:
            i = start + 1
            continue
        end_byte = pe + 8
        # Find timestamp of first segment whose accumulated end >= end_byte
        ts = 0.0
        for cum_end, t in offset_ts:
            if cum_end >= end_byte:
                ts = t
                break
        payload = stream[ps:pe]
        out.append(
            (
                ts,
                direction,
                cmd.decode("ascii", errors="replace"),
                flag,
                length,
                find_inner_cmd(payload),
                payload[:120],
            )
        )
        i = end_byte
    return out


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: parse_chronological.py <segments.tsv> [client_ip] [device_ip]")
        raise SystemExit(2)
    segments = load_segments(Path(sys.argv[1]))
    client_ip = sys.argv[2] if len(sys.argv) > 2 else "10.0.0.10"
    device_ip = sys.argv[3] if len(sys.argv) > 3 else "10.0.0.1"

    c_bytes, c_off = reassemble(segments, client_ip)
    s_bytes, s_off = reassemble(segments, device_ip)

    c_frames = parse_frames_with_ts(c_bytes, c_off, "C")
    s_frames = parse_frames_with_ts(s_bytes, s_off, "S")

    merged = sorted(c_frames + s_frames, key=lambda x: x[0])
    print(f"# total frames: {len(merged)} ({len(c_frames)} client, {len(s_frames)} server)")
    print(f"# {'idx':>4} {'t_rel':>9}  dir  outer  flag    len  inner  preview")
    t0 = merged[0][0] if merged else 0.0
    for idx, (ts, d, outer, flag, length, inner, payload) in enumerate(merged):
        ascii_preview = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in payload)
        print(
            f"  {idx:>4} {ts - t0:>9.3f}   {d}   {outer}  0x{flag:02x} {length:>6}  "
            f"{inner:<5}  {ascii_preview[:80]}"
        )


if __name__ == "__main__":
    main()
