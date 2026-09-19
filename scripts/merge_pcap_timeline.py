"""Chronological AiM frames on tcp.stream for RS3 vs QuickScope diff."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from services.aim_live import decode_frame, _is_live_snapshot_payload  # noqa: E402

TSHARK = r"C:\Program Files\Wireshark\tshark.exe"


def merged_events(pcap: Path, stream: int) -> list[tuple[float, str, str]]:
    out = subprocess.check_output(
        [
            TSHARK,
            "-r",
            str(pcap),
            "-Y",
            f"tcp.stream=={stream} and tcp.len>0",
            "-T",
            "fields",
            "-e",
            "frame.time_relative",
            "-e",
            "tcp.srcport",
            "-e",
            "tcp.payload",
        ],
        text=True,
        errors="replace",
    )
    events: list[tuple[float, str, str]] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        t = float(parts[0])
        port = parts[1]
        hexpl = parts[2]
        if not hexpl:
            continue
        data = bytes.fromhex(hexpl.replace(":", ""))
        pos = 0
        while pos < len(data):
            try:
                fr, n = decode_frame(data[pos:])
            except ValueError:
                pos += 1
                continue
            if fr is None:
                break
            side = "cli" if port != "2000" else "srv"
            pl = fr.payload
            desc = fr.cmd.decode("ascii", errors="replace")
            if fr.cmd == b"STNC" and len(pl) >= 12:
                sub = int.from_bytes(pl[8:12], "little")
                desc = f"STNC 0x{sub:08x}"
            elif fr.cmd == b"STCP":
                if len(pl) == 4:
                    desc = "micro"
                elif len(pl) == 64:
                    op = pl[24]
                    ch = chr(op) if 32 <= op < 127 else str(op)
                    desc = f"64:{ch}"
                elif len(pl) == 12:
                    desc = "hb"
                elif _is_live_snapshot_payload(pl):
                    desc = f"LIVE:{len(pl)}"
                else:
                    desc = f"stcp{len(pl)}"
            events.append((t, side, desc))
            pos += n
    return events


def first_poll_idx(ev: list) -> int:
    for i, e in enumerate(ev):
        if e[2] == "STNC 0x00020003":
            return i
    raise ValueError("no poll")


def main() -> None:
    cases = [
        ("RS3 1min", Path(r"c:\Users\jesse\Downloads\RS3_live_1min.pcapng"), 36),
        ("QS new_dropped", Path(r"c:\Users\jesse\Downloads\new_dropped.pcapng"), 90),
    ]
    for label, pcap, stream in cases:
        ev = merged_events(pcap, stream)
        i = first_poll_idx(ev)
        print(f"=== {label} first poll cycle (22 events) ===")
        for e in ev[i : i + 22]:
            print(f"  {e[0]:9.4f} {e[1]:3} {e[2]}")
        print("--- client frame after server 64:I or 64:Q (first 10) ---")
        n = 0
        for j in range(i, min(len(ev) - 1, i + 1200)):
            if ev[j][1] == "srv" and ev[j][2] in ("64:I", "64:Q"):
                k = j + 1
                while k < len(ev) and ev[k][0] - ev[j][0] < 0.25:
                    if ev[k][1] == "cli":
                        dt = ev[k][0] - ev[j][0]
                        print(f"  after {ev[j][2]} -> {ev[k][2]} (dt={dt:.4f}s)")
                        n += 1
                        break
                    k += 1
                if n >= 10:
                    break
        print()


if __name__ == "__main__":
    main()
