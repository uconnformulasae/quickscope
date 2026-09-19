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

**Steady-state server STCP payload lengths:** 64 (acks), 691 (live snapshot), 12 (`kkk` heartbeat). No 547-byte snapshots on this logger config.
