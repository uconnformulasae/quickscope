# QuickScope — Agent Guide

## What this is

QuickScope is a racing telemetry analysis tool for AiM XRK log files. It has a Python backend that parses files using `libxrk` and a React frontend that renders channel data on a custom HTML5 Canvas chart engine.

It is a local-only single-user app. The backend holds one parsed session in memory. There is no database, no auth, no multi-user support.

## Architecture

```
start.sh                    ← Single entry point, starts both servers
├── backend/main.py         ← FastAPI + libxrk (port 8000)
└── client/                 ← React + Vite + Tailwind (port 5000)
    └── src/
        ├── App.tsx                     ← Root component, wires everything
        ├── lib/
        │   ├── api.ts                  ← HTTP client for backend API
        │   ├── useXRKStore.ts          ← Global state (useState hook, not Redux/Zustand)
        │   ├── xrk-parser.ts           ← Type interfaces + helpers ONLY (no parsing)
        │   └── formula-engine.ts       ← Derived channel expression evaluator
        └── components/
            ├── TelemetryChart.tsx       ← Canvas chart engine (1256 lines, most complex file)
            ├── AnalysisPanel.tsx        ← Stats, Laps, Histogram, XY Plot, GPS tabs
            ├── ChannelSidebar.tsx       ← Channel list with search/filter
            ├── SessionHeader.tsx        ← Top bar with metadata + file loader
            ├── DerivedChannelDialog.tsx ← Create/edit computed channels
            ├── ExportDialog.tsx         ← CSV export with channel selection
            └── GPSMapView.tsx           ← Leaflet map (in AnalysisPanel GPS tab)
```

## Data flow

1. User clicks **Load File** → browser file picker → file uploaded via `POST /api/upload`
2. Backend parses with `libxrk.aim_xrk()`, stores in memory, returns metadata + channel list
3. Frontend builds a skeleton `XRKSession` object (channels defined but no sample data yet)
4. When a channel is activated (clicked in sidebar), `GET /api/data?channels=Name` fetches its samples
5. Sample data (`{timestamps: ms[], values: float[]}`) is stored in `session.samples` Map
6. Canvas chart reads from `session.samples` and renders on every `requestAnimationFrame`
7. Derived channels compute client-side using fetched data from other channels

## Backend API (backend/main.py)

