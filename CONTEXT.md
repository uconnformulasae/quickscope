# quickscope — CONTEXT
**Path:** `C:\Users\jesse\OneDrive - University of Connecticut\Documents\quickscope` (Windows). Also checked out at `/Users/mdabek/dev/Formula/software/quickscope` on a teammate's Mac.

**One-liner:** Local-only, single-user desktop telemetry analyzer for AiM `.xrk`/`.xrz` data logger files. Python/FastAPI backend (AiM DLL or libxrk parser) + React/Vite/Canvas frontend, packaged with Electron. Can pull sessions from, and stream live data off, an AiM EVO5 over WiFi.

**Status (2026-11-14):** branch `Dev`, up to date with `origin/Dev`. Last commit `2cd0579d` "Merge pull request #27 from uconnformulasae/refactor/26-codebase-sweep" (audit fixes, GPS marker pane, formula-engine precedence fix, Windows test fixes). Only untracked file is `audit.md`. Packaging works (Electron + PyInstaller, GitHub Actions release workflow).

## Start here
1. `AGENT.md` — the authoritative agent-facing guide: architecture, data flow, backend API table, frontend state/canvas-chart patterns, live view, common-task recipes. Read this first.
2. `README.md` — user-facing overview, install/run instructions, project structure.
3. `docs/protocol/aim-live-protocol.md` — entry point to the reverse-engineered AiM WiFi live-data protocol; links to the deep-dive and research docs. `docs/aim-device.md` covers the device side.
4. `backend/main.py` + `backend/routes/` — FastAPI app and route modules.
5. `client/src/components/TelemetryChart.tsx` + `client/src/lib/chart-draw.ts` — the custom Canvas chart engine, the most complex frontend code.
6. `docs/PACKAGING.md` / `docs/CI.md` — Electron packaging, signing and CI if touching build or distribution.

## Folder map
| Path | What's in it | When to look there |
|---|---|---|
| `backend/main.py`, `backend/entry.py`, `backend/state.py`, `backend/config.py` | FastAPI app, frozen-app entry point, in-memory session state, data-dir config | Adding/changing REST endpoints, startup |
| `backend/routes/` | `sessions.py`, `analysis.py`, `live.py` (incl. live WebSocket), `live_layouts.py`, `settings.py` | Same as above |
| `backend/parsers/` | `aim_dll.py` (AiM MatLabXRK DLL, Windows), libxrk path + `libxrk_fixup.py` (GPS timecode rebasing), `log_adapter.py`, `parse_gate.py` | XRK parsing, parser selection |
| `backend/services/` | `session_store.py` (JSON session index), `settings_store.py`, `aim_connector.py` / `aim_live.py` / `aim_discovery.py` / `aim_keepalive.py` / `aim_primary_hub.py` / `aim_pull_*` (AiM WiFi client, pulls and live stream), `lap_detection.py`, `gps_preview.py`, `csv_export.py`, `derived_eval.py`, `session_cache.py`, `live_layout_store.py`, `live_channel_cache.py` | Business logic |
| `backend/origins.py`, `backend/sanitize.py` | Local-only Host/Origin middleware; input validation | Security, request validation |
| `backend/data/` (gitignored) | `sessions.json`, `sessions/` (file cache), `settings.json`, `live_layouts.json`, `cache/`, `logs/` | Runtime storage in dev, not source |
| `client/src/App.tsx` | Root component, view routing | Wiring in new views |
| `client/src/lib/` | `api.ts`, `useXRKStore.ts` (single `useState` store), `cursorStore.ts`, `chart-draw.ts` / `chart-export.ts` / `chart-cursors.ts`, `formula-engine.ts`, `units.ts`, `binary-search.ts`, `xrk-parser.ts` (types only), plus `*.test.ts` | Frontend state/data flow |
| `client/src/components/` | `TelemetryChart.tsx`, `AnalysisPanel.tsx`, `ChannelSidebar.tsx`, `SessionBrowser.tsx`, `LiveView.tsx`, `TableView.tsx`, `GPSMapView.tsx`, dialogs (`Modal.tsx`, `ExportDialog.tsx`, `ImageExportDialog.tsx`, `DerivedChannelDialog.tsx`, `SettingsDialog.tsx`), subfolders `analysis/` (tabs), `live/` (dashboard, layouts, widgets), `settings/`, `formula/`, `ui/` (shadcn) | UI features |
| `electron/` | `main.cjs` (spawns backend, picks free port, serves UI from `app://quickscope`), `preload.cjs` (exposes `window.__QUICKSCOPE_BACKEND__`), `window-size.cjs` | Desktop shell behavior |
| `scripts/afterPack.cjs` | Ad-hoc macOS code signing for unsigned builds | Mac "damaged app" issues |
| `tests/` | pytest suite (API, parsers, AiM protocol against `fake_aim_device.py`, live WS, stores, sanitization) + `fixtures/` | Backend changes |
| `docs/protocol/` | Reverse-engineered AiM EVO5 WiFi protocol docs; `captures/` holds raw `.pcapng` and analysis scripts | Anything touching the AiM wire format |
| `docs/superpowers/plans/`, `docs/superpowers/specs/` | Dated (`YYYY-MM-DD-name.md`) plans and design specs | Checking whether a feature was planned/shipped |
| `docs/race-studio-3-comparison.md`, `docs/archive/` | Feature comparison with AiM Race Studio 3; retired docs | Background |
| `.github/` | CI and release workflows, `actions/desktop-build` | CI or release pipeline changes |
| `server/`, `shared/` | Empty leftovers from the removed Express server | Ignore; safe to delete |
| **IGNORE** | `node_modules/`, `.venv/`, `dist/`, `build/`, `release/`, `backend/dist/`, `__pycache__/`, `.git/` | Build artifacts / dependencies |

