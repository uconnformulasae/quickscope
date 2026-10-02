"""Compare AiM live TCP client/server frame patterns across Wireshark captures."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from services.aim_live import (  # noqa: E402
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    _is_live_snapshot_payload,
    decode_frame,
)

TSHARK = Path(r"C:\Program Files\Wireshark\tshark.exe")


def pick_stream(pcap: Path) -> int:
    """Longest tcp.port==2000 conversation by payload bytes."""
    raw = subprocess.check_output(
        [
            str(TSHARK),
            "-r",
            str(pcap),
            "-q",
            "-z",
            "conv,tcp",
        ],
        text=True,
        errors="replace",
    )
    best_stream: int | None = None
    best_bytes = -1
    for line in raw.splitlines():
        if ":2000" not in line or "<->" not in line:
            continue
        m = re.search(r"(\d+)\s+k?B\s+\d+\s+\S+\s+\d+\s+\S+\s+\d+\s+(\d+)\s+k?B", line)
        if not m:
            continue
        total_kb = m.group(2)
        total = int(total_kb) * 1000 if "kB" in line else int(total_kb)
        # Map to stream index via tshark fields on matching endpoint
    # Fallback: count packets per stream
    out = subprocess.check_output(
        [
            str(TSHARK),
            "-r",
            str(pcap),
            "-Y",
            "tcp.port==2000 and tcp.len>0",
            "-T",
            "fields",
            "-e",
            "tcp.stream",
        ],
        text=True,
        errors="replace",
    )
    counts = Counter(int(x) for x in out.split() if x.isdigit())
    if not counts:
        raise SystemExit(f"No tcp:2000 in {pcap}")
    return counts.most_common(1)[0][0]


def load_follow(pcap: Path, stream: int) -> tuple[bytearray, bytearray]:
    raw = subprocess.check_output(
        [str(TSHARK), "-r", str(pcap), "-q", "-z", f"follow,tcp,raw,{stream}"],
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
        return f"STNC:0x{sub:08x}"
    if frame.cmd != b"STCP":
        return frame.cmd.decode("ascii", errors="replace")
    if len(pl) == 4:
        return "micro"
    if len(pl) == 12:
        tag = pl[4:8].decode("ascii", errors="replace").rstrip("\x00")
        return f"hb:{tag!r}"
    if len(pl) == 64:
        op = pl[24]
        ch = chr(op) if 32 <= op < 127 else f"0x{op:02x}"
        hint = int.from_bytes(pl[16:20], "little")
        return f"64:{ch}:{hint}"
    if _is_live_snapshot_payload(pl):
        return f"LIVE:{len(pl)}"
    return f"STCP:{len(pl)}"


def stnc_sub(frame) -> int | None:
    if frame.cmd != b"STNC" or len(frame.payload) < 12:
        return None
    return int.from_bytes(frame.payload[8:12], "little")


def poll_token(frame) -> str | None:
    d = describe(frame)
    if d.startswith("STNC:0x"):
        return d.replace("STNC:", "")
    if d == "micro":
        return "micro"
    return None


def analyze_poll_pairs(cframes: list) -> dict:
    """Classify client steady poll as RS3 pair vs legacy alternate."""
    first_poll = None
    for i, f in enumerate(cframes):
        if stnc_sub(f) == STNC_LIVE_POLL_A:
            first_poll = i
            break
    if first_poll is None:
        return {"first_poll_idx": None}

    poll_frames = cframes[first_poll:]
    tokens = [poll_token(f) for f in poll_frames[:400]]
    tokens = [t for t in tokens if t]

    pair_ok = 0
    pair_bad = 0
    legacy_wait_pattern = 0  # 20003 ... LIVE ... micro ... 20053 (approx)
    i = 0
    while i < len(tokens) - 3:
        if tokens[i] == "0x00020003" and tokens[i + 1] == "micro":
            if i + 3 < len(tokens) and tokens[i + 2] == "0x00020053" and tokens[i + 3] == "micro":
                pair_ok += 1
                i += 4
                continue
            pair_bad += 1
        if tokens[i] == "0x00020003":
            # micro not immediately after A
            j = i + 1
            while j < len(tokens) and tokens[j] != "0x00020053":
                if tokens[j] == "micro":
                    legacy_wait_pattern += 1
                    break
                j += 1
        i += 1

    # Orphan micro / STNC counts
    stnc_a = sum(1 for f in poll_frames if stnc_sub(f) == STNC_LIVE_POLL_A)
    stnc_b = sum(1 for f in poll_frames if stnc_sub(f) == STNC_LIVE_POLL_B)
    micro = sum(1 for f in poll_frames if f.cmd == b"STCP" and len(f.payload) == 4)

    return {
        "first_poll_idx": first_poll,
        "stnc_a": stnc_a,
        "stnc_b": stnc_b,
        "micro": micro,
        "micro_per_pair_expected": stnc_a * 2,
        "micro_deficit": stnc_a * 2 - micro,
        "rs3_pair_sequences": pair_ok,
        "broken_pair_starts": pair_bad,
        "micro_after_live_before_b": legacy_wait_pattern,
        "first_16_tokens": " ".join(tokens[:16]),
    }


def analyze_poll_micro_cycles(cframes: list) -> dict:
    """Count 4 B acks after each steady poll STNC A/B; RS3 expects (1, 1) every cycle."""
    first_poll = None
    for i, f in enumerate(cframes):
        if stnc_sub(f) == STNC_LIVE_POLL_A:
            first_poll = i
            break
    if first_poll is None:
        return {"cycle_count": 0, "bad_cycles": 0, "bad_samples": [], "all_rs3_micro": False}

    poll = cframes[first_poll:]
    cycles: list[tuple[int, int]] = []
    ci = 0
    while ci < len(poll) - 3:
        if stnc_sub(poll[ci]) == STNC_LIVE_POLL_A:
            j = ci + 1
            micros_a = 0
            while j < len(poll) and poll[j].cmd == b"STCP" and len(poll[j].payload) == 4:
                micros_a += 1
                j += 1
            if j < len(poll) and stnc_sub(poll[j]) == STNC_LIVE_POLL_B:
                k = j + 1
                micros_b = 0
                while k < len(poll) and poll[k].cmd == b"STCP" and len(poll[k].payload) == 4:
                    micros_b += 1
                    k += 1
                cycles.append((micros_a, micros_b))
                ci = k
                continue
        ci += 1

    bad = [(i, a, b) for i, (a, b) in enumerate(cycles) if a != 1 or b != 1]
    return {
        "cycle_count": len(cycles),
        "bad_cycles": len(bad),
        "bad_samples": bad[:8],
        "all_rs3_micro": len(cycles) > 0 and len(bad) == 0,
    }


def tcp_close_detail(pcap: Path, stream: int) -> dict:
    """FIN/RST sources on the tcp.stream (device is usually 10.0.0.1)."""
    out = subprocess.check_output(
        [
            str(TSHARK),
            "-r",
            str(pcap),
            "-Y",
            f"tcp.stream=={stream}",
            "-T",
            "fields",
            "-e",
            "tcp.flags.reset",
            "-e",
            "tcp.flags.fin",
            "-e",
            "ip.src",
            "-e",
            "frame.time_relative",
        ],
        text=True,
        errors="replace",
    )
    last_fin_src = ""
    last_fin_t = ""
    last_rst_src = ""
    last_rst_t = ""
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        reset, fin, src, t = parts[0], parts[1], parts[2], parts[3]
        if reset in ("1", "True"):
            last_rst_src = src
            last_rst_t = t
        if fin in ("1", "True"):
            last_fin_src = src
            last_fin_t = t
    hint = "unknown"
    if last_rst_src:
        hint = f"RST from {last_rst_src} @ {last_rst_t}s"
    elif last_fin_src:
        hint = f"FIN from {last_fin_src} @ {last_fin_t}s"
    return {
        "fin_src": last_fin_src or None,
        "fin_t": last_fin_t,
        "rst_src": last_rst_src or None,
        "rst_t": last_rst_t,
        "hint": hint,
    }


def tcp_close_hint(pcap: Path, stream: int) -> str:
    return tcp_close_detail(pcap, stream)["hint"]


@dataclass
class Report:
    label: str
    pcap: str
    stream: int
    client_bytes: int
    server_bytes: int
    live_count: int
    poll: dict
    micro_cycles: dict
    close: str
    close_detail: dict
    server_live_gaps: list[int]


def analyze(pcap: Path, *, stream: int | None, label: str) -> Report:
    if stream is None:
        stream = pick_stream(pcap)
    client, server = load_follow(pcap, stream)
    cframes = list(iter_frames(client))
    sframes = list(iter_frames(server))
    live_idxs = [i for i, f in enumerate(sframes) if describe(f).startswith("LIVE:")]
    gaps = [live_idxs[i + 1] - live_idxs[i] for i in range(len(live_idxs) - 1)][:15]
    poll = analyze_poll_pairs(cframes)
    close_detail = tcp_close_detail(pcap, stream)
    return Report(
        label=label,
        pcap=str(pcap),
        stream=stream,
        client_bytes=len(client),
        server_bytes=len(server),
        live_count=len(live_idxs),
        poll=poll,
        micro_cycles=analyze_poll_micro_cycles(cframes),
        close=close_detail["hint"],
        close_detail=close_detail,
        server_live_gaps=gaps,
    )


def print_report(r: Report) -> None:
    print(f"\n{'=' * 72}")
    print(f"{r.label}")
    print(f"  {r.pcap}  stream={r.stream}")
    print(f"  bytes client={r.client_bytes} server={r.server_bytes}")
    print(f"  LIVE snapshots (server): {r.live_count}")
    p = r.poll
    if p.get("first_poll_idx") is None:
        print("  NO poll STNC 0x20003 found (handshake only or failed early)")
    else:
        print(
            f"  poll STNC-A={p['stnc_a']} STNC-B={p['stnc_b']} micro={p['micro']} "
            f"(expected micro~{p['micro_per_pair_expected']}, deficit={p['micro_deficit']})"
        )
        print(
            f"  RS3 pair pattern (A,micro,B,micro): {p['rs3_pair_sequences']} ok, "
            f"{p['broken_pair_starts']} broken starts, "
            f"legacy micro-between-A-and-B: {p['micro_after_live_before_b']}"
        )
        print(f"  first tokens: {p['first_16_tokens']}")
    mc = r.micro_cycles
    if mc.get("cycle_count"):
        flag = "ok" if mc.get("all_rs3_micro") else "DRIFT"
        print(
            f"  micro cycles A/B: {mc['cycle_count']} total, "
            f"{mc['bad_cycles']} not (1,1) [{flag}]"
        )
        if mc.get("bad_samples"):
            print(f"  bad cycle samples (idx, micros_A, micros_B): {mc['bad_samples']}")
    if r.server_live_gaps:
        print(f"  server frame gaps between LIVE (first 15): {r.server_live_gaps}")
        print(f"  common gap: {Counter(r.server_live_gaps).most_common(2)}")
    cd = r.close_detail
    print(f"  TCP end: {r.close}")
    if cd.get("rst_src"):
        print(f"  TCP RST: {cd['rst_src']} @ {cd.get('rst_t', '?')}s")
    elif cd.get("fin_src"):
        print(f"  TCP FIN: {cd['fin_src']} @ {cd.get('fin_t', '?')}s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcaps", nargs="*", help="pcap paths")
    ap.add_argument("--stream", type=int, action="append", default=[], help="tcp.stream per pcap")
    ap.add_argument("--label", action="append", default=[], help="label per pcap")
    args = ap.parse_args()

    defaults = [
        (r"c:\Users\jesse\Downloads\RS3_live_1min.pcapng", 36, "RS3 1min (ground truth)"),
        (r"c:\Users\jesse\Downloads\Live.pcapng", 1, "RS3 Live.pcapng short"),
        (r"c:\Users\jesse\Downloads\new_dropped.pcapng", 90, "QS new_dropped"),
        (r"c:\Users\jesse\Downloads\working_qs_live.pcapng", 39, "QS working_qs_live"),
        (r"c:\Users\jesse\Downloads\connected_Qs_live.pcapng", 25, "QS connected_Qs_live"),
        (r"c:\Users\jesse\Downloads\QuickScope_live.pcapng", 0, "QS QuickScope_live (early)"),
    ]
    if args.pcaps:
        items = []
        for i, p in enumerate(args.pcaps):
            st = args.stream[i] if i < len(args.stream) else None
            lb = args.label[i] if i < len(args.label) else Path(p).stem
            items.append((p, st, lb))
    else:
        items = [(p, st, lb) for p, st, lb in defaults if Path(p).exists()]

    reports = [analyze(Path(p), stream=st, label=lb) for p, st, lb in items]
    for r in reports:
        print_report(r)

    print(f"\n{'=' * 72}")
    print("SUMMARY (steady poll phase)")
    print(
        f"{'label':28} {'LIVE':>6} {'A':>5} {'B':>5} {'micro':>6} {'def':>5} "
        f"{'pairs':>6} {'cyc':>4} {'bad':>4} close"
    )
    for r in reports:
        p = r.poll
        if p.get("first_poll_idx") is None:
            print(f"{r.label:28} {'—':>6}")
            continue
        mc = r.micro_cycles
        print(
            f"{r.label:28} {r.live_count:6} {p['stnc_a']:5} {p['stnc_b']:5} {p['micro']:6} "
            f"{p['micro_deficit']:5} {p['rs3_pair_sequences']:6} "
            f"{mc.get('cycle_count', 0):4} {mc.get('bad_cycles', 0):4} {r.close[:32]}"
        )


if __name__ == "__main__":
    main()
