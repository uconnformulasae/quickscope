"""Analyzer for an AiM live-poll pcap — steady-state live poll pattern.

Originally a one-off script hardcoded to RS3_live_1min.pcapng stream 36; now
takes the path and --stream on the command line so it can be pointed at any
capture (see speed_up_aim_transfers plan, "verify" phase).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "docs" / "protocol" / "captures"))

from services.aim_live import (  # noqa: E402
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    _STCP_OP_A,
    _STCP_OP_E,
    _STCP_OP_H,
    _STCP_OP_I,
    _STCP_OP_Q,
    _is_live_snapshot_payload,
    decode_frame,
)

_DEFAULT_TSHARK_WIN = r"C:\Program Files\Wireshark\tshark.exe"


def _tshark_path() -> str:
    found = shutil.which("tshark")
    if found:
        return found
    if Path(_DEFAULT_TSHARK_WIN).exists():
        return _DEFAULT_TSHARK_WIN
    raise SystemExit("tshark not found on PATH or at the default Windows install location")


def load_follow(pcap: Path, stream: int) -> tuple[bytearray, bytearray]:
    raw = subprocess.check_output(
        [_tshark_path(), "-r", str(pcap), "-q", "-z", f"follow,tcp,raw,{stream}"],
        text=True,
        errors="replace",
    )
    client = bytearray()
    server = bytearray()
    for line in raw.splitlines():
        if not line.strip() or line.startswith("=") or "Follow" in line or "Filter" in line or "Node" in line:
            continue
        if line.startswith("\t"):
            hx = line.strip().replace("\t", "")
            if hx:
                server.extend(bytes.fromhex(hx))
        elif all(c in "0123456789abcdef" for c in line.strip()):
            client.extend(bytes.fromhex(line.strip()))
    return client, server


def iter_frames(buf: bytes):
    pos = 0
    while pos < len(buf):
        try:
            frame, n = decode_frame(buf[pos:])
        except ValueError:
            pos += 1
            continue
        if frame is None:
            break
        yield frame
        pos += n


def describe(frame) -> str:
    pl = frame.payload
    if frame.cmd == b"STNC" and len(pl) >= 12:
        sub = int.from_bytes(pl[8:12], "little")
        return f"STNC 0x{sub:08x}"
    if frame.cmd != b"STCP":
        return frame.cmd.decode("ascii", errors="replace")
    if len(pl) == 4:
        return "STCP micro"
    if len(pl) == 12:
        tag = pl[4:8].decode("ascii", errors="replace").rstrip("\x00")
        return f"STCP hb tag={tag!r}"
    if len(pl) == 64:
        op = pl[24]
        ch = chr(op) if 32 <= op < 127 else f"0x{op:02x}"
        hint = int.from_bytes(pl[16:20], "little")
        return f"STCP64 op={ch} hint={hint}"
    if _is_live_snapshot_payload(pl):
        return f"LIVE {len(pl)}B"
    return f"STCP len={len(pl)}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcap", type=Path, help="path to the .pcapng capture")
    ap.add_argument("--stream", type=int, required=True, help="tcp.stream index")
    args = ap.parse_args()

    client, server = load_follow(args.pcap, args.stream)
    print(f"Stream {args.stream}: client {len(client)} B, server {len(server)} B")

    cframes = list(iter_frames(client))
    sframes = list(iter_frames(server))
    print(f"Decoded frames: client {len(cframes)}, server {len(sframes)}")

    live = sum(1 for f in sframes if f.cmd == b"STCP" and _is_live_snapshot_payload(f.payload))
    stnc_a = sum(
        1
        for f in cframes
        if f.cmd == b"STNC" and len(f.payload) >= 12 and int.from_bytes(f.payload[8:12], "little") == STNC_LIVE_POLL_A
    )
    stnc_b = sum(
        1
        for f in cframes
        if f.cmd == b"STNC" and len(f.payload) >= 12 and int.from_bytes(f.payload[8:12], "little") == STNC_LIVE_POLL_B
    )
    micro_c = sum(1 for f in cframes if f.cmd == b"STCP" and len(f.payload) == 4)
    micro_s = sum(1 for f in sframes if f.cmd == b"STCP" and len(f.payload) == 4)
    print(f"Live snapshots (server): {live}")
    print(f"Client STNC 0x20003: {stnc_a}, 0x20053: {stnc_b}, STCP micro: {micro_c}")
    print(f"Server STCP micro: {micro_s}")
    if stnc_a:
        print(f"Live / poll-A ratio: {live / stnc_a:.2f}")

    # Find first live snapshot index on server
    first_live = next(i for i, f in enumerate(sframes) if "LIVE" in describe(f))

    # Client poll cycles: merge client frame list from first STNC 20003 after live
    first_poll = next(
        i
        for i, f in enumerate(cframes)
        if f.cmd == b"STNC"
        and int.from_bytes(f.payload[8:12], "little") == STNC_LIVE_POLL_A
    )
    poll_c = cframes[first_poll : first_poll + 500]
    print("\n--- First 24 client frames steady poll ---")
    for i, f in enumerate(poll_c[:24]):
        print(f"  {i:2} {describe(f)}")

    print("\n--- Server response template after client STNC 0x20003 (first 5 cycles) ---")
    cycles = 0
    i = first_poll
    while i < len(cframes) and cycles < 5:
        f = cframes[i]
        if f.cmd == b"STNC" and int.from_bytes(f.payload[8:12], "little") == STNC_LIVE_POLL_A:
            print(f"\nCycle {cycles} after client STNC 0x20003:")
            # approximate: next server frames until next client STNC (we don't have merge - scan server for pattern)
            cycles += 1
        i += 1

    # Server-side pattern: slice around live frames
    print("\n--- Server frames around first 3 LIVE snapshots ---")
    live_idxs = [i for i, f in enumerate(sframes) if "LIVE" in describe(f)][:3]
    for li in live_idxs:
        print(f"\nLIVE at server index {li}:")
        for j in range(max(0, li - 3), min(len(sframes), li + 4)):
            mark = ">>" if j == li else "  "
            print(f"  {mark} {j} {describe(sframes[j])}")

    # Inter-arrival live snapshots (server decode index proxy - count consecutive)
    live_idxs = [i for i, f in enumerate(sframes) if "LIVE" in describe(f)]
    if len(live_idxs) >= 2:
        gaps = [live_idxs[i + 1] - live_idxs[i] for i in range(min(20, len(live_idxs) - 1))]
        print(f"\nServer frame gaps between LIVE (first 20): {gaps}")
        print(f"Most common gap: {Counter(gaps).most_common(3)}")

    # Client pattern: STNC/micro alternation
    seq = []
    for f in poll_c[:200]:
        d = describe(f)
        if d.startswith("STNC") or d == "STCP micro":
            seq.append(d.replace("STNC ", ""))
    print("\n--- Client STNC/micro sequence (first 40 tokens) ---")
    print(" -> ".join(seq[:40]))

    # Server STCP64 op counts during steady (after first live)
    ops = Counter()
    for f in sframes[first_live:]:
        pl = f.payload
        if f.cmd == b"STCP" and len(pl) == 64:
            op = pl[24]
            ch = chr(op) if 32 <= op < 127 else op
            ops[ch] += 1
    print(f"\nServer STCP64 op counts after live start: {ops.most_common()}")


if __name__ == "__main__":
    main()