## Key facts
- **Stack:** Python FastAPI backend (port 8000) + React 18/TypeScript/Vite 7/Tailwind frontend (port 5173), custom Canvas2D chart, no charting library. Electron 44 wraps both for desktop (PyInstaller-frozen backend + Vite bundle).
- **Parsing:** on Windows dev machines the AiM `MatLabXRK` DLL (`backend/vendor/`, not committed) is primary, with libxrk as fallback; Mac/Linux use libxrk. **Installers ship libxrk only.** Override with `./start.ps1 -Libxrk` / `-Dll`, `./start.sh --libxrk` / `--dll`, or `QUICKSCOPE_PARSER=libxrk|aim_dll`. libxrk returns `dict[str, pyarrow.Table]` (`timecodes` int64 ms + value column); laps are a PyArrow table (`num`, `start_time`, `end_time`).
- **GPS timebase:** libxrk's wall-clock GPS timecodes are rebased to session time once at parse time (`parsers/libxrk_fixup.py`); `/api/gps` and GPS lap detection use them as-is.
- **Session storage:** local-only, JSON-backed under `QUICKSCOPE_DATA_DIR` (dev: `backend/data/`; packaged: the Electron userData `data/` folder). One active parsed session in memory; endpoints take `session_id` so each window reads its own session. No DB, no auth, no multi-user.
- **No cloud sync anymore:** the Railway / Data-Development sync was removed. `session_store.py` migrates old `source: "railway"` entries, and `settings_store.py` drops the old `railway_url` key. Settings are now just `aim_wifi_ssid`, `aim_device_ip` and `aim_device_port`.
- **Local only:** `origins.LocalOnlyMiddleware` rejects requests whose `Host` isn't this machine or whose `Origin` isn't the local UI (`app://quickscope` or localhost). `Origin: null` is deliberately not trusted. `QUICKSCOPE_ALLOWED_HOSTS` opens it to other machines.
- **AiM WiFi protocol:** see `docs/protocol/` (outer-frame trailer = `sum(payload) & 0xFFFF`; UDP discovery on port 36002, live TCP on port 2000, device IP `10.0.0.1`). Pulled files whose name matches a local file of a different size are saved with a `_2`, `_3` ... suffix, never replacing the local session.
- **Live view:** always rendered, connected or not. Layouts are data (`live/layout-schema.ts`), with built-in EV/IC layouts, user layouts in `live_layouts.json`, and export/import as `*.qslayout.json`. Details in AGENT.md.
- **Derived channels:** client-side recursive-descent formula engine (`formula-engine.ts`); unary minus binds looser than `^` (`-x^2 = -(x^2)`). Recomputed from scratch each time.
- **Resizable sidebars:** `components/ResizeHandle.tsx` + `lib/useSidebarWidths.ts` (localStorage), deliberately outside React state so dragging doesn't re-render. Left 140–480 px, right 220–640 px, chart area never below 320 px.
- **Save image:** `lib/chart-export.ts` re-renders the visible window to an offscreen 1600 px-wide canvas with header/footer; kept separate from the on-screen `chart-draw.ts` on purpose.
- **Style:** dark theme default (a light theme / `ThemeToggle` also exists), `#4361ee`/`#f77f00` accents, JetBrains Mono for data, DM Sans for UI, lucide-react icons only.

