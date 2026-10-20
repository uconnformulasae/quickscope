"""Cut a small live-view fixture out of a Wireshark capture.

Keeps only the device's channel-layout frame(s) and the first few live
snapshot frames of the first AiM TCP stream, written in the same
``tshark -z follow,tcp,raw`` text format as the other files in
``docs/protocol/captures/fixtures/`` (read back with ``parse_aim_stream.load_stream``).
The full captures are tens of MB and stay out of the repo; the trimmed file is
enough for the layout/snapshot decoding tests to run in CI.

    python scripts/trim_live_capture.py ~/Downloads/IC_RS3_live.pcapng \
        docs/protocol/captures/fixtures/ic_rs3_live_trimmed_follow_raw.txt --live-size 494
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from scripts.aim_pcapng import tcp_streams  # noqa: E402
from services.aim_live import decode_frame  # noqa: E402
from services.aim_live_layout import is_layout_blob  # noqa: E402

_LIVE_TAG = b"kkk\x01"
_HEX_LINE = 64  # bytes per output line


def trim(capture: Path, live_size: int, max_live: int) -> tuple[bytes, int, int]:
    """Server->client bytes holding the layout frames and first live frames."""
    buf = tcp_streams(capture)[0].reassemble(client_to_server=False)
    out = bytearray()
    layouts = live = 0
    off = 0
    while off < len(buf):
        frame, n = decode_frame(buf, off)
        if frame is None:
            off += n or 1
            continue
        raw = buf[off:off + n]
        off += n
        if is_layout_blob(frame.payload):
            out += raw
            layouts += 1
        elif len(frame.payload) == live_size and frame.payload[4:8] == _LIVE_TAG and live < max_live:
            out += raw
            live += 1
    return bytes(out), layouts, live


def write_follow_raw(path: Path, server_bytes: bytes, source: str) -> None:
    lines = [
        "===================================================================",
        "Follow: tcp,raw",
        f"Filter: trimmed from {source} (layout + first live frames, server side only)",
        "Node 0: 10.0.0.1:2000",
        "Node 1: 10.0.0.11:0",
    ]
    for i in range(0, len(server_bytes), _HEX_LINE):
        lines.append(server_bytes[i:i + _HEX_LINE].hex())
    lines.append("===================================================================")
    path.write_text("\n".join(lines) + "\n")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("capture", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--live-size", type=int, required=True, help="live snapshot payload length (e.g. 494, 595)")
    ap.add_argument("--max-live", type=int, default=20)
    args = ap.parse_args(argv)

    data, layouts, live = trim(args.capture, args.live_size, args.max_live)
    if not layouts or not live:
        print(f"found {layouts} layout and {live} live frames; nothing written", file=sys.stderr)
        return 1
    write_follow_raw(args.out, data, args.capture.name)
    print(f"{args.out}: {layouts} layout + {live} live frames, {len(data)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
