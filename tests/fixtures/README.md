# Parser validation fixtures

Put test files here so `scripts/validate_dll.py` can find them.

## Directory layout

```
tests/fixtures/
├── README.md                          ← this file
├── my_session.xrk                       ← your AiM log file
└── my_session_rs.csv                    ← Race Studio CSV export (optional, for value compare)
```

**Naming rule:** reference CSV must be `{same_name_as_xrk}_rs.csv`

| XRK file | Reference CSV (from Race Studio) |
|----------|----------------------------------|
| `endurance_CT16.xrk` | `endurance_CT16_rs.csv` |
| `pid_testing.xrk` | `pid_testing_rs.csv` |

You can also validate a single file anywhere on disk — the `_rs.csv` suffix rule still
applies if the CSV sits in the same folder as the XRK.

## Step by step

### 1. Copy your XRK here

```text
tests/fixtures/endurance_CT16-EV_Standardized_a_5816.xrk
```

XRK files are gitignored (they are large). This folder is for **local** validation only
unless you use Git LFS.

### 2. (Optional) Export reference CSV from Race Studio 3

1. Open the same `.xrk` in **Race Studio 3**.
2. Export channels to CSV with **session-relative time in seconds**.
3. Include columns you want to compare, e.g. `GPS Speed`, `RPM`.
4. Save as:

```text
tests/fixtures/endurance_CT16-EV_Standardized_a_5816_rs.csv
```

First CSV column must be time (`Time`, `Time [s]`, or `s`). Other columns use exact
channel names from the log.

### Race Studio export units (DLL compare)

Match these units in Race Studio when exporting the reference CSV. QuickScope's
validator scales RS values to DLL units when they differ.

| Channel | Export unit in RS | DLL unit | Notes |
|---------|-------------------|----------|-------|
| GPS Speed | **m/s** | m/s | |
| LFspeed | **km/h** | km/h | Do not export as m/s — RS rescales the values incorrectly |
| GPS PosAccuracy | **mm** | (internal cm) | Validator converts mm → cm automatically |
| GPS SpdAccuracy | **m/s** | `#` | Unit row may still say km/h; values should be m/s |
| GPS Altitude | m | m | DLL altitude does not match RS (known MatLabXRK limitation) |

Other channels generally match when the RS units row matches the log channel units.

### 3. Run validation (from repo root)

Sanity only (no Race Studio export needed):

```powershell
.venv\Scripts\python.exe scripts\validate_dll.py tests/fixtures
```

With a paired `_rs.csv`, compares **all 102 DLL channels** against matching RS columns by default:

```powershell
.venv\Scripts\python.exe scripts\validate_dll.py tests/fixtures
```

Add `-v` to print every ok/skip line. Limit to specific channels with `--channels "GPS Speed" "RPM"`.

The script auto-finds `*_rs.csv` in the same directory when the names match.

## CI regression

DLL regression runs in GitHub Actions on a **self-hosted Windows runner** (`dll-regression.yml`). It downloads fixtures from the **`fixtures-v1`** release and the MatLabXRK DLL from [laz-/xrk](https://github.com/laz-/xrk).

**libxrk fallback** regression is a separate workflow (`libxrk-regression.yml`) — same fixtures, no DLL, no Race Studio CSV. Force locally with `QUICKSCOPE_PARSER=libxrk` or `npm run test:libxrk`.

To publish or refresh CI fixtures (requires `gh auth login`):

```powershell
.\scripts\publish_fixtures_release.ps1
```

Or manually:

```powershell
gh release create fixtures-v1 `
  tests/fixtures/endurance_CT16-EV_Standardized_a_5816.xrk `
  tests/fixtures/endurance_CT16-EV_Standardized_a_5816_rs.csv `
  --title "Parser regression fixtures v1"
```

See [docs/CI.md](../../docs/CI.md) for runner setup and branch protection.

## Requirements

- **Windows** with `backend/vendor/MatLabXRK-2017-64-ReleaseU.dll` (see `backend/vendor/README.md`)
- Same DLL generation as your Race Studio install when doing CSV compare

## Other locations

| Purpose | Path |
|---------|------|
| Validation fixtures (recommended) | `tests/fixtures/` |
| App session cache (upload/browser) | `data/sessions/` (gitignored) |
| DLL binary | `backend/vendor/MatLabXRK-2017-64-ReleaseU.dll` (gitignored) |
