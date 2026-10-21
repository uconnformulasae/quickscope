# AIM live capture fixtures (2026)

Exported from **Race Studio 3** Wireshark captures on UConn EVO5 WiFi (`10.0.0.11` ↔ `10.0.0.1:2000`).

**Authoritative pcaps** (re-export fixtures from these paths when updating protocol code):

- `c:\Users\jesse\Downloads\Live.pcapng`
- `c:\Users\jesse\Downloads\live_pedal.pcapng`

See also `../SOURCE_CAPTURES.md`.

| File | Source pcap | tcp.stream | Scenario |
|------|-------------|------------|----------|
| `live_2026_follow_raw.txt` | `Live.pcapng` | 1 | Connect + view live only |
| `live_pedal_2026_follow_raw.txt` | `live_pedal.pcapng` | 45 | Live view while moving TPS1/TPS2 |

Generate with:

```powershell
tshark -r "c:\Users\jesse\Downloads\Live.pcapng" -q -z follow,tcp,raw,1
tshark -r "c:\Users\jesse\Downloads\live_pedal.pcapng" -q -z follow,tcp,raw,45
```

Parsed with `docs/protocol/captures/parse_aim_stream.py`.

### Trimmed live fixtures

Server side only: the channel-layout frame(s) plus the first 20 live snapshots,
cut from captures too large to commit. They let the layout/snapshot tests in
`tests/test_aim_live.py` run without the original pcaps.

| File | Source pcap | Live frame size | Logger |
|------|-------------|-----------------|--------|
| `oct1_live_trimmed_follow_raw.txt` | `oct1livetest1.pcapng` | 595 B | UConn EV |
| `ic_rs3_live_trimmed_follow_raw.txt` | `IC_RS3_live.pcapng` | 494 B | UConn IC (85 ch) |
| `ictestoct1_live_trimmed_follow_raw.txt` | `ictestoct1.pcapng` | 494 B | UConn IC (85 ch) |

Regenerate with:

```sh
python scripts/trim_live_capture.py ~/Downloads/oct1livetest1.pcapng docs/protocol/captures/fixtures/oct1_live_trimmed_follow_raw.txt --live-size 595
python scripts/trim_live_capture.py ~/Downloads/IC_RS3_live.pcapng docs/protocol/captures/fixtures/ic_rs3_live_trimmed_follow_raw.txt --live-size 494
python scripts/trim_live_capture.py ~/Downloads/ictestoct1.pcapng docs/protocol/captures/fixtures/ictestoct1_live_trimmed_follow_raw.txt --live-size 494
```

**Steady-state server STCP payload lengths:** 64 (acks), 691 (live snapshot), 12 (`kkk` heartbeat). No 547-byte snapshots on this logger config.
