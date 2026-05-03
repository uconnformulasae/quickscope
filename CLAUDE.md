# QuickScope — CLAUDE.md

Working reference for developing QuickScope. Keep current when the system's shape changes.
`AGENT.md` is older; this file supersedes it.

---

## 1. What QuickScope is

Desktop racing-telemetry tool for AiM data loggers, built **for UConn Formula SAE Electric**
(CT-17 EV car, AiM EVO5). Distributed as signed Electron installers (.dmg / .exe / optional
.AppImage) via GitHub Releases.

Parses AiM `.xrk` / `.xrz` (Cython `libxrk`); renders multi-channel telemetry on a custom
Canvas2D chart (zoom, pan, delta cursors); computes **derived channels** via formulas
(`Spd1 * 0.621371`) or sandboxed Python; shows stats, lap analysis, histograms, XY plots,
Leaflet GPS map; pulls sessions over WiFi from an AiM EVO5 (UDP discovery + TCP);
**streams live telemetry** over a WebSocket; **syncs sessions bidirectionally** with the
[Data-Development](https://github.com/uconnformulasae/Data-Development) Railway backend;
exports CSV (interpolated to a common timebase).

**Single-user desktop app.** Backend keeps one parsed XRK in memory at a time. No auth.

---

## 2. High-level architecture

```
Electron main (main.cjs)
  ├─ spawns: PyInstaller-frozen Python backend (FastAPI, 127.0.0.1:<random>)
  │            ├─ libxrk parser
  │            └─ httpx → Railway,  asyncio → AiM device
  └─ loads: React SPA from dist/public (file://)
              └─ preload injects window.__QUICKSCOPE_BACKEND__ → api.ts uses it

Backend talks to:
  - Data-Development Railway backend (REST, shared session library)
  - AiM EVO5 device on LAN (UDP :36002 discover, TCP :2000 sessions + live)
```

**Dev mode** swaps: Python on `:8000`; React on Vite dev server (Express+HMR on `:5000`);
open `http://localhost:5000` in a browser instead of Electron.

The **Express server in `server/`** is intentionally vestigial: dev-only HMR host. Production
doesn't use it. Don't add API routes there — all backend logic lives in Python.

---

## 3. Repository layout

```
backend/                        ← Python FastAPI + libxrk
  main.py                       App composition, CORS, router includes
  state.py                      SessionState singleton + parse/extract/interpolate utils
  entry.py                      PyInstaller frozen-app entrypoint
  quickscope-backend.spec       PyInstaller spec (collects libxrk/pandas/pyarrow whole)
  requirements.txt
  routes/                       FastAPI routers, mounted under /api
    sessions.py                 Session CRUD, sync, AiM pull
    analysis.py                 Upload, channels, data, laps, GPS, export, derived
    settings.py                 GET/PUT /api/settings
    live.py                     /api/live/status + /api/live/ws WebSocket
  services/                     Routing-agnostic business logic
    session_store.py            JSON-backed session index (thread-safe, atomic rewrites)
    session_cache.py            LRU cache of parsed aim_xrk logs (cap=4) backing SessionState
    settings_store.py           settings.json persistence
    railway_client.py           async httpx client for Data-Development
    sync_service.py             Bidirectional Railway sync (pull then push)
    aim_connector.py            AiM TCP/UDP for session list & download
    aim_live.py                 AiM live-streaming TCP client (asyncio)
    lap_detection.py            3-tier: device → GPS → beacon
    gps_preview.py              Cached downsampled GPS thumbnails
    upload_log.py               In-memory ring buffer for upload diagnostics
  data/                         Runtime data (gitignored): sessions.json, settings.json, sessions/

client/                         ← React + TypeScript + Vite
  index.html
  src/
    main.tsx                    Boots React, applies saved theme class
    App.tsx                     Root: routes between SessionBrowser/Analysis/Live
    index.css                   Tailwind + design tokens (CSS vars)
    lib/
      api.ts                    HTTP + WebSocket client
      useXRKStore.ts            Single useState<AppState> + derived-channel CRUD
      useTheme.ts               Dark/light toggle persisted to localStorage
      xrk-parser.ts             Type definitions + helpers (NOT a parser, despite the name)
      formula-engine.ts         Recursive-descent parser + evaluator for derived formulas
      chart-utils.ts            Layout math, color resolution, downsampling
      chart-draw.ts             Canvas drawing primitives
      chart-cursors.ts          Cursor + delta rendering
      table-data.ts             Build aligned-row table from samples Maps
    components/
      TelemetryChart.tsx        Custom Canvas2D chart engine
      LiveView.tsx              Real-time WebSocket dashboard
      SessionBrowser.tsx        Entry view: session list, sync, upload
      DerivedChannelDialog.tsx  Formula/Python editor with mini preview
      ChannelSidebar.tsx        Left panel: channel list + chart-mode toggle
      AimSessionPicker.tsx      Modal to pick & download from device
      SettingsDialog.tsx        Railway URL + AiM SSID/IP/port
      AnalysisPanel.tsx         Tab container
      analysis/                 StatsTab, LapAnalysisTab, HistogramTab, XYPlotTab + helpers
      ui/                       shadcn/ui (~40 components, mostly unused)
      (also: ExportDialog, GPSMapView, SessionInfoModal, SessionHeader, TableView,
       GPSThumbnail, ThemeToggle, QuickScopeLogo)

electron/
  main.cjs                      Spawns backend, creates window, handles lifecycle
  preload.cjs                   Exposes window.__QUICKSCOPE_BACKEND__ via contextBridge

server/                         ← Vestigial Express (dev HMR only — DO NOT add routes here)
shared/schema.ts                ← Empty stub. All types live in client/src/lib/api.ts
docs/PACKAGING.md               Release/signing/notarization workflow
docs/protocol/                  Reverse-engineered AiM EVO5 WiFi protocol spec + captures
build/                          electron-builder resources (icons, entitlements.mac.plist)
.github/workflows/              release.yml + smoke.yml
start.sh / start.ps1            Local dev launcher (creates venv, starts both servers)
```

Path aliases: `@/*` → `client/src/*`, `@shared/*` → `shared/*`.

---

## 4. Process topology

**Dev**: `./start.sh` runs `uvicorn main:app --host 0.0.0.0 --port 8000` and `npm run dev`
(Express+Vite HMR on `:5000`). Browser at `localhost:5000` calls `localhost:8000/api/...`.
Backend binds `0.0.0.0` so phones on LAN can hit it; `api.ts` resolves `API_BASE` to
`http://${window.location.hostname}:8000`. `start.sh` picks the highest available
`python3.{12,11,10}` (libxrk needs ≥ 3.10). Ctrl+C kills both.

**Production (Electron)**: `electron/main.cjs` finds a free port (bind `127.0.0.1:0`), spawns
the PyInstaller binary with env `QUICKSCOPE_HOST=127.0.0.1`, `QUICKSCOPE_PORT=<random>`,
`QUICKSCOPE_DATA_DIR=<userData>/data`; pipes stdout/stderr to `<userData>/backend.log`;
waits up to 30 s for `/docs` before opening the window. Preload injects
`window.__QUICKSCOPE_BACKEND__` = `http://127.0.0.1:<port>`. On `before-quit`: Windows
`taskkill /pid /f /t`; macOS/Linux `SIGTERM` then `SIGKILL` after 3 s.

**User data**: macOS `~/Library/Application Support/QuickScope/data/`; Windows
`%APPDATA%\QuickScope\data\`; Linux `~/.config/QuickScope/data/`. Contains
`sessions.json`, `settings.json`, `sessions/<filename>.xrk`, plus `backend.log` in parent.

---

## 5. Backend (Python)

### 5.1 App composition (`main.py`)

Tiny: builds FastAPI app, attaches CORS (`allow_origins=["*"]` — fine for localhost
desktop), includes the four routers, registers a startup hook
`_recover_stale_sync_state()` that resets sessions stuck in `uploading`/`downloading` after
a crashed previous run.

No auth, rate limiting, or request validation beyond FastAPI's type-hint generation. That's
intentional for the desktop use case — anything exposing the backend over a network needs
to be reconsidered.

### 5.2 Session state (`state.py` + `services/session_cache.py`)

`SessionState` is a thin facade over `session_cache: SessionCache`. The cache holds up to
**4 parsed `aim_xrk` logs** keyed by session id with MRU promotion on access; `state.log`,
`state.filename`, `state.session_id` all read/write via the cache's "active" entry.

```python
class SessionState:
    @property
    def log(self) -> aim_xrk | None: ...      # → session_cache.active_log
    @property
    def filename(self) -> str | None: ...     # → session_cache.active_filename
    @property
    def session_id(self) -> str | None: ...   # → session_cache.active_id

state = SessionState()  # module-level facade
```

`POST /api/sessions/{id}/load` warms the cache and promotes the entry to active without
re-parsing on re-clicks. Existing routes that read `state.log` (`/api/data`, `/channels`,
`/laps`, `/gps`, `/export`, `/derived/evaluate`) operate on the active entry. Overlay
reads use new per-id endpoints (`/api/sessions/{id}/info|channels|data|laps`) that resolve
the cache without disturbing the active id.

The upload route's "set log before session_id is known" path uses a synthetic `__pending__`
id that gets promoted to the real id when `session_id` is later set.

Utilities in `state.py`: `parse_file`, `extract_session_info`, `channel_meta`/`channel_data`,
`parse_recorded_at` (tries seven date formats), `sanitize_filename`, `interpolate`
(binary-search + linear blend, used by export and derived), `_sync_lock: asyncio.Lock` +
`background_sync()` for non-overlapping Railway sync.

**Channel duration math**: `sample_rate_hz = (n_rows - 1) / (last_tc / 1000)`. Duration
capped at 36,000,000 ms (10 h) to ignore GPS-init glitches. Non-finite values → `0.0`.

### 5.3 Routes (mounted under `/api`)

`sessions.py`:
| Method | Path | Purpose |
|---|---|---|
| GET | `/sessions` | List all local + synced session entries |
| POST | `/sessions/{id}/load` | Load into `state.log`, return SessionInfo |
| POST | `/sessions/sync` | Full Railway pull+push → `{pulled, pushed, errors}` |
| POST | `/sessions/{id}/pull` | Download remote-only session file |
| POST | `/sessions/{id}/rename` | Rename local + Railway (rolls back file on remote 502) |
| DELETE | `/sessions/{id}` | Delete from index + disk |
| GET | `/sessions/{id}/gps-preview` | 96-pt thumbnail in normalized 0..1 square |
| GET | `/sessions/{id}/setpoints` | Read custom GPS lap setpoints |
| PUT | `/sessions/{id}/setpoints` | Replace custom GPS lap setpoints (validated: lat/lon ranges, radius ∈ [5,50], max 16 pins) |
| GET | `/aim/status` | UDP probe for AiM device reachability |
| GET | `/aim/sessions` | List sessions on connected device |
| POST | `/aim/pull` | Download from device → triggers background Railway sync |

Per-session overlay reads (don't disturb the active id):
| Method | Path | Purpose |
|---|---|---|
| GET | `/sessions/{id}/info` | SessionInfo for a non-active session |
| GET | `/sessions/{id}/channels` | Channels list for a non-active session |
| GET | `/sessions/{id}/data?channels=...` | Time series for a non-active session |
| GET | `/sessions/{id}/laps` | Detected laps for a non-active session |

`analysis.py`:
| Method | Path | Purpose |
|---|---|---|
| POST | `/upload` | Multipart .xrk/.xrz; parse; cache; record diagnostic |
| GET | `/uploads/log` | Recent uploads (in-mem ring buffer, max 100) |
| GET | `/channels` | All channels: `[{shortName, units, sampleCount, color, ...}]` |
| GET | `/data?channels=A,B,C` | Time series: `{A: {timestamps, values}, ...}` |
| GET | `/laps` | Detected laps + `source: device \| gps_auto \| beacon_auto \| none` |
| GET | `/gps` | `{timestamps, lat, lon, speed} \| null` |
| GET | `/export?channels=...` | Streaming CSV interpolated to highest-rate channel's timebase |
| POST | `/derived/evaluate` | Sandboxed Python → `{timestamps, values}` |

`settings.py`: `GET /settings`, `PUT /settings` (filtered by `ALLOWED_KEYS` whitelist).

`live.py`: `GET /live/status` (UDP probe + identity); `WS /live/ws` (JSON snapshots).

### 5.4 Services (`backend/services/`)

Routes call services; services don't import from routes. Module-level state allowed
(singletons, locks) — backend is single-process.

- **`session_store.py`** — JSON-backed index at `data/sessions.json`. Thread-safe via
  `threading.Lock()`. Atomic whole-JSON rewrites (fine for desktop scale). Path-traversal
  defense in `session_file_path()` via `is_relative_to()`.
- **`settings_store.py`** — `DEFAULTS` includes the team's Railway URL and current car's
  WiFi SSID. Only `ALLOWED_KEYS` accepted on PUT.
- **`railway_client.py`** — `httpx.AsyncClient`. Five endpoints (list, get, download,
  rename, upload). Timeouts 15 s metadata / 120 s file. See §8.
- **`sync_service.py`** — `sync_with_railway()` does pull-then-push. Pull reconciles by
  `remote_id` → `filename` → `aim_session_id`. Push uploads anything `local_only` with a
  valid `local_path`. Sets transient `uploading`/`downloading` state.
- **`aim_connector.py`** — Hand-rolled binary protocol for AiM EVO5. UDP :36002 discovery;
  TCP :2000 session list + bulk download. STNC handshake uses fixed 84-byte frames
  (header 12 + payload 64 + trailer 8). Wrong-sized messages are silently dropped.
- **`aim_live.py`** — Separate asyncio TCP client. Polls in a loop alternating sub-commands
  `0x00020003` and `0x00020053` every ~125 ms. Receives 547-byte STCP frames with channel
  snapshots. Auto-responds to 4-byte STCP micro-acks. Field decoding incomplete — see
  `docs/protocol/`.
- **`lap_detection.py`** — Three-tier fallback: (1) device-marked `log.laps`; (2) GPS
  close-the-loop (Haversine; FSAE autocross constants `DEPARTURE_RADIUS_M=30`,
  `RETURN_RADIUS_M=15`, `MIN_LAP_S=10`); (3) beacon channel rising edges with
  auto-thresholding at midpoint. **Override**: when a session has `lap_setpoints`
  defined, `from_setpoints()` runs instead of the cascade — first pin is start/finish,
  remaining pins are sector splits. Lenient matching: any return to pin 1 closes a lap;
  missed sectors render as `null` / `—`. `lap_source = "gps_manual"` in this mode.
- **`gps_preview.py`** — Cached (path + mtime) 96-pt polyline in 0..1 with aspect
  correction `cos(mid_latitude)`. Drives SessionBrowser thumbnails.
- **`upload_log.py`** — `deque(maxlen=100)` of upload diagnostics. Cleared on restart.

### 5.5 Threading & async

- All FastAPI handlers async.
- Blocking work (libxrk parse, AiM TCP I/O in `aim_connector`) wrapped in
  `asyncio.to_thread(...)`.
- `aim_live.py` is fully async (`asyncio.open_connection`).
- WebSocket: server creates a background task per connection that pumps snapshots; main
  coroutine `await ws.receive_text()` so client close fires cleanup.
- Locks: `state._sync_lock` (asyncio) prevents overlapping Railway syncs;
  `session_store._lock`, `settings_store._lock`, `upload_log._lock` (threading) protect
  JSON file rewrites.
- `sessions.py` and `analysis.py` use FastAPI `BackgroundTasks` for `state.background_sync()`
  after upload or AiM pull — user sees the new session immediately.

### 5.6 Persistence — session record schema

Stored in `sessions.json`:

```python
{
  "id": "<uuid>",
  "remote_id": int | null,                 # Railway session ID (when synced)
  "aim_session_id": str,                   # filename stem
  "filename": str,
  "local_path": "<abs path>" | null,       # null if remote_only
  "track_name": str, "driver_name": str, "vehicle_name": str,
  "recorded_at": ISO-8601 | null,
  "duration_s": float, "lap_count": int,
  "lap_setpoints": [{"lat": float, "lon": float, "radius_m": float}, ...] | null,
  "sync_status": "local_only" | "remote_only" | "synced" | "uploading" | "downloading",
  "source": "manual_upload" | "aim_device" | "railway",
  "created_at": ISO-8601, "updated_at": ISO-8601,
}
```

Stale `uploading`/`downloading` reset at boot via `_recover_stale_sync_state()`.

---

## 6. Frontend (React)

### 6.1 Boot path

`client/index.html` → `main.tsx` (applies saved theme class) → `<App />` →
`useAppState()` + view router (`'browser' | 'analysis' | 'live'`).

### 6.2 State model (`useXRKStore.ts`)

A **single `useState<AppState>`** inside `useAppState()`. No Redux/Zustand/Jotai/Context
for app data. Components receive state from `App.tsx` via prop drilling; mutations go
through `useCallback` setters from the hook.

`AppState` fields (all in one `useState`): `session`, `isLoading`, `loadError`,
`parseProgress`, `fileName`, `activeChannels: ActiveChannel[]` (`{channelId, color,
visible}`), `derivedChannels: DerivedChannel[]` (`{id, name, units, mode, expression,
color}`), `viewRange: {startMs, endMs} | null`, `analysisTab` (stats/lapanalysis/histogram
/xyplot/gps), `histogramChannelId`, `xyXChannelId`, `xyYChannelId`, `cursorTime` (seconds),
`chartMode` (separate/overlay), `viewMode` (chart/table), `leftSidebarOpen`,
`rightSidebarOpen`, `channelSearch`, `showOnlyWithData`.

`derivedSamplesMap: Map<number, ChannelSample[]>` is **deliberately kept outside `AppState`**
as a separate `useState<Map>` — putting it in `AppState` would force every chart re-render
to compare a large Map.

Derived channels CRUD'd via `addDerivedChannel`, `updateDerivedChannel`,
`removeDerivedChannel`, `previewDerivedChannel`. ID generation uses a module-level counter
(`derivedIdCounter`) bumped on each add and on `clearSession()` to avoid collisions.

### 6.3 API client (`api.ts`)

`API_BASE` resolution:
```ts
const API_BASE =
  (typeof window !== 'undefined' && window.__QUICKSCOPE_BACKEND__) ||
  `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:8000`;
```
- Electron prod: preload sets `window.__QUICKSCOPE_BACKEND__` to `http://127.0.0.1:<random>`.
- Browser dev: hostname-based, so phone on LAN at `<lan-ip>:5000` reaches backend at `<lan-ip>:8000`.

Plus: `uploadFile(file, onProgress)` uses `XMLHttpRequest` (not `fetch`) for byte-level
progress events; EMA-smoothed bytes/sec and ETA in the callback.
`liveWebSocketUrl()` rewrites `http(s)://...` → `ws(s)://.../api/live/ws`.

All response types are TypeScript interfaces local to `api.ts`. There's **no shared schema**
with the backend; keep types in sync manually.

### 6.4 Type system (`xrk-parser.ts`)

Despite the name, **does not parse anything**. Defines canonical client types and helpers
(`computeStats`, `formatTime`, `formatLapTime`).

Core: `ChannelDef` (`index, shortName, longName, sampleRateRaw` (μs), `sampleRateHz, units,
color, fileSampleCount?`); `ChannelSample` (`{timestamp: ms, value}`); `XRKSession`
(`metadata, channels: Map<number, ChannelDef>, samples: Map<number, ChannelSample[]>`
(lazy-filled), `lapMarkers, lapSource: 'device'|'gps_auto'|'beacon_auto'|'none', durationMs,
totalSamples`).

**Time units (intentionally inconsistent — be explicit when passing values around):**
- `ChannelSample.timestamp`, `TimeRange.startMs/endMs`, libxrk `timecodes`, most backend
  responses → **ms**.
- `cursorTime`, chart's internal x-axis, lap durations in display → **seconds**.

### 6.5 Formula engine (`formula-engine.ts`)

Hand-rolled tokenizer + recursive-descent parser + AST evaluator. Precedence (loose →
tight): `|` → `&` → `<< >> >>>` → `+ -` → `* /` → `^` (power, right-assoc) → unary `- + ~`
→ paren atoms. C-family except `^` stays *power*; XOR ships as the `xor()` function.

- Constants: `e`, `pi`.
- Number literals: decimal floats and hex integers (`0xFF`, `0x80000000`, mixed case OK).
- Single-arg math: `abs sqrt sin cos tan log log2 log10 exp floor ceil round sign`.
- Two-arg: `min(a,b)`, `max(a,b)`, `pow(a,b)`, `xor(a,b)`.
- Bitwise: binary `& | << >> >>>` and unary `~`. Operands cast to 32-bit signed via `|0`
  before bit ops; `>>>` uses unsigned 32-bit (zero-fill). NaN/Inf → 0. Multi-rate channels
  go through the existing interpolate-then-truncate path.
- Signal functions (consume a channel, not a scalar):
  - `diff(ch)` — first derivative (Δ per second). `derivative(ch)` is an alias.
  - `derivative2(ch)` — second derivative.
  - `integral(ch)` — running cumulative trapezoidal integral. Output unit is
    `(channel units) · seconds`, so `integral(VBAT*IBAT)/3600` reads as Wh and
    `integral(Spd1)/3.6` as metres travelled (Spd1 in km/h).
  - `integral(ch, t_lo_ms, t_hi_ms)` — definite integral over a window with linearly
    interpolated endpoints; returns a scalar.
  - `smooth(ch, window)` — sliding-window mean of `window` samples
  - `mavg(ch, windowMs)` — moving avg over a time window in ms with zero-padding ramp-in
    (FSAE EV.3.4.1.a). Added in `bf8ad7c`.
  - `delay(ch, samples)` — shift by N samples

Bare identifiers not matching constants/functions are looked up in the `channels` dict.
When operating on multiple channels with different sample rates, the engine merges
referenced timestamps and linearly interpolates each channel onto the merged timeline.

`evaluateFormula(expression, channels)` → `{timestamps, values}` or error string.
`extractChannelNames(expression)` walks the AST — used by
`useXRKStore.ensureExpressionChannelsLoaded` to lazy-fetch referenced channels.

### 6.6 Chart engine (`TelemetryChart.tsx` + `chart-*.ts`)

Custom Canvas2D — **no charting library**.

**Performance discipline (load-bearing):**
- All transient state (cursor positions, hover, drag baseline, current xRange) lives in
  `useRef`, not `useState`. Mouse/touch handlers update refs and set
  `needsDrawRef.current = true`.
- The `requestAnimationFrame` loop only redraws when `needsDrawRef.current`, then resets it.
- **Never** call `setState` from a mouse-move/pointer-move handler.
- `onViewRangeChange` (propagates to `useXRKStore`) is debounced 100 ms;
  `onCursorTimeChange` throttled ~60 ms.

**Min/max-per-pixel decimation** (`chart-utils.ts minMaxTrace`): when sample density >
~4/px, replace the trace with first/min/max/last per pixel — drops no visible information.

**Cached refs**: `globalMinMaxCache: Map<channelId, {min, max}>` (full-dataset Y bounds);
`smoothedYRanges: Map<key, [min, max]>` (lerps toward target, so add/remove channels
doesn't snap the axis).

**Strip layout**:
- `chartMode === 'separate'`: stacked strips, height `max(140, available / numChannels)`.
  Canvas may grow past viewport — parent div is `overflow-y-auto`.
- `chartMode === 'overlay'`: all channels in one plot area sharing X axis; up to two Y axes
  per side for different unit groups.

**Interaction**: wheel = exponential zoom about mouse-x (`factor = exp(deltaY * 0.0008)`);
LMB drag = pan (drift < 3 px → click → cursor); 1-finger pan / 2-finger pinch / tap (< 10 px,
< 300 ms) → cursor; double-click = reset; delta-mode toggle for cursor B + Δ panel.

**Color resolution**: `resolveChartColor(hex, theme)` maps dark-theme hexes to light-safe
variants (manually tuned for ≥ 3.5:1 contrast).

### 6.7 Real-time view (`LiveView.tsx`)

Dashboard for live AiM streaming via `/api/live/ws`.

Status: `idle → probing → connecting → streaming` (or `paused`/`error`).

Frame handling: append to `ringRef` (max 240 ≈ 60 s at 4 Hz); refresh stats every 8 frames.
`gpsTrailRef` keeps up to 2000 GPS points for the live track canvas.

Panel layout (driven by `PANEL_OWNED_CHANNELS` set; unmapped channels fall through to "Other"):
- **Pack** — Pack V/I/SOC/Power, min cell V, discharge limit
- **Accumulator** — five module blocks (CT-17 is `5 × 20s4p`); per-module voltages aren't in
  the live stream, so the UI shows estimated `Pack V ÷ 5`
- **Cooling** — Motor / Pack / Logger temps; Pack T highlights at `PACK_TEMP_DERATE = 45 °C`
- **Vehicle** — Throttle %, F/R brake pressure, Speed, RPM, yaw/roll, lateral/long G
- **Track** — live GPS canvas + Export GPX
- **Status & Faults** — boolean rows from `BOOL_CHANNELS`
- **Other** — fallback, so new firmware never silently hides data

CT-17 constants near the top of the file: `PACK_V_MAX = 415`, `PACK_V_NOMINAL = 370`,
`PACK_TEMP_DERATE = 45`, `NUM_MODULES = 5`. Update if the car spec changes.

### 6.8 Other components

- **`SessionBrowser.tsx`** — entry view. Polls `getAimStatus()` every 10 s. Drag-and-drop
  upload. `GPSThumbnail` rendered per row (lazy fetch, module-level dedupe cache). Settings
  gear opens `SettingsDialog`. Sortable column headers (Date / Track / Duration) with
  tri-state cycle (asc → desc → clear) and localStorage-persisted preference under
  `quickscope.sessionSort`. Default = Date desc; missing values always sort to the bottom.
- **`AimSessionPicker.tsx`** — modal, multi-select bulk download via `pullFromAim()`;
  disables already-downloaded entries.
- **`SettingsDialog.tsx`** — Railway URL, AiM SSID/IP/port. Defaults wired for current car
  in `settings_store.py DEFAULTS`.
- **`DerivedChannelDialog.tsx`** — formula vs Python tab; preview-before-create with a
  320×80 mini chart.
- **`AnalysisPanel.tsx`** — five-tab container.
- **`TableView.tsx`** — virtual-scrolled (`@tanstack/react-virtual`) table aligning all
  active channels onto highest-rate timebase.
- **`GPSMapView.tsx`** — Leaflet via runtime CDN load (not bundled). Polyline color-coded
  by speed (green→yellow→red). Edit-mode toggle in the top-right enables click-to-place
  GPS lap setpoints with snap-to-nearest-track-point; pins are draggable, per-pin radius
  slider 5–50 m (default 15), first pin = start/finish, rest = sectors. PUTs setpoints
  to `/api/sessions/{id}/setpoints` on save and triggers a `/api/laps` refetch.
- **`components/ui/`** — shadcn/ui boilerplate, mostly unused.

### 6.9 Design tokens

Theme via `.dark` / `.light` class on `<html>` (toggled by `useTheme`). HSL CSS custom
properties exposed to Tailwind via `hsl(var(--token))`. Dark defaults: `--background
232 28% 7%`, `--foreground 220 15% 88%`, `--card 230 25% 10%`, `--primary 232 82% 59%`
(electric blue `#4361ee`), `--accent 28 100% 49%` (racing orange `#f77f00`).

Chart channel colors `--chart-1` … `--chart-6`; canvas reads via `getChartColors(canvas)`.
Fonts (Google, preloaded): **DM Sans** (UI), **JetBrains Mono** (data values, `.tabular`).

---

## 7. Electron + build pipeline

### 7.1 Electron main (`electron/main.cjs`)

1. `isDev = !app.isPackaged`.
2. `findFreePort()` — bind `127.0.0.1:0`, read assigned port, close.
3. `startBackend()` — spawn PyInstaller binary with `QUICKSCOPE_HOST/PORT/DATA_DIR`; pipe
   stdout/stderr to `<userData>/backend.log`; wait up to 30 s for `/docs`.
4. Backend resolution — prod: `process.resourcesPath/backend/quickscope-backend{.exe}`;
   dev: `backend/dist/quickscope-backend/...` if it exists, else assume user is running
   `./start.sh` on `:8000`.
5. Window 1400×900 (min 1024×640), `#0b0d12`, `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: false` (sandbox off because preload only injects URL).
6. External links via `shell.openExternal`.
7. Shutdown — Windows `taskkill /pid /f /t`; macOS/Linux `SIGTERM` then `SIGKILL` after 3 s.

### 7.2 Preload (`preload.cjs`)

Parses `--quickscope-backend=...` from `process.argv` and exposes via `contextBridge` as
`window.__QUICKSCOPE_BACKEND__`.

### 7.3 PyInstaller spec

`collect_all("libxrk"/"pandas"/"pyarrow")` for native exts + data files.
`collect_submodules("uvicorn")` for dynamic protocol/loop discovery. Routes listed
explicitly in `hiddenimports` because `from routes import ...` evades static analysis.

Output: `backend/dist/quickscope-backend/{quickscope-backend|.exe}` plus `_internal/`.
`console=True` keeps a terminal — useful for debugging packaged builds.

### 7.4 npm scripts

```
npm run dev               # Express + Vite dev server (used by start.sh)
npm run build             # vite build → dist/public/
npm run check             # tsc type check (no emit)
npm run electron:dev      # Electron pointing at running dev server
npm run backend:freeze    # PyInstaller → backend/dist/quickscope-backend/
npm run dist:mac|win|linux|<empty>   # build → freeze → electron-builder
```

`npm run start` exists but isn't used (would run a production-mode Express server we
don't ship).

### 7.5 electron-builder (`package.json` `build`)

- `appId`: `edu.uconn.formulasae.quickscope`
- `extraResources`: copies `backend/dist/quickscope-backend/` → `backend/`
- macOS: `dmg` + `zip`, `arm64` and `x64`, hardened runtime + entitlements.
  Notarization opt-in (CI checks all six Apple secrets are present).
- Windows: NSIS installer (not one-click), allows install dir change, desktop + start-menu shortcuts.
- Linux: AppImage.
- Mac entitlements (`build/entitlements.mac.plist`): `cs.allow-jit` +
  `cs.allow-unsigned-executable-memory` (Electron V8); `cs.disable-library-validation`
  (libxrk `.so` files aren't Apple-signed); `cs.allow-dyld-environment-variables` (frozen
  Python loader); `network.client` + `network.server`; `files.user-selected.read-write`
  (drag-drop XRK).

### 7.6 GitHub Actions

- **`release.yml`** — `v*.*.*` tag triggers. Matrix: `macos-14` (arm64), `macos-13` (x64),
  `windows-latest` (x64). Steps: checkout → Python 3.12 → Node 20 → install → freeze → build
  → conditional sign/notarize → electron-builder → upload artifacts → release job creates
  the GitHub Release. Notarization opt-in (all six Apple secrets present →
  `--config.mac.notarize=true`). `NOTARYTOOL_TIMEOUT=1200` caps Apple polling at 20 min
  (a previous release hung indefinitely).
- **`smoke.yml`** — fast unsigned build on push to `main` and PRs. Same matrix minus signing.
  `concurrency: cancel-in-progress: true`.

---

## 8. Data-Development integration (Railway sync)

How QuickScope shares sessions with the team. Data-Development is a separate repo deployed
to Railway from its `prod` branch (not this one). QuickScope is a client of its REST API.

### 8.1 Configuration

- `railway_url` in `data/settings.json`. Default in `settings_store.py`:
  `https://grateful-nourishment-production-ef50.up.railway.app/api/v1`.
- Configurable via SessionBrowser → gear → SettingsDialog → "Railway URL".
- Backend reads it lazily on every API call (no restart needed).

### 8.2 HTTP client (`railway_client.py`)

| Function | Method | Path | Timeout |
|---|---|---|---|
| `list_remote_sessions(skip, limit)` | GET | `/sessions/?skip=&limit=` | 15 s |
| `get_remote_session(remote_id)` | GET | `/sessions/{id}` | 15 s |
| `download_session_file(remote_id, dest)` | GET | `/sessions/{id}/download` | 120 s |
| `rename_session(remote_id, new_name)` | PATCH | `/sessions/{id}/rename` | 15 s |
| `upload_session_file(file_path)` | POST | `/sessions/upload` | 120 s |

Downloads stream in 65 KB chunks (`aiter_bytes(65536)`). Uploads use multipart with field
`files` and content type `application/octet-stream`. All calls `raise_for_status()`.
`_base_url()` raises `ValueError("Railway URL not configured. Set it in Settings.")` if empty.

### 8.3 Sync orchestration (`sync_service.py`)

`sync_with_railway()` does **pull, then push**:

**Pull**: `list_remote_sessions()`, then for each remote:
1. Skip if same `remote_id` already linked.
2. Match by `filename`, then by `aim_session_id` (filename stem). On match: link by
   setting `remote_id` and `sync_status` to `synced` (if `local_path`) or `remote_only`.
3. Unmatched → add new entry, `source="railway"`, `sync_status="remote_only"`. Increment `pulled`.

**Push**: for each local session with `sync_status == "local_only"` and an existing `local_path`:
- Set `uploading` (transient).
- `upload_session_file()`. Success → `synced`, `pushed += 1`. Exception → revert to
  `local_only`, append message to `errors`.

Returns `{"pulled": int, "pushed": int, "errors": [str, ...]}`.

`pull_session(session_id)` is the single-session counterpart for `POST /api/sessions/{id}/pull`.
Sets `downloading`, downloads, `local_path` + `synced`, or reverts to `remote_only` on error.

### 8.4 What triggers a sync

- **Explicit**: SessionBrowser Sync button → `POST /api/sessions/sync`.
- **Single pull**: SessionBrowser Download in a remote-only row → `POST /api/sessions/{id}/pull`.
- **Background**: after successful upload (`POST /api/upload`) or AiM pull (`POST /api/aim/pull`),
  via FastAPI `BackgroundTasks(state.background_sync)`. Acquires `state._sync_lock`
  (asyncio.Lock) so only one sync runs at a time.

### 8.5 Sync state machine

Transitions:
- `local_only` → `uploading` (push starts) → `synced` (success) or back to `local_only` (failure).
- `remote_only` → `downloading` (user clicks pull or single-pull endpoint) → `synced` or back to `remote_only`.
- `local_only` is the initial state for a fresh upload; pull adds new entries as `remote_only`.
- Crashed `uploading`/`downloading` are reset at boot by `_recover_stale_sync_state()` →
  `session_store.reset_stale_sync_states()`.

### 8.6 Remote schema (`sync_service.py:31-66`)

QuickScope reads:
```
{ "id": int → remote_id, "filename": str, "aim_session_id": str,
  "track_name": str, "driver_name": str, "vehicle_name": str,
  "recorded_at": ISO-8601, "duration_s": float, "lap_count": int }
```

If Data-Development changes its API shape, update `sync_service.py`. Download endpoint
returns raw file body, no JSON wrapper.

### 8.7 What the frontend sees

`api.ts` exposes:
- `listSessions()` → local `/api/sessions` (already includes synced Railway entries; the
  frontend never talks to Railway directly).
- `syncSessions()` → `SyncResult { ok, pulled, pushed, errors? }`.
- `pullSession(id)` → `{ ok, local_path?, error? }`.
- `renameSession(id, filename)` — backend handles both local and remote.

`SYNC_STATUS_CONFIG` in `SessionBrowser.tsx` picks the icon (CheckCircle / HardDrive /
Cloud / Loader2) per state.

---

## 9. AiM device integration

### 9.1 Discovery (UDP)

`aim_connector.is_aim_connected()` / `discover_device()`:
- Send `b"aim-ka"` to UDP `:36002` on configured device IP (default `10.0.0.1`) with
  fallbacks (`192.168.137.1`, etc.).
- Parse the 244-byte ASCII+binary response for SSID `AiM-{MODEL}-{SERIAL}-{VEHICLE}`
  (e.g. `AiM-EVO5-00740-UConn-EV`).
- Returns `{ip, ssid, device_name}`.

### 9.2 Session list & download (TCP :2000) — `aim_connector.py`

7-message handshake using fixed 84-byte STNC frames (12 + 64 + 8). Wrong-sized messages
silently dropped. Templates at `aim_connector.py:33-37`. Session CSV header:
`name,size,date,hour,nlap,veicolo,device`. Downloads request `1:/mem/{filename}` and
reassemble blocks by sorting on the per-block 32-bit `file_offset`.

### 9.3 Live streaming (TCP :2000) — `aim_live.py`

Different framing: STCP frames with command tag, length, flag byte, payload, 16-bit
checksum (`sum(payload) & 0xFFFF`) in trailer.

Handshake: UDP probe → TCP connect → send STCP hello (`b"\x00" * 6 + b"\x06\x08\x00\x00"`)
→ wait for STCP reply ≥ 8 bytes.

Live polling alternates `0x00020003` (STNC_LIVE_POLL_A) and `0x00020053` (STNC_LIVE_POLL_B)
every ~125 ms. Device responds with **547-byte STCP frames**: subsystem tag at offset 4-8
(ASCII null-padded — e.g. `"kkk"`, `"Syst"`), 32-bit timestamp at 8-12, then raw channel
payload. **Field-level decoding incomplete** — WS forwards raw bytes (base64) and the
frontend picks out channels it understands. See `docs/protocol/`.

Server auto-responds to 4-byte STCP micro-acks by echoing 4 bytes; other unknown frames
silently consumed.

### 9.4 WebSocket bridge (`/api/live/ws`)

1. Client connects.
2. Server reads `aim_device_ip` from settings; constructs `AimLiveClient(host)`; calls
   `await client.connect()` (UDP probe + TCP connect + STCP handshake).
3. Server sends `{type: "connected", device: {ip, model, serial, vehicle}}`.
4. Server starts `_pump_live()` background task iterating `client.stream()` →
   `{type: "snapshot", ts, subsystem, raw_b64}`.
5. Main coroutine `await ws.receive_text()` so client close fires `WebSocketDisconnect` →
   cancel pump.
6. Errors → `{type: "error", message}` → close.

---

## 10. Conventions

**TypeScript**: Strict mode on, don't loosen. No `any`. Prefer `Map`/`Set` over plain
objects for keyed-by-id collections.

**Python**: Type hints everywhere. Pydantic for request/response bodies. Async handlers;
wrap blocking work in `asyncio.to_thread`. Module logger (`logging.getLogger(__name__)`),
not `print`. Services don't import from `routes/`.

**Naming**: PascalCase component files, default exports. Hooks camelCase
(`useXRKStore.ts`); non-hook libs kebab-case (`chart-utils.ts`). Backend modules
snake_case. API JSON keys snake_case (Python); frontend types translate via `api.ts`.

**UI / styling**: Tailwind classes only (Canvas excepted). Dark theme is canonical, light
is a translation — test both. Icons from `lucide-react` only. Color tokens via CSS vars in
`index.css`; no hardcoded hex in components. `tabular` class for numeric data.

**Comments**: Don't restate code. Reserve for *why* something is non-obvious. File
headers state responsibility, not summary.

**Commits**: **No `Co-Authored-By: Claude` lines.** Imperative subject. Body explains *why*
if non-obvious. Examples: `LiveView: real CT-17 specs and real AiM channel names`,
`Add upload diagnostics: progress reporting, server-side log, stale-state recovery`.

---

## 11. Common task recipes

**Backend API endpoint**: pick router in `backend/routes/` (or new + `include_router` in
`main.py`); Pydantic models inline/module-level; I/O → `asyncio.to_thread`; Railway or
persistence → `backend/services/`; add wrapper in `api.ts`; wire through `App.tsx` or
component.

**WebSocket message type**: new `LiveWSMessage` variant in `routes/live.py` + matching TS
union in `api.ts`; update `LiveView.tsx`'s `ws.onmessage`.

**Analysis tab**: create `analysis/FooTab.tsx` mirroring an existing tab's props; add to
`TABS` array + render branch in `AnalysisPanel.tsx`; new state goes in `AppState`.

**Live dashboard panel**: add channel names to `PANEL_OWNED_CHANNELS` in `LiveView.tsx`;
build panel reusing `CoolStat`/`VehicleStat`; render in grid.

**Derived-channel function**: add to right group in `formula-engine.ts` + evaluator
branch; add example to `FORMULA_EXAMPLES` in `DerivedChannelDialog.tsx`. Backend Python
eval needs nothing — user has free Python.

**New channel property from libxrk**: extract in `state.py channel_meta()` (available:
`units, dec_pts, interpolate, function, source_type, source_channel_id, device_tag,
cal_value_1, cal_value_2, display_range_min, display_range_max`); surface in `/channels`
and `/upload`; add to `ChannelDef` in `xrk-parser.ts`; map in `App.tsx buildAndSetSession()`.

**New setting**: `DEFAULTS` + `ALLOWED_KEYS` in `settings_store.py`; `Settings` in `api.ts`; row in `SettingsDialog.tsx`.

**Packaging**: Python dep → `requirements.txt`, update `.spec` if PyInstaller misses it
(test with `npm run backend:freeze`). Bump version → edit `package.json`,
`git tag v1.x.y && git push --tags`. Mac entitlement → edit `entitlements.mac.plist`, re-run.

---

## 12. Gotchas & invariants

- **Time units**: ms vs s mismatch — see §6.4. Always be explicit.
- **GPS timecodes** in libxrk use raw UTC; `/api/gps` offsets by `min(timestamps)` for a
  session-relative timeline.
- **Per-id session cache**: `state.log` is now a facade over a 4-entry LRU
  (`services/session_cache.py`); the singleton invariant is gone but the active-entry
  semantics are preserved for legacy routes. Overlay reads use the per-id endpoints
  (`/api/sessions/{id}/...`) so they don't disturb the active id.
- **`useRef` vs `useState` in chart**: never `setState` from a mouse handler. Use a ref +
  `needsDrawRef.current = true`. This is the difference between 60 fps and jank.
- **Live-stream channel decoding is incomplete**: `LiveView` knows a few channels by name;
  new firmware channels appear in "Other" until someone wires them in.
- **Lap detection auto-falls-back**: device-marked laps skip GPS/beacon; no laps →
  `source: "none"` and LapAnalysisTab shows empty state. **Custom override**: a non-empty
  `lap_setpoints` on the session record skips the cascade entirely; `lap_source = "gps_manual"`.
- **Python eval sandbox is not a security boundary**. SIGALRM enforces 10 s timeout but
  the user can still touch a lot. Single-user desktop only — never expose over a network.
- **Express server is dev-only**. Never started in production. No API routes there.
- **`shared/schema.ts` is empty**. All TS types in `client/src/lib/`; all Python models in
  `backend/`. Sync by hand.
- **`/api/laps` and `/api/gps` operate on `state.log`**, not on a session ID.
- **Filename uniqueness**: `session_store.find_by_filename()` is the dedupe. Renames that
  collide with another local filename are rejected.
- **Sandbox: false in Electron preload**: currently fine because preload only injects URL —
  revisit if anything sensitive lands in preload.

---

## 13. What NOT to do

- **Don't add API routes to `server/`.** All API logic is Python.
- **Don't add a state-management library.** Single `useState<AppState>` works at this scale.
- **Don't replace the Canvas chart with a library.** The point is the rendering invariants
  (no data dropped, smooth interaction). Plotly is fine for histograms / XY plots — those
  are bounded-size.
- **Don't introduce mock data into LiveView.** Preview/mock mode was deliberately removed
  (commit `067657e`). Render what the device sends; show "no device" otherwise.
- **Don't paginate or downsample the chart trace.** Min-max-per-pixel preserves visible features.
- **Don't widen the Python eval sandbox.** Users wanting more can write a derived channel
  that calls a backend endpoint.
- **Don't add `Co-Authored-By: Claude` lines** to commits.

---

## 14. Operational notes

- Production logs: `<userData>/backend.log`. Ask users to send if a packaged build misbehaves.
- Upload diagnostics in-memory only (cleared on restart). View via `GET /api/uploads/log`.
- Empty Railway URL → `ValueError("Railway URL not configured. Set it in Settings.")`;
  route returns it in `errors[]` instead of 500.
- This repo ships **installers**, not a hosted service. CI on tag push (`v*.*.*`) →
  GitHub Release with .dmg / .exe / .zip. Data-Development is separate, deploys from its `prod` branch.

---

## 15. Where to look for things

| Touching… | Start in… |
|---|---|
| Channel parsing / metadata | `backend/state.py` + `backend/routes/analysis.py` |
| Per-id parsed-log cache | `backend/services/session_cache.py` |
| Multi-session overlay (frontend) | `client/src/lib/overlay-types.ts` + `overlay-alignment.ts` + `OverlayPopover.tsx` |
| Session library / filesystem | `backend/services/session_store.py` |
| Railway sync | `backend/services/sync_service.py` + `railway_client.py` |
| AiM session pull | `backend/services/aim_connector.py` |
| AiM live streaming | `backend/services/aim_live.py` + `backend/routes/live.py` |
| Lap detection | `backend/services/lap_detection.py` |
| GPS thumbnails | `backend/services/gps_preview.py` |
| Settings | `backend/services/settings_store.py` + `client/src/components/SettingsDialog.tsx` |
| Chart rendering | `client/src/components/TelemetryChart.tsx` + `client/src/lib/chart-*.ts` |
| Live dashboard | `client/src/components/LiveView.tsx` |
| Session list UI | `client/src/components/SessionBrowser.tsx` |
| Derived channels (math) | `client/src/lib/formula-engine.ts` |
| Derived channels (Python) | `backend/routes/analysis.py` (`/derived/evaluate`) |
| App-wide state | `client/src/lib/useXRKStore.ts` |
| Theme tokens | `client/src/index.css` + `tailwind.config.ts` |
| Electron lifecycle | `electron/main.cjs` |
| Backend freeze | `backend/quickscope-backend.spec` |
| Release pipeline | `.github/workflows/release.yml` + `docs/PACKAGING.md` |
| AiM protocol notes | `docs/protocol/aim-live-protocol.md` |
