# quickscope — CONTEXT
**Path:** /Users/mdabek/dev/Formula/software/quickscope

**One-liner:** Local-only, single-user desktop telemetry analyzer for AiM `.xrk`/`.xrz` data logger files — Python/FastAPI backend (libxrk parser) + React/Vite/Canvas frontend, packaged with Electron; syncs sessions to the team's Data-Development cloud backend and can pull sessions live over WiFi from an AiM EVO5 device.

**Status:** branch `main`, up to date with `origin/main`. Last commit `0c9c48b` "Merge pull request #7 from uconnformulasae/claude/big-cleanup-sweep" (merges live-data-streaming and LiveView dashboard work). Uncommitted: modified `docs/protocol/captures/analysis/q2_short_payloads.py` and `q7_kkk.py`, plus an untracked `screenshots/` dir — all research/scratch artifacts, not app code. Packaging is functional (Electron + PyInstaller, GitHub Actions release workflow) but this looks like active/recent work (moved folders 3 times, most recent commits are about LiveView and the AiM protocol spec, dated Apr 2026).

## Start here
1. `AGENT.md` — the authoritative agent-facing guide: architecture, data flow, backend API table, frontend state/canvas-chart patterns, common-task recipes. Read this first, it is comprehensive and current.
2. `README.md` — user-facing overview, install/run instructions, project structure listing.
3. `docs/protocol/aim-live-protocol.md` — entry point to the reverse-engineered AiM WiFi live-data protocol; links to the deep-dive and research docs.
4. `backend/main.py` — FastAPI app; confirms/extends the endpoint table in AGENT.md.
5. `client/src/components/TelemetryChart.tsx` — the custom Canvas chart engine, the most complex/load-bearing frontend file.
6. `docs/PACKAGING.md` — release/signing/Electron packaging workflow if touching build or distribution.

## Folder map
| Path | What's in it | When to look there |
|---|---|---|
| `backend/main.py`, `backend/entry.py`, `backend/state.py` | FastAPI app entry, in-memory session state | Adding/changing REST endpoints |
| `backend/routes/` | Route modules mounted on the FastAPI app | Same as above |
| `backend/services/` | `session_store.py` (local JSON session index), `settings_store.py`, `railway_client.py` + `sync_service.py` (Data-Development sync), `aim_connector.py` + `aim_live.py` (AiM WiFi protocol client), `gps_preview.py`, `lap_detection.py`, `upload_log.py` | Business logic for sync, AiM device comms, laps, GPS |
| `backend/data/` (gitignored) | `sessions.json`, `sessions/` (raw file cache), `settings.json` | Runtime local storage, not source |
| `client/src/App.tsx` | Root component, view routing | Wiring new views/components in |
| `client/src/lib/` | `api.ts` (HTTP client), `useXRKStore.ts` (single `useState` global store), `xrk-parser.ts` (types/helpers only, no parsing), `formula-engine.ts` (derived-channel expression evaluator) | Frontend state/data-flow changes |
| `client/src/components/` | `TelemetryChart.tsx` (canvas engine), `AnalysisPanel.tsx` (Stats/Laps/Histogram/XY/GPS tabs), `ChannelSidebar.tsx`, `SessionBrowser.tsx`, `LiveView.tsx` (live AiM dashboard), `AimSessionPicker.tsx`, `SettingsDialog.tsx`, `GPSMapView.tsx`/`GPSThumbnail.tsx`, `TableView.tsx`, `SessionHeader.tsx`, `SessionInfoModal.tsx`, `DerivedChannelDialog.tsx`, `ExportDialog.tsx` | UI features |
| `client/src/components/ui/` | ~40 shadcn/ui components | Mostly unused scaffolding, harmless — per AGENT.md |
| `shared/schema.ts` | Shared TS types between server/client | Cross-cutting type changes |
| `server/` | Vestigial Express server (`index.ts`, `routes.ts`, `static.ts`, `vite.ts`) — only serves the Vite dev build | AGENT.md explicitly calls this vestigial; all real API logic is the Python backend |
| `electron/` | `main.cjs` (spawns backend, picks free port, loads BrowserWindow), `preload.cjs` (exposes `window.__QUICKSCOPE_BACKEND__`) | Desktop packaging / Electron shell behavior |
| `docs/protocol/` | `aim-live-protocol.md`, `aim-live-protocol-deep-dive.md`, `aim-protocol-research.md` — reverse-engineered AiM EVO5 WiFi wire protocol (see Key facts) | Anything involving the AiM live-device connection or wire format |
| `docs/protocol/captures/` | Raw `.pcapng` captures (`live1`, `live2`), parsed/chrono TCP dumps, `extract_*.py`, `parse_aim_stream.py`/`parse_chronological.py` | Re-deriving or re-validating protocol claims from raw packet data |
| `docs/protocol/captures/analysis/` | `lib_frames.py` (reusable frame parser, fixes a Node-direction bug in `parse_aim_stream.py`) + `q1`..`q7` scripts, each answering one empirical question (CRC/trailer, STNC structure, channel defs, kkk heartbeat, etc.) | Understanding *how* a specific protocol claim was verified |
| `docs/superpowers/plans/`, `docs/superpowers/specs/` | Dated (`YYYY-MM-DD-name.md`) implementation plans and design specs for past features (overlay mode, light mode, table view/header redesign, Data-Development integration) | Checking whether a feature was planned/shipped before re-designing it; `git log --grep` on the title is often faster than reading the doc |
| `docs/PACKAGING.md` | Electron + PyInstaller release/signing workflow | Build/release/distribution work |
| `.github/` | CI/release workflow (GitHub Actions, macOS/Windows build steps with `timeout-minutes`, notarization) | CI or release pipeline changes |
| `screenshots/` | Untracked, likely for docs/PR use | Low priority, not part of app |
| **IGNORE** | `node_modules/`, `.venv/`, `dist/`, `build/`, `backend/__pycache__`, `docs/protocol/captures/__pycache__`, `docs/protocol/captures/analysis/__pycache__`, `.git/` | Build artifacts / dependencies, never source of truth |