All endpoints prefixed with `/api/`. Backend is stateful — one session at a time.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/upload` | POST | Upload .xrk file, parse, return metadata + channel list |
| `/api/channels` | GET | Channel list with units, sample counts |
| `/api/data?channels=A,B,C` | GET | Timestamps + values for named channels |
| `/api/laps` | GET | Lap timing data |
| `/api/gps` | GET | GPS lat/lon/speed (filtered for valid fixes) |
| `/api/export?channels=A,B` | GET | CSV download with interpolated timebase |

`libxrk` returns channels as a `dict[str, pyarrow.Table]` where each table has columns `timecodes` (int64 ms) and the channel value column. Metadata is a plain dict. Laps is a PyArrow table with `num`, `start_time`, `end_time`.

GPS timecodes from libxrk are in a different timebase (raw UTC) than regular channels (session-relative). The GPS endpoint offsets them by subtracting `min(timestamps)`.

## Frontend key patterns

### State management

`useXRKStore.ts` uses a single `useState<AppState>()` hook. All state mutations go through `useCallback` setters. Transient state (cursor position, zoom range, drag state) lives in `useRef` inside `TelemetryChart` to avoid React re-renders on every mouse move.

**`TimeRange` uses milliseconds.** Fields are named `startMs`/`endMs`. Timestamps in `ChannelSample` are also milliseconds. The chart converts to seconds internally for display.

### Canvas chart engine (TelemetryChart.tsx)

This is the most complex component. Key design:

- **Single `<canvas>`** renders all channel strips in one `requestAnimationFrame` loop
- **No third-party charting library** — pure Canvas2D drawing
- **Strip layout**: each channel gets a vertical strip, height = `max(140px, available / numChannels)`
- **Rendering**: Min-max per-pixel optimization for large datasets; no data reduction — every visible data point is rendered accurately
- **Zoom**: scroll wheel with graduated intensity (`Math.exp(deltaY * 0.0008)`)
- **Pan**: mouse drag shifts xRange
- **Touch**: pinch-to-zoom + single-finger pan
- **Cursor**: `hoverXRef` always tracks mouse; `cursorXRef`/`cursor2XRef` for placed cursors
- **Delta mode**: two placed cursors with shaded region and Δ panel
- **Min/max markers**: precomputed from full dataset (cached in `globalMinMaxCache` ref), drawn as triangles with off-screen arrows

**Performance rules:**
- Never call `setState` from mouse/touch handlers — only set refs + `needsDrawRef.current = true`
- `onViewRangeChange` is debounced at 100ms
- Min-max trace reduces draw calls for dense data without dropping visible information
- `requestAnimationFrame` loop only draws when `needsDrawRef.current` is set

### Derived channels

Users can create computed channels using math expressions (`Spd1 * 0.621371`) or JavaScript code. The formula engine in `formula-engine.ts` is a recursive-descent parser supporting:
- Operators: `+`, `-`, `*`, `/`, `^` (right-associative)
- Functions: `abs`, `sqrt`, `sin`, `cos`, `diff`, `smooth`, `delay`
- Channel names as variables (auto-resolved to sample arrays)
- Cross-channel interpolation for different sample rates

Derived channel data lives in `derivedSamplesMap` (separate from `session.samples`). Both the chart and analysis panel check both maps when resolving channel data.

## Common tasks

### Adding a new API endpoint

1. Add the route in `backend/main.py`
2. Add the fetch function in `client/src/lib/api.ts`
3. Wire it through `App.tsx` or the relevant component

### Adding a new analysis tab

1. Add the tab ID to `AnalysisTab` type in `useXRKStore.ts`
2. Add entry to `TABS` array in `AnalysisPanel.tsx`
3. Create the tab component in the same file
4. Pass required props from the `AnalysisPanel` render

### Adding a new channel property from libxrk

1. Extract it in `backend/main.py` using `ChannelMetadata.from_field(field)` — available fields: `units`, `dec_pts`, `interpolate`, `function`, `source_type`, `source_channel_id`, `device_tag`, `cal_value_1`, `cal_value_2`, `display_range_min`, `display_range_max`
2. Include it in the `/api/channels` or `/api/upload` response
3. Add the field to `ChannelDef` interface in `xrk-parser.ts`
4. Map it in `App.tsx` where the upload response is processed into channel definitions

### Modifying the chart drawing

All drawing is in the `draw` callback inside `TelemetryChart.tsx`. The pipeline is:
1. Clear canvas
2. For each strip: grid → lap markers → line trace → min/max markers → Y-axis → channel label → separator
3. Bottom X-axis
4. Cursor overlays (hover line, placed cursors, delta region)
5. Delta panel

To add a new overlay (e.g., annotations), add drawing code after the cursor section.

## Build & run

```bash
# Development (both servers with hot reload)
./start.sh

# Frontend only
cd client && npm run dev

# Backend only
cd backend && python3 -m uvicorn main:app --port 8000 --reload

# Production build (frontend)
npm run build
# Output in dist/public/
```

## Dependencies

### Python (backend/requirements.txt)
- `libxrk` — AiM XRK/XRZ file parser (Cython, requires Python 3.10+)
- `fastapi` + `uvicorn` — HTTP server
- `python-multipart` — file upload handling

### Node (package.json)
- React 18 + Vite 7 + TypeScript
- Tailwind CSS 3 + shadcn/ui components
- lucide-react for icons
- No charting library (custom Canvas)
- No state management library (custom hook)

### CDN-loaded (by GPSMapView at runtime)
- Leaflet 1.9.4 (map tiles + polyline rendering)

## Known limitations

- Single file at a time — loading a new file replaces the current session
- GPS data from libxrk uses computed channels (derived from raw ECEF) — quality depends on GPS fix
- Derived channels recompute from scratch each time (no incremental updates)
- Export CSV interpolates all channels to the highest-rate channel's timebase, which can produce very large files
- The Express server in `server/` is vestigial scaffolding that only serves the Vite dev build — all API logic is in the Python backend
- `components/ui/` directory contains ~40 shadcn/ui components, most of which are unused by the app but harmless to keep

## Style conventions

- Dark theme only — background `#0d0e14`, text `#8b93a8`, accent blue `#4361ee`, accent orange `#f77f00`
- Monospace font: JetBrains Mono (for data values, axis labels)
- UI font: DM Sans (for labels, buttons, headings)
- All new components should use Tailwind classes, not inline styles (except Canvas drawing)
- Icons from `lucide-react` only
- File naming: PascalCase for components, camelCase for lib files
