# QuickScope

Racing telemetry analysis tool for AiM data logger files. Visualize, compare, and export channel data from `.xrk` and `.xrz` session files.

Built for UConn Formula SAE Electric.

## Features

- Custom canvas-based chart engine with multi-channel strip view
- Zoom, pan, and cursor inspection with value readouts
- Delta mode for comparing two points in time
- Derived channels via math formulas or JavaScript expressions
- Lap analysis, histograms, XY scatter plots, GPS track map
- CSV export with cross-channel interpolation
- Session management with local persistence
- Sync with [Data-Development](https://github.com/uconnformulasae/Data-Development) (Railway deployment) for shared session storage
- Direct AiM device connectivity over WiFi (macOS and Windows)

## Architecture

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS (port 5000)
- **Backend**: Python FastAPI + AiM DLL (primary on Windows) / libxrk (fallback) (port 8000)

The backend parses `.xrk`/`.xrz` files using the official AiM MatLabXRK DLL when available (Windows), falling back to [libxrk](https://pypi.org/project/libxrk/) on other platforms or if the DLL is missing. See `backend/vendor/README.md` for Windows dev setup.

Sessions are persisted locally in `backend/data/sessions.json` with raw files cached in `backend/data/sessions/`. When configured, sessions sync bidirectionally with the Data-Development Railway backend.

## Install (for end users)

Download the latest installer from the [Releases page](../../releases/latest):

- **macOS (Apple Silicon)** — `QuickScope-*-arm64.dmg`
- **macOS (Intel)** — `QuickScope-*-x64.dmg`
- **Windows (x64)** — `QuickScope-Setup-*.exe`

Double-click to install. No Python or Node required. On first launch Windows
may show a SmartScreen warning (click **More info → Run anyway**); unsigned
Mac builds require right-click → Open once.

See [docs/PACKAGING.md](docs/PACKAGING.md) for the release/signing workflow.

## Quick Start (for contributors)

```bash
./start.sh
```

This installs dependencies (if needed) and starts both servers. Open `http://localhost:5000`.

**Parser flags** (optional):

```bash
./start.sh              # auto: DLL on Windows when available, else libxrk
./start.sh --libxrk     # force libxrk
./start.sh --dll        # force AiM DLL (Windows)
```

**Windows:** same flags via PowerShell: `./start.ps1`, `./start.ps1 -Libxrk`, `./start.ps1 -Dll`.

**Windows contributors:** place `MatLabXRK-2017-64-ReleaseU.dll` in `backend/vendor/` for the primary parser (see `backend/vendor/README.md`). Without it, libxrk is used automatically.

### Testing

```powershell
npm run test          # unit regression (no DLL, no libxrk fixtures)
npm run test:dll      # DLL vs Race Studio CSV (Windows + fixtures)
npm run test:libxrk   # libxrk fallback parser on XRK fixtures
npm run check         # TypeScript only

# AiM download protocol + reassembly
.venv\Scripts\python.exe -m pytest tests/test_aim_download.py -v
```

Parser validation against a local XRK + Race Studio export:

```powershell
.venv\Scripts\python.exe scripts\validate_dll.py tests\fixtures
```

See [tests/fixtures/README.md](tests/fixtures/README.md) for fixture layout and [docs/CI.md](docs/CI.md) for GitHub Actions setup.

### Manual Start

```bash
# Backend
cd backend
pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
npm install
npm run dev
```

## Configuration

Click the gear icon in the session browser to configure:

- **Railway URL** -- Data-Development API endpoint (e.g. `https://your-app.up.railway.app/api/v1`)
- **AiM WiFi SSID** -- your AiM device's hotspot name
- **AiM Device IP** -- default `10.0.0.1`

Settings are stored in `backend/data/settings.json`.

Optional env overrides:

| Variable | Purpose |
|----------|---------|
| `QUICKSCOPE_DATA_DIR` | Override `backend/data` location |
| `QUICKSCOPE_PARSER` | `libxrk` or `aim_dll` (same as start-script flags) |
| `AIM_XRK_DLL` | Path to `MatLabXRK-2017-64-ReleaseU.dll` |

## AiM Device Connection

When connected to the AiM device's WiFi hotspot:

1. The green AiM indicator appears in the session browser header
2. Click **Pull from AiM** to browse sessions on the device
3. Select which sessions to download
4. Downloaded `.xrz` files are saved locally and auto-uploaded to Railway (if configured)

The connection uses the AiM binary TCP protocol (port 2000) with UDP discovery (port 36002). File downloads send **progress-encoded STCP micro-ACKs** (cumulative bytes received at each ~982 KB batch boundary), matching RaceStudio behavior captured in Wireshark. Live streaming still uses zero-byte micro-ACKs; see `docs/protocol/aim-live-protocol-deep-dive.md` vs download captures such as `116CaptureWireshark.pcapng`.

**Download troubleshooting**

- Each pull writes a JSONL trace to `backend/data/logs/aim_download/` (timestamp + filename). Use these logs to compare `extracted_bytes`, `batch_complete_ack`, and `ack_payload_bytes` against a known-good RaceStudio capture.
- List traces via API: `GET /api/aim/download/trace` (and `/api/aim/download/trace/{name}` for a single log).
- Run `pytest tests/test_aim_download.py` after protocol changes; includes a regression test against `116CaptureWireshark.pcapng` stream 38.
- Device session list dates are preferred over embedded XRK metadata when indexing pulled sessions.

**Validated:** QuickScope pulls of multi-minute sessions (e.g. `a_0141`) match RaceStudio exports on core EV channels (pack voltage/current, RPM, torque, phase currents, throttle, brakes) when compared sample-for-sample.

## Project Structure

```
backend/
  main.py                  # FastAPI app -- session management + analysis endpoints
  services/
    session_store.py       # JSON-backed local session index
    settings_store.py      # Persistent settings
    railway_client.py      # Data-Development API client
    aim_connector.py       # AiM device protocol (UDP discovery + TCP session list/download)
    aim_download_trace.py  # JSONL download traces for debugging truncated pulls
    sync_service.py        # Bidirectional Railway sync

docs/protocol/             # Reverse-engineered AiM WiFi protocol notes + Wireshark analysis

client/src/
  App.tsx                  # Root -- view routing (session browser vs analysis)
  lib/
    api.ts                 # Backend API client
    useXRKStore.ts         # React state management
    xrk-parser.ts          # Types, downsampling, formatting helpers
    formula-engine.ts      # Derived channel expression evaluator
  components/
    SessionBrowser.tsx     # Session list, sync, upload, AiM pull
    TelemetryChart.tsx     # Canvas chart engine
    ChannelSidebar.tsx     # Channel picker
    AnalysisPanel.tsx      # Stats, laps, histogram, XY plot, GPS tabs
    AimSessionPicker.tsx   # AiM device session browser/downloader
    SettingsDialog.tsx     # Railway + AiM configuration
    SessionHeader.tsx      # Top bar with metadata and controls
    DerivedChannelDialog.tsx  # Formula/JS expression editor
    ExportDialog.tsx       # CSV export channel selector
    GPSMapView.tsx         # Leaflet map with speed-colored track
```
