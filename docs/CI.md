# Continuous Integration

QuickScope uses **GitHub-hosted runners** for all CI.

## Workflows

| Workflow | When | Purpose |
|----------|------|---------|
| [ci.yml](../.github/workflows/ci.yml) | PRs targeting `main`, `workflow_dispatch` | Tests, Docker smoke, unsigned desktop builds (all platforms) |
| [release.yml](../.github/workflows/release.yml) | Tags `v*.*.*`, `workflow_dispatch` | Signed/notarized (when secrets exist) installers + GitHub Release |

### CI jobs (`ci.yml`)

| Job | Runner | What it proves |
|-----|--------|----------------|
| `test / ubuntu` | `ubuntu-latest` | `pytest -m "not dll"`, `npm audit`, TypeScript (`npm run check`), Vitest |
| `test / windows` | `windows-latest` | `pytest -m dll` (MatLabXRK DLL + fixtures) |
| `docker` | `ubuntu-latest` | `docker compose build` + backend `/docs` healthcheck |
| `desktop / win-x64` | `windows-latest` | PyInstaller + Electron NSIS (x64) |
| `desktop / mac-arm64` | `macos-latest` | Unsigned `.dmg` / `.zip` (arm64) |
| `desktop / mac-x64-intel` | `macos-15-intel` | Unsigned `.dmg` / `.zip` (x64, native Intel runner) |
| `desktop / linux-x64` | `ubuntu-latest` | AppImage x64 (libxrk backend) |
| `desktop / linux-arm64` | `ubuntu-24.04-arm` | AppImage arm64 (libxrk backend) |

**Full desktop matrix runs on every PR to `main`** (five parallel installer jobs). Use `workflow_dispatch` inputs `skip_desktop` or `skip_docker` to debug faster.

Parser coverage uses pytest markers (`dll`, `libxrk`) — there are no separate “regression” workflow files.

## Parser fixtures

DLL and libxrk tests need a real `.xrk` in `tests/fixtures/`. The canonical pair is **committed to git**:

- `tests/fixtures/endurance_CT16-EV_Standardized_a_5816.xrk`
- `tests/fixtures/endurance_CT16-EV_Standardized_a_5816_rs.csv`

The Windows test job runs [`setup-parser-assets`](../.github/actions/setup-parser-assets/action.yml) with `download-fixtures: true` when needed. If files are already in the checkout, the action skips the download.

Optional backup for forks: publish to the **`fixtures-v1`** GitHub Release:

```powershell
gh auth login
.\scripts\publish_fixtures_release.ps1
```

**Docker note:** Production Linux deployments use libxrk via `docker compose` (see the `docker` CI job). The AiM DLL runs only on Windows (desktop + `test / windows`).

DLL jobs clone the MatLabXRK DLL from [laz-/xrk](https://github.com/laz-/xrk) on `windows-latest`.

## AiM live / download protocol tests

Two layers, so the device protocol is tested on every PR without hardware:

1. **Fake logger (always runs).** `tests/fake_aim_device.py` is an in-process TCP server that answers
   `AimLiveClient` the way the EVO5 does (hello, enumeration, channel layout, live polling, session list)
   and can simulate drops, stalls, a silent hello and line noise. `tests/test_aim_live_client.py` drives
   the real client against it. Nothing to download.
2. **Capture replay (runs when streams are available).** `tests/test_aim_live.py` and
   `tests/test_aim_download.py` replay real Race Studio / QuickScope Wireshark captures. Raw `.pcapng`
   files are never committed; `scripts/extract_aim_streams.py` keeps only the AiM TCP payload bytes
   (`<stem>.server.bin.gz` / `<stem>.client.bin.gz`). The `test / ubuntu` job downloads them from the
   **`aim-streams-v1`** release into `tests/fixtures/aim_streams/`; if the release is missing, those tests skip.

Tests look for a capture in this order: `$QUICKSCOPE_AIM_CAPTURES`, `tests/fixtures/aim_streams/`, the repo
root, then `~/Downloads` (extracted `.bin.gz` or raw `.pcapng`).

Publish or refresh the streams (the repo is public, so release assets are public):

```bash
python scripts/extract_aim_streams.py ~/Downloads
scripts/publish_aim_streams_release.sh
```

## Branch protection

On `main`, enable required status checks:

- `test / ubuntu`
- `test / windows`
- `docker`
- `desktop / win-x64`
- `desktop / mac-arm64`
- `desktop / mac-x64-intel`
- `desktop / linux-x64`
- `desktop / linux-arm64`

Remove legacy names (`test`, `dll-regression`, `libxrk-regression`, `smoke / smoke`, etc.) if they are still listed.

## Local commands

```powershell
npm run test          # unit regression (no DLL)
npm run test:libxrk   # libxrk parser on XRK fixtures (no DLL)
npm run test:dll      # DLL integration (Windows + fixtures)
npm run check         # TypeScript only

.venv\Scripts\python.exe scripts\validate_dll.py tests\fixtures
```

## Composite actions

| Action | Role |
|--------|------|
| [setup-parser-assets](../.github/actions/setup-parser-assets/action.yml) | Fixtures + Windows DLL |
| [desktop-build](../.github/actions/desktop-build/action.yml) | `electron-builder` after PyInstaller + Vite |
## Test layers

| Layer | Files | What it proves |
|-------|-------|----------------|
| Unit | `test_state_helpers`, `test_stores`, `test_lap_detection`, `test_session_cache*`, `test_aim_*` | Pure logic and protocol parsing |
| API workflow | `test_api_workflow.py` | FastAPI journey on synthetic session |
| Real session | `test_e2e_real_session.py` | Committed CT16-EV `.xrk` vs Race Studio CSV |
| Process (`e2e`) | `test_e2e_process.py` | Real backend process + WebSocket |
| Parser | `test_dll_regression.py`, `test_libxrk_regression.py` | DLL (Windows CI) / libxrk (Ubuntu CI) |
| Frontend | `client/src/lib/*.test.ts` | Vitest |

Skip slow tests while iterating: `pytest -m "not dll and not libxrk and not slow"`.

**macOS desktop:** `desktop-build` passes a single-arch `mac.target` override per job. arm64 builds on `macos-latest`; x64 builds on `macos-15-intel` (native Intel, not cross-compile). **Linux desktop:** x64 and arm64 use `ubuntu-latest` / `ubuntu-24.04-arm`; both need `libasound2t64` (not `libasound2`). **No Windows arm64 build:** PyPI has no `pyarrow` `win_arm64` wheels ([apache/arrow#47195](https://github.com/apache/arrow/issues/47195)), and compiling Arrow C++ in CI is too slow. Windows on ARM runs the `win-x64` installer under built-in x64 emulation. Revisit once official wheels ship.
