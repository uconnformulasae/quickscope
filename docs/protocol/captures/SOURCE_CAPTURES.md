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
| **Download** (``download_aim_session``) | Pulling ``.xrz`` / log files only — second socket |

Reference: ``connect.pcapng`` stream 29 + ``116CaptureWireshark.pcapng`` streams 37/38.

| Source | Role |
|--------|------|
| `Live.pcapng` / `live_pedal.pcapng` | **Spec** — what RS3 actually sends |
| `RS3_live_1min.pcapng` stream **36** | Steady-state cadence + ack ordering |
| QuickScope pcaps (`new_dropped.pcapng`, `working_qs_live.pcapng`, …) | **Regression** — diff with `scripts/compare_live_pcaps.py` |
| `backend/data/logs/aim_live/sessions/*.jsonl` | Runtime trace for a given attempt |

When enum or live poll fails, diff JSONL event order against the matching phase in `Live.pcapng` stream 1 (hello → STNC `0x00010010` → STCP `H`/`A` → 68-byte date → blob → setup STNCs → `0x00020003`/`0x00020053`).
