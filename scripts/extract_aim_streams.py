"""Extract the AiM TCP byte streams the replay tests need from Wireshark captures.

A raw .pcapng carries Ethernet/IP headers (laptop MAC and IP) and any other
traffic on the WiFi link. The tests only need the reassembled AiM port-2000
payload bytes, so this writes exactly that, gzipped, one file per direction:

    <stem>.server.bin.gz   device -> laptop
    <stem>.client.bin.gz   laptop -> device

Usage (from repo root):

    python scripts/extract_aim_streams.py ~/Downloads             # every known capture found there
    python scripts/extract_aim_streams.py ~/Downloads --out tests/fixtures/aim_streams

The output folder is what CI downloads from the ``aim-streams-v1`` release
(see docs/CI.md).
"""

from __future__ import annotations

import argparse
import gzip
import sys
from pathlib import Path

import aim_pcapng

# Which TCP stream of each capture the tests replay: live captures use the
# first AiM stream, pull captures the largest (the file download itself).
CAPTURE_STREAMS: dict[str, str] = {
    "oct1livetest1.pcapng": "first",
    "IC_RS3_live.pcapng": "first",
    "ictestoct1.pcapng": "first",
    "116CaptureWireshark.pcapng": "largest",
    "RS3_PULL_241.pcapng": "largest",
    "QS_Pull_241.pcapng": "largest",
    "RS3_PULL_242.pcapng": "largest",
    "QS_Pull_242.pcapng": "largest",
}

DEFAULT_OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "aim_streams"


def capture_stream_from_pcap(path: Path, *, client_to_server: bool) -> bytes:
    choice = CAPTURE_STREAMS.get(path.name, "largest")
    stream = aim_pcapng.tcp_streams(path)[0] if choice == "first" else aim_pcapng.largest_stream(path)
    return stream.reassemble(client_to_server=client_to_server)


def extract(capture: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for direction, client_to_server in (("server", False), ("client", True)):
        data = capture_stream_from_pcap(capture, client_to_server=client_to_server)
        target = out_dir / f"{capture.stem}.{direction}.bin.gz"
        # mtime=0 keeps the output byte-identical across runs.
        target.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))
        written.append(target)
    return written


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="folder holding the .pcapng captures")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output folder (default: {DEFAULT_OUT})")
    args = parser.parse_args(argv)

    missing = []
    for name in CAPTURE_STREAMS:
        capture = args.source / name
        if not capture.is_file():
            missing.append(name)
            continue
        for target in extract(capture, args.out):
            print(f"{target}  ({target.stat().st_size:,} bytes)")
    if missing:
        print("not found (skipped): " + ", ".join(missing), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
