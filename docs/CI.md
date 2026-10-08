# Continuous Integration

QuickScope uses **GitHub-hosted runners** for all CI.

## Workflows

| Workflow | When | Purpose |
|----------|------|---------|
| [ci.yml](../.github/workflows/ci.yml) | PR, push `main`/`Dev`, `workflow_dispatch` | Tests, Docker smoke, unsigned desktop builds (all platforms) |
| [release.yml](../.github/workflows/release.yml) | Tags `v*.*.*`, `workflow_dispatch` | Signed/notarized (when secrets exist) installers + GitHub Release |

### CI jobs (`ci.yml`)

| Job | Runner | What it proves |
|-----|--------|----------------|
| `test / ubuntu` | `ubuntu-latest` | `pytest -m "not dll"`, TypeScript (`npm run check`), Vitest |
| `test / windows` | `windows-latest` | `pytest -m dll` (MatLabXRK DLL + fixtures) |
| `docker` | `ubuntu-latest` | `docker compose build` + backend `/docs` healthcheck |
| `desktop / win-x64` | `windows-latest` | PyInstaller + Electron NSIS |
| `desktop / mac-arm64` | `macos-latest` | Unsigned `.dmg` / `.zip` (arm64) |
| `desktop / mac-x64` | `macos-latest` | Unsigned `.dmg` / `.zip` (x64) |
| `desktop / linux-x64` | `ubuntu-latest` | AppImage (libxrk backend) |

**Full desktop matrix runs on every PR** (four parallel installer jobs). Use `workflow_dispatch` inputs `skip_desktop` or `skip_docker` to debug faster.

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

## Branch protection

On `main` (and optionally `Dev`), enable required status checks:

- `test / ubuntu`
- `test / windows`
- `docker`
- `desktop / win-x64`
- `desktop / mac-arm64`
- `desktop / mac-x64`
- `desktop / linux-x64`

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
