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

Sessions are persisted locally in `./data/sessions.json` with raw files cached in `./data/sessions/`. When configured, sessions sync bidirectionally with the Data-Development Railway backend.

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

Settings are stored in `./data/settings.json`.

## AiM Device Connection

When connected to the AiM device's WiFi hotspot:

1. The green AiM indicator appears in the session browser header
2. Click "Pull from AiM" to browse sessions on the device
3. Select which sessions to download
4. Downloaded sessions are saved locally and auto-uploaded to Railway (if configured)

The connection uses the AiM binary TCP protocol (port 2000) with UDP discovery (port 36002).

## Project Structure

```
backend/
  main.py                  # FastAPI app -- session management + analysis endpoints
  services/
    session_store.py       # JSON-backed local session index
    settings_store.py      # Persistent settings
    railway_client.py      # Data-Development API client
    aim_connector.py       # AiM device protocol (UDP discovery + TCP session list/download)
    sync_service.py        # Bidirectional Railway sync

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
