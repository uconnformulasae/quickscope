# AiM wire protocol documentation

Reverse-engineered from Race Studio 3 Wireshark captures on a UConn AiM EVO5. QuickScope implements the read-only paths (discovery, live stream, session list, file download).

## Read order

| Document | Use when |
|----------|----------|
| [aim-live-protocol.md](aim-live-protocol.md) | **Main spec** — UDP/TCP framing, lifecycle, live snapshot layout |
| [captures/SOURCE_CAPTURES.md](captures/SOURCE_CAPTURES.md) | **Ground truth** — which pcaps and tcp streams to diff against |
| [aim-live-protocol-deep-dive.md](aim-live-protocol-deep-dive.md) | Byte-level proofs, channel map, analysis scripts |
| [aim-protocol-research.md](aim-protocol-research.md) | Prior art (`libxrk`, DLL, forums) and XRK ↔ wire framing link |

Committed **text fixtures** (`captures/fixtures/*.txt`) are tshark TCP-follow exports for tests. Re-export when logger channel config or RS3 version changes — see [captures/fixtures/README.md](captures/fixtures/README.md).

## QuickScope code map

| Protocol area | Implementation |
|---------------|----------------|
| UDP discovery + `aim-ka` | `backend/services/aim_discovery.py`, `aim_keepalive.py` |
| Primary TCP, hub lock | `backend/services/aim_primary_hub.py` |
| Hello, enumeration, live poll, decode | `backend/services/aim_live.py`, `aim_live_layout.py` |
| Session list + download TCP | `backend/services/aim_connector.py` |
| Live WebSocket API | `backend/routes/live.py` |

## Before merging protocol changes

1. Diff STNC/STCP ordering against the capture named in [SOURCE_CAPTURES.md](captures/SOURCE_CAPTURES.md) for your scenario (live vs connect vs download).
2. Run `pytest tests/test_aim_live.py` and `pytest tests/test_aim_download.py`.
3. Optional regression between pcaps: `python scripts/compare_live_pcaps.py <quickscope.pcapng> <rs3_reference.pcapng>` — expect zero bad micro cycles and no device RST.
4. Update fixtures and note the source pcap in the commit message.

## Capture tooling in this repo

| Path | Purpose |
|------|---------|
| `captures/parse_aim_stream.py` | Parse follow-raw dumps into frames |
| `captures/parse_chronological.py` | Merge client/server timeline |
| `captures/analysis/` | One-off decode scripts referenced from the deep-dive |
| `captures/live1.pcapng`, `live2.pcapng` | Older in-repo RS3 captures (2026-04-23); newer reference pcaps: filenames in [captures/SOURCE_CAPTURES.md](captures/SOURCE_CAPTURES.md) (`QUICKSCOPE_AIM_CAPTURES`) |
