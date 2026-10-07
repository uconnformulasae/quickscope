# QuickScope documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [PACKAGING.md](PACKAGING.md) | Maintainers | Electron builds, installers, releases, signing |
| [CI.md](CI.md) | Contributors | GitHub Actions workflows, parser fixtures |
| [aim-device.md](aim-device.md) | Contributors & operators | AiM WiFi connectivity, TCP model, logs, troubleshooting |
| [protocol/README.md](protocol/README.md) | Protocol work | Reverse-engineered AiM wire format, captures, test workflow |

Historical feature design notes from agent sessions live under [archive/planning/](archive/planning/) and are not kept in sync with the app.

## Backend layout (high level)

```
backend/
  main.py                 # FastAPI app, AiM primary hub on startup
  routes/
    sessions.py           # Local session CRUD, AiM pull
    analysis.py           # Chart data, laps, export
    settings.py           # settings.json
    live.py               # WebSocket live telemetry (/api/live/ws)
  services/
    session_store.py      # sessions.json + file cache
    settings_store.py
    aim_discovery.py      # UDP 36002 probe + identity parse
    aim_keepalive.py      # Periodic UDP aim-ka while primary TCP is open
    aim_primary_hub.py    # One primary TCP: live + session list
    aim_live.py           # Handshake, poll loop, snapshot decode
    aim_connector.py      # Session list + download on primary / download TCP
    aim_*_trace.py        # JSONL debug logs (live, download, pull)
```

The root [README.md](../README.md) covers install, daily dev commands, and UI structure.
