# AiM device connectivity

QuickScope talks to AiM loggers over the device WiFi hotspot using a binary protocol (not HTTP).

| Transport | Port | Role |
|-----------|------|------|
| UDP | 36002 | Discovery and **keep-alive** (`aim-ka`, 6 bytes) |
| TCP | 2000 | Session list, live streaming, and control |

Default device IP is `10.0.0.1` (override in Settings or `aim_device_ip` in `settings.json`).

## Connection model (match Race Studio)

Race Studio uses **one TCP** for connect, live enumeration, live polling, browsing the on-device session list, and downloading log files (`RS3_PULL_241/242.pcapng`).

QuickScope mirrors that:

| Component | Module | Responsibility |
|-----------|--------|----------------|
| Primary TCP | `aim_primary_hub.py` + `aim_live.py` | Connect, 3-pass enumeration, live poll, session list, and file download (`AimLiveClient.download_file`) on one socket |
| Fallback download TCP | `aim_connector.download_aim_session` | Only if the primary fails mid-pull: one fresh socket per remaining file |
| UDP keep-alive | `aim_keepalive.py` | Send `aim-ka` about every 1 s for the whole life of the primary TCP, and during fallback downloads |
| Background indexer | `aim_pull_indexer.py` | Parse pulled files and fill in session metadata after the device is released |

Without UDP keep-alive, EVO5 firmware closes the primary TCP roughly 30 s after connect even when the live poll loop is correct. Race Studio sends the same probe continuously; see [protocol/captures/SOURCE_CAPTURES.md](protocol/captures/SOURCE_CAPTURES.md).

**Concurrency:** Only one consumer holds the primary hub at a time (live WebSocket vs session list). Stop live polling before listing or downloading so you do not run two pollers on the same socket.

## User workflow

1. Join the AiM WiFi SSID (configure name in Settings).
2. Confirm the green AiM indicator in the session browser.
3. **Pull from AiM** — list and download sessions on the primary TCP. The bar tracks device bytes only; rows then show **indexing** while laps and metadata are parsed in the background.
4. **Live view** — WebSocket at `/api/live/ws` drives `AimLiveClient.stream()` on the primary TCP.

Downloaded files land in `backend/data/sessions/` and are indexed in `sessions.json`.

## Steady-state live poll (summary)

After handshake, each ~250 ms cycle is:

1. STNC `0x00020003` → one 4-byte STCP micro-ACK  
2. STNC `0x00020053` → one 4-byte STCP micro-ACK  
3. Wait for the LIVE STCP payload (size depends on channel count; **707 B** / `Q:703` on the current 113-channel UConn EVO5 config)

Do **not** send an extra micro-ACK after consuming the LIVE payload. Extra acks produce `(1,2)` micro cycles and the device resets the connection.

Full byte-level spec: [protocol/aim-live-protocol.md](protocol/aim-live-protocol.md).

## File download (summary)

`POST /api/aim/pull` sequence (mirrors `RS3_PULL_241/242.pcapng`):

1. `aim_primary_hub.download_sessions` takes the primary lock once. It reuses the session list the picker fetched on the same socket (sizes, device dates), or lists again if the primary was reconnected. Never open a separate list TCP: the device ignores a second port-2000 connection while the primary is open, which cost ~37 s per pull (`QS_Pull_241/242.pcapng`).
2. Per file, on the primary: STNC `0x00040002` file request → `I` + `Q` (file size) → ack `0` → data. Then a bare `0x00020024` re-list, as RS3 does after every download. The primary's own `aim-ka` keeps running throughout and the TCP stays open afterwards.
3. Each landed file is registered in `sessions.json` with `index_status: "pending"` and queued on `aim_pull_indexer`. The HTTP response returns once the bytes are on disk; parsing never holds the device.
4. **Fallback:** if the primary fails, the hub closes it and the route retries the remaining files with `download_aim_session` (fresh TCP per file: handshake → file request → two 84 B info frames → ack `0` → data), with `AimKeepalive` running for that loop.

Batch acks: the device sends 982,320 B (30 × 32,744 B blocks) then waits. The client acks the **exact** boundary (`982320`, `1964640`, …); each ack queues the next batch *starting at that offset*, so a mid-batch ack makes the device replay. Short pauses (~1.5–3 s) are WiFi TCP retransmits and are waited out; only 8 s of silence triggers a resume ack at the contiguous prefix. Live streaming uses zero-byte micro-ACKs only in the poll loop above.

Expected throughput on the UConn EVO5: ~210 KB/s (≈15 s for a 3 MB file).

Regression: `pytest tests/test_aim_download.py tests/test_aim_primary_download.py tests/test_aim_pull_sequence.py tests/test_aim_pull_indexer.py`. Capture replays (A116, RS3_PULL_241/242, QS_Pull_241/242) run when the pcaps are in `QUICKSCOPE_AIM_CAPTURES`, the repo root, or `~/Downloads`; no tshark needed (`scripts/aim_pcapng.py`).

## Debug logs

| Log directory | When |
|---------------|------|
| `backend/data/logs/aim_live/` | Live connect, handshake, poll (`sessions/*_live.jsonl`) |
| `backend/data/logs/aim_download/` | Per-pull download traces |
| API | `GET /api/aim/download/trace` and `/api/aim/download/trace/{name}` |

Compare JSONL event order to the matching phase in committed fixtures under `docs/protocol/captures/fixtures/` when live connect fails but pull works (different post-hello paths).

## macOS: discovery appears dead

Symptom: logs repeat `no reply from ['10.0.0.1', ...]` with no other errors.

1. **Local Network permission** — System Settings → Privacy & Security → Local Network. Enable Terminal/iTerm, Python, Chrome (dev), or **QuickScope** (packaged app). If a toggle is on but traffic still fails after a venv move, reset with `tccutil reset LocalNetwork` and re-grant.
2. **Wrong unicast guess** — Discovery probes a short list of common hotspot IPs before broadcast. Check `ipconfig getifaddr` and default gateway on the AiM WiFi; set **AiM Device IP** in Settings if the gateway is not in the built-in list.

## Validated behavior

Multi-minute pulls (e.g. `a_0141`) match Race Studio exports on core EV channels when compared sample-for-sample. Device-reported session dates are preferred over embedded XRK metadata when indexing pulled sessions.