## Key facts
- **Stack:** Python FastAPI backend (port 8000) + React 18/TypeScript/Vite/Tailwind frontend (port 5000), no charting library — custom Canvas2D engine. Electron wraps both for desktop distribution (PyInstaller-frozen backend + Vite bundle in a BrowserWindow).
- **File formats:** `.xrk` / `.xrz` AiM data-logger files, parsed via the `libxrk` PyPI package (Cython, wraps a fully reverse-engineered format per `docs/protocol/aim-protocol-research.md`). `libxrk` returns `dict[str, pyarrow.Table]` (columns `timecodes` int64 ms + value column); laps come back as a PyArrow table (`num`, `start_time`, `end_time`). GPS timecodes are in a different (raw UTC) timebase than regular channels — the `/api/gps` endpoint offsets by subtracting `min(timestamps)`.
- **Session storage:** local-only, JSON-backed — `./data/sessions.json` (index) + `./data/sessions/` (raw file cache) + `./data/settings.json` (Railway URL, AiM WiFi SSID/IP). Backend holds exactly one parsed session in memory at a time; no DB, no auth, no multi-user.
- **Sync with Data-Development:** `backend/services/railway_client.py` + `sync_service.py` sync sessions bidirectionally to the sibling `Data-Development` repo's Railway-deployed backend (multi-user/cloud counterpart; see Related section). Current default Railway URL in `backend/data/settings.json` points at `grateful-nourishment-production-ef50.up.railway.app`.
- **AiM WiFi protocol findings:** live in `docs/protocol/` — start at `aim-live-protocol.md`, drill into `aim-live-protocol-deep-dive.md` for byte-level decoding (outer-frame trailer = `sum(payload) & 0xFFFF`, confirmed on 2318/2318 frames; 547-byte live-frame channel map; `iSLV/iHW/iUSR/iPTH/iLCK/iSST/iLTS/iPRL` inner commands), and `aim-protocol-research.md` for cross-referencing against `libxrk`'s independently reverse-engineered XRK file format (same outer framing shared between stored files and the live wire protocol). Raw evidence (pcapng captures + per-question analysis scripts) is under `docs/protocol/captures/`. Network layout: UDP discovery on port 36002 (`aim-ka` probe), live TCP data on port 2000, device IP `10.0.0.1`, client polls ~250ms, device replies in batches of 4 frames.
- **Derived channels:** client-side recursive-descent formula engine (`formula-engine.ts`) — `+ - * / ^`, functions `abs/sqrt/sin/cos/diff/smooth/delay`, channel names as variables, cross-channel interpolation. Recomputed from scratch each time (no incremental updates).
- **Style:** dark theme only (`#0d0e14` bg, `#4361ee`/`#f77f00` accents), JetBrains Mono for data, DM Sans for UI, lucide-react icons only.

## How to run / test
From README.md / AGENT.md (copied verbatim):
```bash
./start.sh          # installs deps if needed, starts both servers; open http://localhost:5000
```
Manual:
```bash
# Backend
cd backend
pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
npm install
npm run dev
```
Other npm scripts (from `package.json`): `npm run build` (Vite build), `npm run check` (`tsc`), `npm run electron:dev`, `npm run backend:freeze` (PyInstaller), `npm run dist` / `dist:mac` / `dist:win` / `dist:linux` (full packaged installer — see `docs/PACKAGING.md`). No test script is defined in `package.json`.


