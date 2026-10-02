# Race Studio 3 reference captures (ground truth)

AiM protocol work in QuickScope must trace back to these Wireshark files from Race Studio 3.

## Primary — full connect lifecycle (live + session list)

| Capture | Path | tcp.stream | Scenario |
|---------|------|------------|----------|
| **Connect** | `c:\Users\jesse\Downloads\connect.pcapng` | **29** | Campus WiFi → AiM WiFi → RS3 connect → **live view** → **Data download / session list** on the **same** TCP socket (`10.0.0.10:49855` ↔ `10.0.0.1:2000`) |

Repo fixture: `fixtures/connect_2026_follow_raw.txt` (exported from stream 29).

On that single connection, client STNC order is roughly:

1. Live enumeration (`0x00010010`, `0x00010006`, …) + setup (`0x00060024`, …)
2. ~49 live poll pairs (`0x00020003` / `0x00020053`) with 691-byte snapshots
3. Session download prep (`0x00020051` ×2) + list (`0x00020024`) — CSV appears on the **same** byte stream

## Focused live-only captures (UConn EVO5)

| Capture | Path | tcp.stream | Scenario |
|---------|------|------------|----------|
| Live only | `c:\Users\jesse\Downloads\Live.pcapng` | **1** | Connect → live dashboard only |
| Live + pedals | `c:\Users\jesse\Downloads\live_pedal.pcapng` | **45** | Live while moving TPS1/TPS2 |
| **Live 1 min steady** | `c:\Users\jesse\Downloads\RS3_live_1min.pcapng` | **36** | ~60 s RS3 live only — poll-pair cadence (~97×691 B / min) |
| **113ch pedal (RS3)** | `c:\Users\jesse\Downloads\RS3-5-47.pcapng` | **0** | 707 B `Syst` / `Q:703`; micro cycles all `(1,1)` |
| **QS drop (pre-fix)** | `c:\Users\jesse\Downloads\working-dropped-5-55.pcapng` | **8** | 21×707 B then device RST; 19/22 cycles `(1,2)` from post-LIVE micro |
| **QS drop (post micro-fix, still no reconnect)** | `~/Downloads/wireshark/working-dropped-6-50.pcapng` | **10** | Clean `(1,1)` micro cycles, 16×707 B, then **device**-initiated FIN at ~31s. Client (pre-fix) kept polling after FIN → device RST. Root cause of the "drops around 20 frames" bug: `AimLiveClient.stream()` treated the device FIN as fatal instead of reconnecting. |
| **RS3 long session (reconnect reference)** | `~/Downloads/wireshark/RS3-9-22-26-long.pcapng` | **30/31/32** | Race Studio itself gets the same device-initiated close every 40–90s and reconnects transparently (new TCP + full enum) — this is the behavior QuickScope now mirrors |
| **RS3 long live (keepalive reference)** | `c:\Users\jesse\Downloads\RS3_long_live.pcapng` | — | `aim-ka` UDP 36002→36002 every ~1.1 s (207 sent / 174 replies); one live TCP held **149 s**, closed by RS3 (client FIN). Reconnect → first 595 B frame in 0.7–0.85 s |
| **QS live, no keepalive** | `c:\Users\jesse\Downloads\QS_Live_long_reconnect.pcapng` | — | One `aim-ka` in 143 s → device FIN every **30.8 s**; ~2 s data gap (~4 frames) per reconnect, one 11.5 s gap when 4 hellos went unanswered. Fix: `AimLiveClient` runs `AimKeepalive` for the client's lifetime |

Fixtures: `live_2026_follow_raw.txt`, `live_pedal_2026_follow_raw.txt`.

**After TCP-drop fix:** capture ≥60 s QuickScope live on car, then:

```powershell
python scripts/compare_live_pcaps.py "path\to\new_qs.pcapng" "c:\Users\jesse\Downloads\RS3-5-47.pcapng"
```

Expect `bad` micro cycles **0**, LIVE count growing, no `RST from 10.0.0.1` in TCP end.

Analyze RS3 1 min capture:

```powershell
python scripts/analyze_rs3_live_pcap.py "c:\Users\jesse\Downloads\RS3_live_1min.pcapng" --stream 36
```

Committed text fixtures under `fixtures/` are derived from these pcaps. Re-export when the on-car logger or RS3 version changes.

## Wireshark

1. Open the `.pcapng`.
2. Filter `tcp.port == 2000`.
3. **Statistics → Follow → TCP stream** (use stream index above).
4. Compare hex against `backend/services/aim_live.py` handshake and poll loop.

