# Continuous Integration

QuickScope uses **GitHub-hosted runners** for all CI workflows.

## Workflows

| Workflow | Runner | When | Purpose |
|----------|--------|------|---------|
| [test.yml](../.github/workflows/test.yml) | `ubuntu-latest` | PR, push `main`/`Dev` | Unit tests + TypeScript (`pytest -m "not dll and not libxrk"`, `npm run check`) |
| [libxrk-regression.yml](../.github/workflows/libxrk-regression.yml) | `ubuntu-latest` | PR, push `main`/`Dev` | libxrk parser in Docker (`pytest -m libxrk`) |
| [dll-regression.yml](../.github/workflows/dll-regression.yml) | `windows-latest` | PR, push `main`/`Dev` | DLL parser vs Race Studio CSV (`pytest -m dll`) |
| [docker.yml](../.github/workflows/docker.yml) | `ubuntu-latest` | PR, push `main`/`Dev` | `docker compose build` + backend healthcheck |
| [smoke.yml](../.github/workflows/smoke.yml) | `macos-14` + `windows-latest` | PR, push `main` | Unsigned Electron installers |
| [release.yml](../.github/workflows/release.yml) | `macos-14` / `macos-13` + `windows-latest` | `v*.*.*` tags | Release artifacts |

`test.yml`, `libxrk-regression.yml`, and `dll-regression.yml` are **independent** — separate workflows with separate concurrency groups.

## Parser fixtures release (required once)

DLL and libxrk regression need a real `.xrk` in `tests/fixtures/`. Those files are **gitignored** (large binaries), so CI downloads them from the **`fixtures-v1`** GitHub Release.

If CI fails with `release not found`, publish the release once from a machine that already has the fixture pair:

```powershell
gh auth login
.\scripts\publish_fixtures_release.ps1
```

Required local files:

- `tests/fixtures/endurance_CT16-EV_Standardized_a_5816.xrk`
- `tests/fixtures/endurance_CT16-EV_Standardized_a_5816_rs.csv`

If the release already exists, the script re-uploads assets with `--clobber`.

The setup action skips the download when `.xrk`/`.xrz` files are already present in `tests/fixtures/` (e.g. local checkout with fixtures copied in).

**Docker note:** libxrk regression runs **inside** the backend Docker image (same Linux + libxrk stack as `docker compose up`). DLL regression still uses `windows-latest` — the AiM DLL cannot run in Linux containers.

DLL jobs also clone the MatLabXRK DLL from [laz-/xrk](https://github.com/laz-/xrk) on `windows-latest`.

## Branch protection

On `main` (and optionally `Dev`), enable required status checks:

- `test` (job name in test.yml)
- `libxrk-regression` (job name in libxrk-regression.yml)
- `dll-regression` (job name in dll-regression.yml)
- `smoke / smoke` jobs (optional but recommended)

## Local commands

```powershell
npm run test          # unit regression (no DLL, no libxrk fixtures)
npm run test:libxrk   # libxrk parser on XRK fixtures (no DLL)
npm run test:dll      # DLL integration (Windows + fixtures)
npm run check         # TypeScript only

.venv\Scripts\python.exe scripts\validate_dll.py tests\fixtures
```