From the Formula root there is also `.claude/launch.json` (config `quickscope`) that runs `start.sh`; the frontend actually serves on **5173** (`PORT` env, `server/index.ts`), not the 5000 that `start.sh` prints.
To register a local `.xrk` without the GUI: copy it into `backend/data/sessions/` and call `session_store.add_session(...)` from `backend/` the way `routes/analysis.py` `upload_file` does (done 2026-09-08 for the two 2026-09-07 regen mock-endurance runs 0140/0141 from `data/telemetry/2026-09-07-regen-mock-endurance-ct17ev/`).

## Related elsewhere in Formula
- `software/Data-Development` — the cloud/multi-user backend this project syncs sessions to (Railway-deployed FastAPI, own AiM connector, channel models, PID-tuning services). When the user says "the server," "Railway," or asks about multi-user/persistent/cloud features, that's almost always Data-Development, not QuickScope — check there first.
- `studies/pid-tuning` — likely consumes similar channel/telemetry concepts; check for overlap if working on analysis features.
- No other sibling folder appears to touch the AiM WiFi protocol work directly — it is QuickScope-specific reverse-engineering.

## Gotchas
- The `server/` (Express/TypeScript) directory looks like a real backend but is vestigial — it only serves the Vite dev build in dev mode. All real API logic lives in the Python `backend/`.
- `TimeRange` and `ChannelSample` timestamps are milliseconds; the chart converts to seconds only for display — don't mix units when touching `TelemetryChart.tsx` or `useXRKStore.ts`.
- Canvas chart perf rules are strict: never call `setState` from mouse/touch handlers in `TelemetryChart.tsx` — only mutate refs and set `needsDrawRef.current = true`; `onViewRangeChange` is debounced at 100ms.
- GPS timecodes from libxrk use a different timebase than other channels (raw UTC vs session-relative) — already handled in the `/api/gps` endpoint, but easy to reintroduce a bug if touching GPS code elsewhere.
- `parse_aim_stream.py` under `docs/protocol/captures/` has a known Node-direction bug for Live 2 captures (mislabels client/device frames); `lib_frames.py` has the corrected auto-detection logic and is what all later analysis scripts (`q1`..`q7`) actually use.
- This folder has moved twice recently (`~/dev/quickscope` → `~/dev/Formula/quickscope` → `~/dev/Formula/software/quickscope`); double-check any hardcoded absolute paths in scripts, `.claude/` config, or shell history if something references an old location.
- `docs/superpowers/{plans,specs}/` only cover a handful of past features (overlay mode, light mode, table view/header redesign, Data-Development integration) — most work (e.g. the AiM live protocol, Electron packaging) has no matching plan/spec doc, so don't assume absence of a plan means the feature wasn't built; check `git log` instead.
- Uncommitted changes exist in two protocol analysis scripts (`q2_short_payloads.py`, `q7_kkk.py`) and an untracked `screenshots/` dir — verify with the user before assuming a clean working tree.
- `state.parse_recorded_at` tries `%d/%m/%Y` before `%m/%d/%Y`, but the team's AiM files carry US-format dates (`09/07/2026` = Sept 7). Any day ≤ 12 gets month/day swapped in `sessions.json` `recorded_at` (the two regen sessions were patched by hand). Fix the format order if you touch it.
- CAN-decoded `Torque_Feedback` and `LVCU_Torque_Req` wrap to ~6553 (uint16/10) when the value is negative (regen); use `Torque_Command`, `MCU_DC_Current` or `Pack_Current` for regen sign. `Motor_Temp` is ×10 (275 = 27.5 °C).

## Local install (2026-09-11)

- `~/Applications/QuickScope.app` is a local unsigned arm64 build of `main` made on 2026-09-11 (`npm run build`, `backend/.venv/bin/pyinstaller quickscope-backend.spec`, `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir`). Spotlight finds it as "QuickScope". Its data dir is `~/Library/Application Support/quickscope/`, separate from the dev backend's `backend/data/`.
- 2026-09-11 source fix (uncommitted): `backend/state.py::parse_recorded_at` now tries month/day/year first (AiM writes US dates; the old day-first order put every date with day ≤ 12 in the wrong month).
- Build products stay gitignored: `release/mac-arm64/QuickScope.app`, `backend/dist/`, `backend/.venv/` (Python 3.12 + requirements + pyinstaller). Rebuild and re-copy with `ditto release/mac-arm64/QuickScope.app ~/Applications/QuickScope.app` after pulling changes.
