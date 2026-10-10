# QuickScope + Data-Development Integration Design

## Overview

Integrate QuickScope (local telemetry analysis tool) with Data-Development (Railway-deployed telemetry platform) so that QuickScope can:

1. Browse and download sessions from Data-Development's Railway API
2. Pull logs directly from AiM devices over WiFi (macOS + Windows)
3. Upload locally-acquired sessions to Data-Development automatically
4. Persist sessions locally between restarts
5. Retain all existing analysis capabilities unchanged

## Architecture

QuickScope remains a standalone local application (separate repo, separate deployment). It communicates with two external sources:

- **Data-Development (Railway)** — remote session storage, accessed via REST API
- **AiM Device** — local WiFi hotspot, accessed via HTTP on the device's IP

### Backend Changes

QuickScope's Python/FastAPI backend is restructured from single-session-in-memory to multi-session with local persistence:

- **Session Manager** — manages `./data/sessions.json` index and `./data/sessions/` file cache
- **Sync Service** — bidirectional sync with Railway (pull remote sessions, push local sessions)
- **AiM Connector** — cross-platform WiFi detection and file download from AiM devices
- **Settings** — `./data/settings.json` for Railway URL and AiM configuration

### Frontend Changes

- **Session Browser** — new landing page for browsing, selecting, and managing sessions
- **Sync Status UI** — connection indicators for Railway and AiM
- **Settings Dialog** — configure Railway URL, AiM SSID/IP
- **Back Navigation** — return to session browser from analysis view
- **Analysis View** — completely unchanged (chart, stats, histograms, XY plot, GPS, formulas)

## Data Model

### sessions.json

```json
[
  {
    "id": "uuid",
    "remote_id": null,
    "aim_session_id": "unique-from-aim",
    "filename": "session_001.xrk",
    "local_path": "./data/sessions/session_001.xrk",
    "track_name": "Lincoln Airpark",
    "driver_name": "Driver 1",
    "vehicle_name": "UConn EV",
    "recorded_at": "2026-03-15T10:30:00Z",
    "duration_s": 1234.5,
    "lap_count": 14,
    "sync_status": "synced",
    "source": "aim_device",
    "created_at": "2026-03-15T12:00:00Z",
    "updated_at": "2026-03-15T12:05:00Z"
  }
]
```

**sync_status values:** `local_only`, `remote_only`, `synced`, `uploading`, `downloading`
**source values:** `manual_upload`, `aim_device`, `railway`

### settings.json

```json
{
  "railway_url": "https://your-app.railway.app/api/v1",
  "aim_wifi_ssid": "AiM-EVO5-00740-UConn-EV",
  "aim_device_ip": "10.0.0.1",
  "aim_device_port": 2000
}
```

## API Surface

### Existing Endpoints (preserved)

| Endpoint | Method | Change |
|----------|--------|--------|
| `/api/upload` | POST | Now also saves to file cache, updates sessions.json, queues Railway upload |
| `/api/channels` | GET | No change |
| `/api/data` | GET | No change |
| `/api/laps` | GET | No change |
| `/api/gps` | GET | No change |
| `/api/export` | GET | No change |

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List all sessions from sessions.json |
| `/api/sessions/{id}/load` | POST | Load a local session into memory for analysis |
| `/api/sessions/sync` | POST | Sync with Railway (refresh + push unsynced) |
| `/api/sessions/{id}/pull` | POST | Download a remote_only session from Railway |
| `/api/sessions/{id}` | DELETE | Remove session from local cache |
| `/api/aim/status` | GET | Check AiM WiFi connectivity |
| `/api/aim/sessions` | GET | List sessions on AiM device |
| `/api/aim/pull` | POST | Download new sessions from AiM device |
| `/api/settings` | GET | Get current settings |
| `/api/settings` | PUT | Update settings |

## Sync Logic

### Startup Sync
1. Fetch `GET /sessions/` from Railway
2. For each remote session, match locally by `aim_session_id` or `filename`
3. New remotes → insert as `remote_only`
4. Matched → update `remote_id`, mark `synced`
5. Local `local_only` sessions → queue for upload

### Pull (Railway → Local)
1. `GET /sessions/{id}/download` from Railway
2. Save raw file to `./data/sessions/`
3. Update `local_path`, `sync_status = synced`

### Push (Local → Railway)
1. `POST /sessions/upload` to Railway with raw file
2. On success, store `remote_id`, `sync_status = synced`

### AiM Acquisition
1. Detect AiM WiFi SSID (platform-specific: `airport` on macOS, `netsh` on Windows)
2. HTTP GET to AiM device to list sessions
3. Download files not already in local DB
4. Save to `./data/sessions/`, insert as `local_only, source = aim_device`
5. Auto-queue upload to Railway

## Data-Development Change

Single addition on `main` branch:

**`GET /api/v1/sessions/{session_id}/download`** — serves the raw .xrk/.xrz file from the `aim_data/` directory as a binary download. 404 if session or file not found.

No other changes to Data-Development.

## What Does NOT Change

- TelemetryChart (custom Canvas engine)
- ChannelSidebar
- AnalysisPanel (all 5 tabs: stats, lap analysis, histogram, XY plot, GPS)
- DerivedChannelDialog + formula engine
- ExportDialog
- libxrk parsing
- Channel data serving
- CSV export logic
