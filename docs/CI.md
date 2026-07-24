# Continuous Integration

QuickScope uses GitHub Actions with a **self-hosted Windows runner** for regression and Windows builds. macOS installer jobs use GitHub-hosted runners (`macos-14` / `macos-13`).

## Workflows

| Workflow | Runner | When | Purpose |
|----------|--------|------|---------|
| [test.yml](../.github/workflows/test.yml) | Self-hosted Windows | PR, push `main`/`Dev` | Unit tests + TypeScript (`pytest -m "not dll"`, `npm run check`) |
| [dll-regression.yml](../.github/workflows/dll-regression.yml) | Self-hosted Windows | PR, push `main`/`Dev` | DLL parser vs Race Studio CSV (`pytest -m dll`) |
| [libxrk-regression.yml](../.github/workflows/libxrk-regression.yml) | Self-hosted Windows | PR, push `main`/`Dev` | libxrk fallback parser (`pytest -m libxrk`) |
| [smoke.yml](../.github/workflows/smoke.yml) | Self-hosted Win + hosted Mac | PR, push `main` | Unsigned Electron installers |
| [release.yml](../.github/workflows/release.yml) | Self-hosted Win + hosted Mac | `v*.*.*` tags | Release artifacts |

`test.yml`, `dll-regression.yml`, and `libxrk-regression.yml` are **independent** — separate workflows with separate concurrency groups.

## Self-hosted runner setup (one-time)

1. On a Windows x64 machine, install **Python 3.12**, **Node 20**, and **Git**.
2. Install [GitHub CLI](https://cli.github.com/) (`gh`) for fixture download steps.
3. In the repo on GitHub: **Settings → Actions → Runners → New self-hosted runner** → Windows → follow the configure script.
4. When prompted for labels, ensure these are present:
   - `self-hosted`
   - `Windows`
   - `X64`
   - `quickscope`

The runner can be your dev machine; jobs queue when it is offline.

### Optional CI cache

Workflows cache large binaries under `C:\quickscope-ci-cache\` to avoid re-downloading every run:

```
C:\quickscope-ci-cache\
  fixtures\     # .xrk + *_rs.csv from fixtures-v1 release
  dll\          # MatLabXRK-2017-64-ReleaseU.dll from laz-/xrk
```

Delete this folder to force a fresh download.

## Parser fixtures release

DLL regression downloads fixtures from the **`fixtures-v1`** GitHub Release (not git). Publish once after `gh auth login`:

```powershell
.\scripts\publish_fixtures_release.ps1
```

If the release already exists, the script re-uploads assets with `--clobber`.

## Branch protection

On `main` (and optionally `Dev`), enable required status checks:

- `test` (job name in test.yml)
- `dll-regression` (job name in dll-regression.yml)
- `libxrk-regression` (job name in libxrk-regression.yml)
- `smoke / smoke` jobs (optional but recommended)

## Local commands

```powershell
npm run test          # unit regression (no DLL, no libxrk fixtures)
npm run test:libxrk   # libxrk parser on XRK fixtures (no DLL)
npm run test:dll      # DLL integration (Windows + fixtures)
npm run check         # TypeScript only

.venv\Scripts\python.exe scripts\validate_dll.py tests\fixtures
```
