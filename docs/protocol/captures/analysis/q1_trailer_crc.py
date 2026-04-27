"""Q1: figure out the outer-envelope trailer u16.

For every captured frame, try a battery of CRC-16 / sum / XOR / sequence-counter
hypotheses and report which (if any) matches across all frames.

We try several "domains" for the bytes the trailer covers:
  domain A  payload only
  domain B  header (12 bytes) + payload
  domain C  header + payload + trailer-prefix '<' + cmd (5 bytes)
  domain D  payload + '<' + cmd
  domain E  cmd of header + len + flag + payload  (skip the '<h' magic)
  domain F  whole frame except the trailer u16 itself (header..pe+5)

Also try:
  - reversed input
  - per-direction separately
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib_frames import all_frames_from, Frame  # noqa: E402


# ---------- CRC primitives ----------

def crc16_ccitt_false(data: bytes, init: int = 0xFFFF) -> int:
    crc = init
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def crc16_xmodem(data: bytes) -> int:
    return crc16_ccitt_false(data, init=0x0000)


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def crc16_x25(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0x8408
            else:
                crc >>= 1
    crc ^= 0xFFFF
    return crc & 0xFFFF


def crc16_ibm(data: bytes) -> int:
    # IBM / ARC: poly 0x8005 reflected, init 0
    crc = 0x0000
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def crc16_kermit(data: bytes) -> int:
    # CCITT reflected, init 0
    crc = 0x0000
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0x8408
            else:
                crc >>= 1
    return crc & 0xFFFF


def sum16(data: bytes) -> int:
    return sum(data) & 0xFFFF


def xor16(data: bytes) -> int:
    """16-bit XOR over byte pairs."""
    acc = 0
    for i in range(0, len(data), 2):
        if i + 1 < len(data):
            v = data[i] | (data[i + 1] << 8)
        else:
            v = data[i]
        acc ^= v
    return acc & 0xFFFF


def fletcher16(data: bytes) -> int:
    sum1 = 0
    sum2 = 0
    for b in data:
        sum1 = (sum1 + b) % 255
        sum2 = (sum2 + sum1) % 255
    return (sum2 << 8) | sum1


CRC_FNS = {
    "CCITT(0xFFFF)": crc16_ccitt_false,
    "CCITT(0x0000)": crc16_xmodem,
    "MODBUS": crc16_modbus,
    "X.25": crc16_x25,
    "IBM(ARC)": crc16_ibm,
    "KERMIT": crc16_kermit,
    "SUM16": sum16,
    "XOR16": xor16,
    "FLETCHER16": fletcher16,
}


# ---------- Domain selectors ----------

def domains_for(f: Frame) -> dict[str, bytes]:
    """Return the byte ranges to test the trailer u16 against."""
    d: dict[str, bytes] = {}
    d["A_payload"] = f.payload
    d["B_hdr+payload"] = f.header_bytes + f.payload
    d["C_hdr+payload+tail5"] = f.header_bytes + f.payload + f.trailer_bytes[:5]
    d["D_payload+tail5"] = f.payload + f.trailer_bytes[:5]
    d["E_cmd+len+flag+payload"] = f.header_bytes[2:11] + f.payload
    d["F_whole_frame_minus_crc"] = f.header_bytes + f.payload + f.trailer_bytes[:5]
    d["G_payload_after_inner_hdr"] = f.payload[1:] if len(f.payload) > 1 else b""
    d["H_payload_no_first4"] = f.payload[4:] if len(f.payload) > 4 else b""
    d["I_cmd_only"] = f.header_bytes[2:6]
    d["J_len+flag"] = f.header_bytes[6:11]
    d["K_payload_no_last_byte"] = f.payload[:-1] if f.payload else b""
    return d


def evaluate(frames: list[Frame], label: str) -> None:
    print(f"\n=== {label}: {len(frames)} frames ===")
    if not frames:
        return
    # For each (domain, crc-fn) pair, count matches.
    matches: Counter = Counter()
    sample_for_explain: dict[tuple[str, str], list[tuple[Frame, int, int]]] = {}
    for f in frames:
        doms = domains_for(f)
        for dname, dbytes in doms.items():
            for cname, cfn in CRC_FNS.items():
                computed = cfn(dbytes)
                if computed == f.trailer:
                    matches[(dname, cname)] += 1
                    sample_for_explain.setdefault((dname, cname), []).append(
                        (f, computed, f.trailer)
                    )
    if not matches:
        print("  no perfect domain/CRC match")
    else:
        for (d, c), n in matches.most_common(20):
            pct = 100.0 * n / len(frames)
            print(f"  {d:<28s}  {c:<14s}  {n:>5}/{len(frames)}  {pct:6.2f}%")

    # Trailer histogram
    tr_counts = Counter(f.trailer for f in frames)
    print(f"  trailer distinct values: {len(tr_counts)}; top:")
    for t, n in tr_counts.most_common(10):
        print(f"    0x{t:04x}  {n}")

    # Trailer == 0?  zero-only frames?
    zeros = sum(1 for f in frames if f.trailer == 0)
    print(f"  trailer == 0x0000: {zeros}/{len(frames)}")


def main() -> None:
    captures = [
        ("live1", Path(__file__).parent.parent / "live1_tcp_stream0.txt"),
        ("live2", Path(__file__).parent.parent / "live2_tcp_stream0.txt"),
    ]
    for label, path in captures:
        c, s = all_frames_from(path)
        evaluate(c, f"{label} CLIENT outer frames")
        evaluate(s, f"{label} SERVER outer frames")
        # Also break down by command code
        from collections import defaultdict
        by_cmd: dict[bytes, list[Frame]] = defaultdict(list)
        for f in c + s:
            by_cmd[f.cmd].append(f)
        for cmd, fs in by_cmd.items():
            evaluate(fs, f"{label} {cmd!r} all frames")


if __name__ == "__main__":
    main()
