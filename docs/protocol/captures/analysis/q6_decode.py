"""Decode the 13608-byte channel-def frame's per-record format.

Each record looks like:
   <h M \0 \0 \0   LEN(u32 LE)   FLAG(0x04)   '>'
       payload
   < M \0 \0 \0   trailer(u16)   '>'

Walk through and extract each record."""

from __future__ import annotations

import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from  # noqa: E402


def parse_channel_records(stream: bytes, start_at: int = 12) -> list[dict]:
    """Walk extracting <h<CMD4>...><CMD4>...> records, allowing
    non-ASCII cmd codes."""
    out = []
    i = start_at
    n = len(stream)
    while i < n:
        idx = stream.find(b"<h", i)
        if idx < 0:
            break
        if idx + 12 > n:
            break
        cmd = stream[idx + 2 : idx + 6]
        length = int.from_bytes(stream[idx + 6 : idx + 10], "little")
        flag = stream[idx + 10]
        if stream[idx + 11 : idx + 12] != b">":
            i = idx + 1
            continue
        ps = idx + 12
        pe = ps + length
        if pe + 8 > n:
            break
        if stream[pe : pe + 1] != b"<":
            i = idx + 1
            continue
        cmd2 = stream[pe + 1 : pe + 5]
        if cmd2 != cmd or stream[pe + 7 : pe + 8] != b">":
            i = idx + 1
            continue
        tr = int.from_bytes(stream[pe + 5 : pe + 7], "little")
        out.append({
            "outer_cmd": cmd,
            "outer_flag": flag,
            "outer_len": length,
            "outer_offset": idx,
            "payload": stream[ps:pe],
            "trailer": tr,
        })
        i = pe + 8
    return out


def sniff_channel(payload: bytes) -> dict:
    """Decode one channel record. The record body starts with 24 bytes of
    'preamble' fields, then a 4-byte tag at offset 24, then 4 zero bytes,
    then a 32-byte name."""
    info = {"raw_len": len(payload)}
    if len(payload) < 100:
        return info
    # Bytes [0..23] are 6 u32 LE fields
    pre = struct.unpack_from("<6I", payload, 0)
    info["preamble_u32"] = pre
    info["tag"] = payload[24:28].rstrip(b"\x00")
    name = payload[32:64].rstrip(b"\x00").decode("latin1", errors="replace")
    info["name"] = name
    # Some additional fields after the 32-byte name.
    # Bytes 64..95 are typically 4 u32 LE more.
    if len(payload) >= 96:
        nxt = struct.unpack_from("<8I", payload, 64)
        info["after_name_u32"] = nxt
    # Look for ASCII strings in the rest
    units = payload[64:80].rstrip(b"\x00\xff").decode("latin1", errors="replace")
    info["maybe_units"] = units
    # Last 16 bytes likely two floats
    if len(payload) >= 16:
        f0, f1 = struct.unpack_from("<2f", payload, len(payload) - 8)
        info["last_two_f32"] = (f0, f1)
    return info


def main() -> None:
    path = Path(__file__).parent.parent / "live1_tcp_stream0.txt"
    c, s = all_frames_from(path)
    cd = None
    for f in s:
        if f.cmd == b"STCP" and len(f.payload) == 13608:
            cd = f.payload
            break
    if cd is None:
        print("no channel-def frame")
        return

    # Outer envelope of cd: bytes 0..7 are header zeros + 'hhh\x01'
    # Bytes 8..11 are the 4-byte length-of-record-area minus stuff,
    # then channels start.
    print(f"Outer payload bytes 0..11: {cd[:12].hex()}")
    print(f"  ASCII: {cd[:12]!r}")
    # The trailing structure: end-marker?
    print(f"Last 32 bytes: {cd[-32:].hex()}")

    records = parse_channel_records(cd, start_at=12)
    print(f"\nFound {len(records)} inner records (raw):")
    for i, r in enumerate(records[:30]):
        cmd_hex = r['outer_cmd'].hex()
        cmd_chr = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in r['outer_cmd'])
        print(f"  [{i:>3}]  cmd={cmd_hex} ({cmd_chr})  flag=0x{r['outer_flag']:02x}  "
              f"len={r['outer_len']:>5}  off={r['outer_offset']:>5}  tr=0x{r['trailer']:04x}")

    # Decode each "M\0\0\0" record
    print(f"\n--- channel records ---")
    chan_recs = [r for r in records if r['outer_cmd'] == b"M\x00\x00\x00"]
    print(f"Total channel records (cmd=M\\0\\0\\0): {len(chan_recs)}")
    print(f"Total non-M records: {len(records) - len(chan_recs)}")
    print()
    print("Channel record length histogram:")
    lens = Counter(r['outer_len'] for r in chan_recs)
    for l, n in lens.most_common(20):
        print(f"  len={l}: {n} records")

    # Decode each channel record
    print()
    for i, r in enumerate(chan_recs):
        info = sniff_channel(r["payload"])
        print(f"  [{i:>3}] off={r['outer_offset']:>5} len={r['outer_len']:>4}  "
              f"tag={info.get('tag', b'').decode('latin1', errors='replace'):>5}  "
              f"name={info.get('name', '')!r}")

    # Show the record cmds aside from M\0\0\0
    other = [r for r in records if r['outer_cmd'] != b"M\x00\x00\x00"]
    if other:
        print(f"\n--- Other inner records ---")
        for r in other[:20]:
            cmd_hex = r['outer_cmd'].hex()
            cmd_chr = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in r['outer_cmd'])
            print(f"  cmd={cmd_hex} ({cmd_chr}) flag=0x{r['outer_flag']:02x} len={r['outer_len']} off={r['outer_offset']}")
            ascii_p = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in r['payload'][:80])
            print(f"    {ascii_p}")


if __name__ == "__main__":
    main()
