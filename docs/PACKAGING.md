# QuickScope — Packaging & Release Guide

Turns the dev app (Python backend + React frontend) into a double-click
installer for Mac and Windows.

## What users get

| Platform | Installer | Size |
|---|---|---|
| macOS (Apple Silicon) | `QuickScope-1.0.0-arm64.dmg` | ~230MB |
| macOS (Intel) | `QuickScope-1.0.0-x64.dmg` | ~230MB |
| Windows (x64) | `QuickScope-Setup-1.0.0.exe` | ~220MB |

All installers are self-contained — users don't need Python or Node.

### User install flow

**Mac:** Download the `.dmg`, double-click, drag QuickScope to Applications,
launch from Launchpad. If the build is unsigned, first launch requires
right-click → Open (Gatekeeper warning shown once).

**Windows:** Download the `.exe`, double-click. Because the build is unsigned,
SmartScreen shows a blue "Windows protected your PC" screen — click
**More info → Run anyway**. Future launches from the Start menu or desktop
shortcut don't prompt.

## Architecture (packaged app)

```
QuickScope.app / QuickScope.exe
├─ Electron shell                    (serves the UI, owns the window)
│    ↓ spawns on startup
├─ quickscope-backend                (PyInstaller-frozen FastAPI + parsers)
│    binds to 127.0.0.1:<free-port>
│    reads/writes to user data dir
│    Windows: ships MatLabXRK DLL (primary) + libxrk (fallback)
│    macOS: libxrk only
│
└─ User data directory               (persists across reinstalls)
     macOS:    ~/Library/Application Support/QuickScope/data/
     Windows:  %APPDATA%/QuickScope/data/
```

The Electron main process (`electron/main.js`) picks a free port, starts the
backend with `QUICKSCOPE_DATA_DIR` and `QUICKSCOPE_PORT` env vars, waits for
`/docs` to respond, then loads the built Vite bundle in a `BrowserWindow`.
A preload script injects `window.__QUICKSCOPE_BACKEND__` so the renderer's
`api.ts` knows where to send requests.

## Local build (test before shipping)

Prerequisites: Python 3.12, Node 20.

**Windows only:** place `MatLabXRK-2017-64-ReleaseU.dll` in `backend/vendor/` before building
(see [AiM RS3 DLL docs](https://www.aim-sportline.com/docs/racestudio3/manual/html/xrk-dll.html)).
The DLL is proprietary AiM software and is gitignored; CI release builds fetch it from the
[laz-/xrk](https://github.com/laz-/xrk) mirror at freeze time.

```bash
npm ci
pip install -r backend/requirements.txt pyinstaller

# One-shot: build frontend + freeze backend + make installer for your OS
npm run dist
```

Output lands in `release/`. Test the built app by double-clicking the `.dmg` /
`.exe` (or running the unpacked app in `release/mac-arm64/QuickScope.app`).

### Platform-specific shortcuts

```bash
npm run dist:mac     # DMGs for arm64 + x64 (cross-arch PyInstaller needs Rosetta)
npm run dist:win     # Only works on Windows
```

Cross-platform limitation: you cannot build a Windows installer from a Mac
(and vice-versa). Use GitHub Actions — it runs all three platforms in parallel.

## Releasing (via GitHub Actions)

The release pipeline in `.github/workflows/release.yml` builds all three
installers on the correct platform runners and attaches them to a GitHub
Release.

### Cut a new release

```bash
# Bump version in package.json, commit, then:
git tag v1.0.1
git push origin v1.0.1
```

The workflow runs on three runners (macos-14 arm64, macos-13 Intel,
windows-latest), produces `.dmg` / `.exe` artifacts, and publishes them to a
GitHub Release auto-generated from the commit log.

Users then find the installers on the repo's **Releases** page.

### Manual build (no release)

Go to **Actions → Release → Run workflow** from the GitHub UI. Installers
upload as workflow artifacts (no Release is published).

## Code signing & notarization (optional, recommended for Mac)

By default both Mac and Windows builds are **unsigned**. Users see a one-time
security warning they can click through. That's fine for a small user base.

To eliminate the Mac warning, set up signing + notarization with your Apple
Developer account ($99/yr):

### One-time setup

1. **Apple Developer Portal** → Certificates → create a new
   **Developer ID Application** certificate. Download the `.cer`.
2. In Keychain Access, export it as a `.p12` with a password.
3. Base64-encode it: `base64 -i DeveloperID.p12 | pbcopy`.
4. **App Store Connect** → Users and Access → Integrations → create an
   **API Key** with "Developer" role. Download the `.p8` (one-time download).
5. Note the **Key ID**, **Issuer ID**, and **Team ID** shown on that page.

### GitHub repository secrets

In your repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | Base64 output from step 3 |
| `MAC_CERT_PASSWORD` | The `.p12` export password |
| `APPLE_API_KEY_CONTENT` | Contents of the `.p8` file (full text, including BEGIN/END lines) |
| `APPLE_API_KEY_ID` | Key ID from App Store Connect |
| `APPLE_API_KEY_ISSUER` | Issuer ID from App Store Connect |
| `APPLE_TEAM_ID` | Your 10-character team ID |

### Enable notarization

In `package.json`, change `"notarize": false` to:

```json
"notarize": {
  "teamId": "YOUR_TEAM_ID"
}
```

The next tag push will produce signed + notarized builds. Notarization adds
2–15 minutes to the Mac job — Apple's server scans for malware and returns a
ticket that electron-builder staples to the DMG.

### Windows code signing (skip for now)

Would cost $200-400/yr for an OV/EV cert. Not worth it for a small user base
— the one-time SmartScreen warning is acceptable. Skip unless many users
complain.

## Common issues

**"Backend did not start within timeout"** — open the log at
`~/Library/Application Support/QuickScope/backend.log` (Mac) or
`%APPDATA%/QuickScope/backend.log` (Windows) to see the Python traceback.
Usually a missing hidden-import — add it to `backend/quickscope-backend.spec`.

**"damaged and can't be opened" on Mac** — build is unsigned and downloaded
via browser (quarantine flag set). Fix: `xattr -d com.apple.quarantine
/Applications/QuickScope.app`. The permanent fix is notarization (above).

**"Bundle too large"** — pandas alone is ~80MB. Drop it by inlining the
couple of `df.to_pandas()` calls in `backend/state.py` with direct PyArrow
access. Deferred to a future change.
