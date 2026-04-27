"""Extract every unique client STNC payload from a follow-tcp dump and show its
sub-command code (LE u32 at payload offset 8..11) and frequency."""
from __future__ import annotations
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_aim_stream import load_stream, parse_frames  # noqa: E402

if len(sys.argv) < 2:
    print("usage: extract_stnc.py <follow_dump.txt>")
    raise SystemExit(2)

c2s, _ = load_stream(Path(sys.argv[1]))
frames = parse_frames(c2s, "C")
stnc = [f for f in frames if f.cmd == b"STNC"]
print(f"# {len(stnc)} client STNC frames")
print()

unique_payloads: Counter = Counter()
for f in stnc:
    unique_payloads[f.payload.hex()] += 1

print(f"# {len(unique_payloads)} unique STNC payloads")
print()
print("# Top 10 by frequency:")
for hex_payload, count in unique_payloads.most_common(10):
    payload = bytes.fromhex(hex_payload)
    sub_cmd = int.from_bytes(payload[8:12], "little")
    print(f"  count={count:>4}  sub-cmd=0x{sub_cmd:08x}  payload[0:24]={hex_payload[:48]}...")

print()
print("# Sub-commands by frequency:")
sub_cmds: Counter = Counter()
for f in stnc:
    sub_cmd = int.from_bytes(f.payload[8:12], "little")
    sub_cmds[sub_cmd] += 1
for sub_cmd, count in sub_cmds.most_common():
    print(f"  count={count:>4}  sub-cmd=0x{sub_cmd:08x}")