## How to run / test
```bash
./start.sh            # macOS/Linux: installs deps if needed, starts both servers
./start.ps1           # Windows equivalent
# open http://localhost:5173
```
Manual:
```bash
cd backend && pip install -r requirements.txt && python -m uvicorn main:app --port 8000 --reload
npm install && npm run dev        # separate terminal
```
Tests and checks:
```bash
npm test               # pytest, excluding DLL- and libxrk-marked tests
npm run test:dll       # tests needing the AiM DLL (Windows)
npm run test:libxrk    # tests needing libxrk
npm run test:client    # vitest frontend tests
npm run check          # tsc
```
Packaging: `npm run electron:dev`, `npm run backend:freeze`, `npm run dist` / `dist:mac` / `dist:win` / `dist:linux` (see `docs/PACKAGING.md`).

To register a local `.xrk` without the GUI: copy it into `backend/data/sessions/` and call `session_store.add_session(...)` from `backend/` the way the upload route does.

## Desktop shell: Electron vs Tauri vs Rust (evaluated 2026-11-12, no decision)
- **Electron footprint is small:** ~400 lines across `electron/*.cjs`. The UI talks to the backend only over HTTP/WebSocket and never uses Node or Electron APIs, so swapping shells is cheap on the frontend side.
- **Tauri shell, keeping Python:** saves roughly 80–100 MB (installers would drop from ~220 MB to ~120–150 MB, because the PyInstaller backend dominates). Costs: the shell gets rewritten in Rust; the UI runs on a different browser engine per OS (WKWebView on macOS, WebKitGTK on Linux, WebView2 on Windows), so the Canvas chart, touch, Leaflet and react-grid-layout need re-testing; `origins.py` must trust `tauri://localhost` / `http(s)://tauri.localhost`; and the PyInstaller one-folder build doesn't fit Tauri's single-binary sidecar model without changes.
- **All-Rust backend:** libxrk is not a blocker. Its repo (`m3rlin45/libxrk`) has a pure-Rust core crate (`crates/libxrk`; not on crates.io, so it would be a pinned git dependency), and upstream is moving to Rust only. The AiM DLL works through the `xdrk` crate or direct loading. The backend to port is ~7,800 lines of Python: AiM socket code (~3,800, standard-library sockets/struct only), routes (~1,200), and pandas/numpy analysis (lap detection, CSV export, GPS preview). The payoff would be ~10–30 MB installers, no sidecar/port/origin handling, and no PyInstaller. Check libxrk's license against QuickScope's MIT before adopting it.
- **If revisited:** the lowest-risk order is Tauri shell first, then a Rust (axum) server that forwards unported routes to Python, porting the parsing/analysis routes before the AiM device code, and removing Python last.

## Gotchas
- `TimeRange` and `ChannelSample` timestamps are milliseconds; the chart converts to seconds only for display.
- Canvas chart performance rules: never call `setState` from mouse/touch handlers in `TelemetryChart.tsx`; mutate refs and set `needsDrawRef.current = true`. Values a child needs during mouse moves go through `cursorStore`.
- Channel indices are reused between sessions: async work must check `isCurrentSession()` after every `await` (see AGENT.md "Session changes").
- `sessions.json` `local_path` values may be stale absolute paths from another OS; `session_store.resolve_session_path` handles this and rewrites the index, so go through it rather than reading `local_path` directly.
- AiM file dates are US month/day; `state.parse_recorded_at` is month-first by default and is only day-first for device timestamps (`day_first=True`). Don't flip the default.
- CAN-decoded `Torque_Feedback` and `LVCU_Torque_Req` wrap to ~6553 (uint16/10) when negative (regen); use `Torque_Command`, `MCU_DC_Current` or `Pack_Current` for regen sign. `Motor_Temp` is ×10 (275 = 27.5 °C).
- `docs/protocol/captures/parse_aim_stream.py` mislabels client/device frames for the Live 2 captures; `analysis/lib_frames.py` has the corrected logic.
- Most features have no plan/spec doc in `docs/superpowers/`; check `git log` before assuming something wasn't built.
- This folder has lived at several paths and on two OSes; double-check hardcoded absolute paths in scripts or config.

## Local install (teammate's Mac, 2026-09-11)
- `~/Applications/QuickScope.app` is a local unsigned arm64 build (`npm run build`, `backend/.venv/bin/pyinstaller quickscope-backend.spec`, `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir`). Data dir: `~/Library/Application Support/quickscope/`, separate from the dev `backend/data/`.
- Rebuild and re-copy with `ditto release/mac-arm64/QuickScope.app ~/Applications/QuickScope.app` after pulling changes.