## tshark → fixture files

```powershell
tshark -r "c:\Users\jesse\Downloads\connect.pcapng" -q -z follow,tcp,raw,29 `
  | Out-File -Encoding utf8 docs/protocol/captures/fixtures/connect_2026_follow_raw.txt

tshark -r "c:\Users\jesse\Downloads\Live.pcapng" -q -z follow,tcp,raw,1 `
  | Out-File -Encoding utf8 docs/protocol/captures/fixtures/live_2026_follow_raw.txt

tshark -r "c:\Users\jesse\Downloads\live_pedal.pcapng" -q -z follow,tcp,raw,45 `
  | Out-File -Encoding utf8 docs/protocol/captures/fixtures/live_pedal_2026_follow_raw.txt
```

Then run `python -m pytest tests/test_aim_live.py`.

## Primary vs download TCP (Race Studio)

| TCP | Used for |
|-----|----------|
| **Primary** (``aim_primary_hub``) | Connect, live handshake, live poll, session list — one socket |
| **Download** (``download_aim_session``) | Pulling ``.xrz`` / log files only — fresh socket after the primary is closed |

Reference: ``connect.pcapng`` stream 29 + ``116CaptureWireshark.pcapng`` streams 37/38.

Current RS3 downloads the file on the **same** TCP as the session list (RS3_PULL_* below). QuickScope deliberately keeps a separate download TCP, opened only after the primary is closed; QS_Pull_241 proves the device serves it at full speed. The device **ignores** a second port-2000 connection while another is open (accepts SYN, never replies).

## Log download (A116 / a_0241 / a_0242, 2026-09)

| Capture | Path | Scenario |
|---------|------|----------|
| `116CaptureWireshark.pcapng` | repo root / `Downloads` | RS3, 2,482,176 B; streams **37** (list) + **38** (download); client acks `0, 982320, 1964640, 0` |
| `RS3_PULL_241.pcapng` | `Downloads` | RS3, `a_0241.xrz` 3,149,824 B on the list TCP; ~215 KB/s; 0 retransmits; `aim-ka` every 1.24 s throughout |
| `RS3_PULL_242.pcapng` | `Downloads` | RS3, `a_0242.xrz` 4,091,904 B; acks exactly at each 982,320 boundary; no stall acks |
| `QS_Pull_241.pcapng` | `Downloads` | QuickScope `98e3ac3`: download identical to RS3 (same SHA-1), 203 KB/s — but a legacy list TCP sat ignored for ~37 s first, and `aim-ka` stopped before the download |
| `QS_Pull_242.pcapng` | `Downloads` | QuickScope `98e3ac3`: WiFi loss → 1.3–1.6 s device retransmit stalls → old 0.4 s stall acks at partial offsets → device queued replays (2.16 MB duplicated); only 1.47 MB of 4.09 MB unique |

Download rules derived from these (``aim_connector._receive_file_data``):

- Every client STCP 4-byte ack **N** queues a batch of 982,320 B starting at file offset **N**. Ack only exact boundaries (`acked_through + k * 982320`), never mid-batch.
- Pauses of ~1.5–3 s are the device's own TCP retransmit timer; wait them out. Only resume (ack the contiguous prefix) after 8 s of silence.
- Place blocks by absolute file offset; stop feeding once the file is complete (RS3 lists sessions next on the same TCP, which also uses offset-0 blocks).
- Keep `aim-ka` running during the download.

Replay tests (no tshark needed; pcaps located via `QUICKSCOPE_AIM_CAPTURES`, repo root, or `~/Downloads`): `pytest tests/test_aim_download.py`. Quick stream summary: `python scripts/aim_pcapng.py <file.pcapng>`.

| Source | Role |
|--------|------|
| `Live.pcapng` / `live_pedal.pcapng` | **Spec** — what RS3 actually sends |
| `RS3_live_1min.pcapng` stream **36** | Steady-state cadence + ack ordering |
| QuickScope pcaps (`new_dropped.pcapng`, `working_qs_live.pcapng`, …) | **Regression** — diff with `scripts/compare_live_pcaps.py` |
| `backend/data/logs/aim_live/sessions/*.jsonl` | Runtime trace for a given attempt |

When enum or live poll fails, diff JSONL event order against the matching phase in `Live.pcapng` stream 1 (hello → STNC `0x00010010` → STCP `H`/`A` → 68-byte date → blob → setup STNCs → `0x00020003`/`0x00020053`).
