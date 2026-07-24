#!/usr/bin/env python3
"""
Validate QuickScope's AiM DLL parser against Race Studio expectations.

WHERE TO PUT FILES
------------------
Recommended layout (from repo root):

    tests/fixtures/
        my_session.xrk              <- copy your log here
        my_session_rs.csv           <- optional Race Studio CSV export

Naming: reference CSV must be {xrk_stem}_rs.csv in the same folder.

Run from repo root:

    .venv/Scripts/python.exe scripts/validate_dll.py tests/fixtures
    .venv/Scripts/python.exe scripts/validate_dll.py tests/fixtures/my_session.xrk

See tests/fixtures/README.md for full instructions.

QuickScope uses the same MatLabXRK DLL API as Race Studio 3. This script checks
sanity and optionally compares channel values to a Race Studio CSV export.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
sys.path.insert(0, str(REPO_ROOT / "backend"))

from parsers import aim_dll  # noqa: E402
from state import channel_data, extract_session_info  # noqa: E402
from libxrk import ChannelMetadata  # noqa: E402

# RS column name -> DLL channel name (when normalize match is not enough)
_RS_CHANNEL_ALIASES: dict[str, str] = {
    "GPS PosAccuracy": "GPS Position Accuracy",
}

# Channels where the MatLab DLL output is known not to match RS/libxrk (not a unit issue).
_KNOWN_DLL_LIMITATIONS: dict[str, str] = {
    "GPS Altitude": "DLL altitude scale does not match RS/libxrk (known MatLabXRK quirk)",
}


def _expected_reference_path(xrk_path: Path) -> Path:
    return xrk_path.with_name(f"{xrk_path.stem}_rs.csv")


def _print_fixture_help(xrk_path: Path | None = None) -> None:
    print()
    print("  Where to put files (repo root):")
    print(f"    XRK:       {FIXTURES_DIR.relative_to(REPO_ROOT)}/<name>.xrk")
    print(f"    RS CSV:    {FIXTURES_DIR.relative_to(REPO_ROOT)}/<name>_rs.csv")
    if xrk_path is not None:
        ref = _expected_reference_path(xrk_path)
        print()
        print(f"  For {xrk_path.name}, expected reference:")
        print(f"    {ref.relative_to(REPO_ROOT) if ref.is_relative_to(REPO_ROOT) else ref}")
    print()
    print("  More info: tests/fixtures/README.md")
    print()


def _print_fixtures_dir_empty() -> None:
    print(f"No .xrk/.xrz files in {FIXTURES_DIR.relative_to(REPO_ROOT)}/")
    _print_fixture_help()
    print("  Copy a log file there, then re-run:")
    print("    .venv\\Scripts\\python.exe scripts\\validate_dll.py tests\\fixtures")
    print()


_TIME_HEADERS = {"time", "time [s]", "time(s)", "s", "seconds", "t"}


def _is_aim_csv(rows: list[list[str]]) -> bool:
    for row in rows[:5]:
        if len(row) >= 2 and row[0].strip().lower() == "format" and "aim csv" in row[1].lower():
            return True
    return False


def _find_aim_header_row(rows: list[list[str]]) -> int | None:
    for i, row in enumerate(rows):
        if not row:
            continue
        first = row[0].strip().strip('"').lower()
        if first not in _TIME_HEADERS and first != "time":
            continue
        # Session metadata also has a "Time" row (date + clock time) — require channel columns.
        cleaned = [c.strip().strip('"') for c in row]
        if len(cleaned) >= 5 and any(c.startswith("GPS") for c in cleaned[1:]):
            return i
    return None


def _row_looks_like_units(row: list[str]) -> bool:
    if not row:
        return False
    first = row[0].strip().lower()
    return first in _TIME_HEADERS or first == "s"


def _load_aim_reference_csv(
    path: Path,
    *,
    dll_units: dict[str, str] | None = None,
) -> tuple[list[float], dict[str, list[float]], dict[str, str], list[str]]:
    """Parse Race Studio 'AiM CSV File' export (metadata header + units row)."""
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))

    header_idx = _find_aim_header_row(rows)
    if header_idx is None:
        raise ValueError(f"could not find Time column header in AiM CSV: {path}")

    header = [h.strip().strip('"') for h in rows[header_idx]]
    units_row = rows[header_idx + 1] if header_idx + 1 < len(rows) else []
    units = [u.strip().strip('"') for u in units_row] if _row_looks_like_units(units_row) else [""] * len(header)
    data_start = header_idx + (2 if _row_looks_like_units(units_row) else 1)

    time_col = 0
    for i, name in enumerate(header):
        if name.lower() in _TIME_HEADERS or name.lower() == "time":
            time_col = i
            break

    # First occurrence wins when RS duplicates columns (e.g. GPS Speed twice).
    channel_cols: list[int] = []
    seen: set[str] = set()
    unit_by_channel: dict[str, str] = {}
    for i in range(len(header)):
        if i == time_col:
            continue
        name = header[i]
        if not name or name in seen:
            continue
        seen.add(name)
        channel_cols.append(i)
        unit_by_channel[name] = units[i] if i < len(units) else ""

    times: list[float] = []
    columns: dict[str, list[float]] = {header[i]: [] for i in channel_cols}
    converted: list[str] = []
    converted_names: set[str] = set()

    for row in rows[data_start:]:
        if len(row) <= time_col:
            continue
        try:
            t = float(row[time_col].strip().strip('"'))
        except ValueError:
            continue
        times.append(t)
        for i in channel_cols:
            name = header[i]
            cell = row[i].strip().strip('"') if i < len(row) else ""
            try:
                val = float(cell)
            except ValueError:
                val = float("nan")
            rs_unit = unit_by_channel.get(name, "")
            dll_name = _resolve_dll_channel(name, dll_units or {})
            dll_unit = dll_units.get(dll_name, "") if dll_name else ""
            scale = _rs_to_dll_scale(rs_unit, dll_unit, rs_channel=name)
            if scale != 1.0 and name not in converted_names:
                converted_names.add(name)
                converted.append(f"{name} ({rs_unit} -> {dll_unit or '?'})")
            columns[name].append(val * scale)

    return times, columns, unit_by_channel, converted


def _warn_rs_unit_mismatches(unit_by_channel: dict[str, str], dll_units: dict[str, str]) -> None:
    """Print hints when RS export units are known to be wrong for DLL compare."""
    warnings: list[str] = []
    for rs_name, rs_unit in unit_by_channel.items():
        dll_name = _resolve_dll_channel(rs_name, dll_units)
        if dll_name is None:
            continue
        dll_unit = dll_units.get(dll_name, "")
        if rs_name == "LFspeed" and _norm_unit(rs_unit) == "m/s" and _norm_unit(dll_unit) == "km/h":
            warnings.append(
                "LFspeed exported as m/s but DLL is km/h — re-export LFspeed as km/h in Race Studio"
            )
        if rs_name == "GPS SpdAccuracy" and _norm_unit(rs_unit) == "km/h":
            warnings.append(
                "GPS SpdAccuracy unit row still km/h — set export unit to m/s in Race Studio"
            )
    for msg in warnings:
        print(f"  RS unit hint: {msg}")


def _load_reference_csv(
    path: Path,
    *,
    dll_units: dict[str, str] | None = None,
) -> tuple[list[float], dict[str, list[float]]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        peek = list(csv.reader(f))

    if _is_aim_csv(peek):
        times, columns, units, converted = _load_aim_reference_csv(path, dll_units=dll_units)
        if converted:
            print(f"  RS units scaled for DLL compare: {', '.join(converted)}")
        if dll_units:
            _warn_rs_unit_mismatches(units, dll_units)
        return times, columns

    header = [h.strip().strip('"') for h in peek[0]]
    if not header:
        raise ValueError(f"empty CSV: {path}")

    time_col = 0
    for i, name in enumerate(header):
        if name.lower() in _TIME_HEADERS or name.lower().startswith("time"):
            time_col = i
            break

    channel_cols = [i for i in range(len(header)) if i != time_col]
    times: list[float] = []
    columns: dict[str, list[float]] = {header[i]: [] for i in channel_cols}

    for row in peek[1:]:
        if len(row) <= time_col:
            continue
        try:
            t = float(row[time_col].strip().strip('"'))
        except ValueError:
            continue
        times.append(t)
        for i in channel_cols:
            name = header[i]
            cell = row[i].strip().strip('"') if i < len(row) else ""
            try:
                columns[name].append(float(cell))
            except ValueError:
                columns[name].append(float("nan"))

    return times, columns


def _normalize_name(name: str) -> str:
    return name.lower().replace(" ", "").replace("_", "")


def _norm_unit(unit: str) -> str:
    u = unit.strip().lower().replace(" ", "")
    if u in ("°c", "degc", "celsius"):
        return "c"
    if u in ("m/s", "mps"):
        return "m/s"
    if u in ("km/h", "kph", "kmh"):
        return "km/h"
    if u in ("#", ""):
        return "#"
    return u


def _dll_channel_unit(table) -> str:
    for i in range(len(table.schema)):
        field = table.schema.field(i)
        if field.name != "timecodes":
            return ChannelMetadata.from_field(field).units or ""
    return ""


def _dll_units_by_channel(log) -> dict[str, str]:
    return {name: _dll_channel_unit(table) for name, table in log.channels.items()}


def _resolve_dll_channel(rs_name: str, dll_units: dict[str, str]) -> str | None:
    if rs_name in dll_units:
        return rs_name
    norm = _normalize_name(rs_name)
    for dll_name in dll_units:
        if _normalize_name(dll_name) == norm:
            return dll_name
    for alias, mapped in _RS_CHANNEL_ALIASES.items():
        if _normalize_name(alias) == norm and mapped in dll_units:
            return mapped
    return None


def _rs_to_dll_scale(rs_unit: str, dll_unit: str, *, rs_channel: str) -> float:
    """Multiply RS CSV values by this factor to match DLL channel units."""
    rs_u = _norm_unit(rs_unit)
    dll_u = _norm_unit(dll_unit)

    if rs_u == dll_u:
        return 1.0

    if rs_u == "km/h" and dll_u == "m/s":
        return 1.0 / 3.6
    # Race Studio m/s export for LFspeed does not match DLL km/h values — export km/h instead.
    if rs_channel == "LFspeed" and rs_u == "m/s" and dll_u == "km/h":
        return 1.0
    if rs_u == "m/s" and dll_u == "km/h":
        return 3.6

    # RS exports mm; DLL stores centimeters for this channel (metadata is '#').
    if rs_channel == "GPS PosAccuracy" and rs_u == "mm":
        return 0.1

    if rs_u == "mm" and dll_u == "m":
        return 0.001
    if rs_u == "m" and dll_u == "mm":
        return 1000.0

    # RS unit row may still say km/h while values are already m/s.
    if rs_channel == "GPS SpdAccuracy" and rs_u == "km/h" and dll_u == "#":
        return 1.0

    return 1.0


def _is_rs_sentinel(value: float) -> bool:
    return math.isfinite(value) and abs(value) >= 9999.0


def _channels_for_compare(dll_channels: dict, explicit: list[str] | None) -> list[str]:
    if explicit:
        return [c for c in explicit if c in dll_channels]
    return sorted(dll_channels.keys())


def _resolve_ref_column(dll_name: str, ref_cols: dict[str, list[float]]) -> str | None:
    if dll_name in ref_cols:
        return dll_name
    lower = {k.lower(): k for k in ref_cols}
    if dll_name.lower() in lower:
        return lower[dll_name.lower()]
    norm_dll = _normalize_name(dll_name)
    for rs_name in ref_cols:
        if _normalize_name(rs_name) == norm_dll:
            return rs_name
    for rs_name, mapped in _RS_CHANNEL_ALIASES.items():
        if mapped == dll_name and rs_name in ref_cols:
            return rs_name
        if _normalize_name(mapped) == norm_dll and rs_name in ref_cols:
            return rs_name
    return None


def _nearest_value(timestamps: list[float], values: list[float], t_ms: float) -> float | None:
    if not timestamps:
        return None
    t = float(t_ms)
    if t <= timestamps[0]:
        return values[0]
    if t >= timestamps[-1]:
        return values[-1]
    lo, hi = 0, len(timestamps) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if timestamps[mid] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = timestamps[lo], timestamps[hi]
    if t1 == t0:
        return values[lo]
    frac = (t - t0) / (t1 - t0)
    return values[lo] + frac * (values[hi] - values[lo])


def _compare_channel(
    name: str,
    dll_ts: list[float],
    dll_vals: list[float],
    ref_times_s: list[float],
    ref_vals: list[float],
    *,
    atol: float,
    rtol: float,
    sample_stride: int,
) -> dict | None:
    if not ref_times_s:
        return None

    errors: list[float] = []
    checked = 0
    for i in range(0, len(ref_times_s), max(1, sample_stride)):
        rv = ref_vals[i]
        if not math.isfinite(rv) or _is_rs_sentinel(rv):
            continue
        t_ms = ref_times_s[i] * 1000.0
        dv = _nearest_value(dll_ts, dll_vals, t_ms)
        if dv is None or not math.isfinite(dv):
            continue
        err = abs(dv - rv)
        if err > atol + rtol * abs(rv):
            errors.append(err)
        checked += 1

    if checked == 0:
        return {"name": name, "status": "skip", "reason": "no overlapping samples"}

    max_err = max(errors) if errors else 0.0
    return {
        "name": name,
        "status": "fail" if errors else "ok",
        "checked": checked,
        "mismatches": len(errors),
        "max_abs_error": max_err,
    }


def _sanity_check(log, info: dict) -> list[str]:
    issues: list[str] = []
    if info["durationMs"] <= 0:
        issues.append("durationMs is zero")
    if not log.channels:
        issues.append("no channels parsed")

    if "GPS Speed" in log.channels:
        cd = channel_data("GPS Speed", log.channels["GPS Speed"])
        ts, vals = cd["timestamps"], cd["values"]
        if ts and max(ts) > info["durationMs"] * 1.05:
            issues.append(
                f"GPS Speed max timestamp {max(ts)} exceeds duration {info['durationMs']}"
            )
        dts = [ts[i + 1] - ts[i] for i in range(min(100, len(ts) - 1))]
        if dts and min(d for d in dts if d > 0) > 50:
            issues.append(f"GPS Speed sample interval looks sparse (min dt={min(dts)} ms)")
        vmax = max(vals) if vals else 0
        if vmax > 120:
            issues.append(f"GPS Speed max {vmax:.1f} m/s looks unrealistic")

    return issues


def validate_file(
    path: Path,
    *,
    reference: Path | None,
    channels: list[str] | None,
    atol: float,
    rtol: float,
    stride: int,
    verbose: bool,
) -> int:
    print(f"\n=== {path.name} ===")
    if not aim_dll.dll_available():
        print("  ERROR: AiM DLL not available (Windows + backend/vendor/*.dll required)")
        return 1

    log = aim_dll.parse(path)
    info = extract_session_info(log, path.name)
    print(f"  channels: {len(log.channels)}, laps: {info['lapCount']}, duration: {info['durationMs']/1000:.1f}s")
    if info.get("recordedAt"):
        print(f"  recordedAt: {info['recordedAt']}")

    issues = 0
    sanity = _sanity_check(log, info)
    if sanity:
        issues += len(sanity)
        print(f"  sanity issues ({len(sanity)}):")
        for msg in sanity:
            print(f"    - {msg}")
    else:
        print("  sanity: ok")

    check_channels = _channels_for_compare(log.channels, channels)
    if channels:
        missing = [c for c in channels if c not in log.channels]
        if missing:
            print(f"  channels not in XRK: {missing}")
    else:
        print(f"  comparing all {len(check_channels)} DLL channels vs RS CSV")

    if reference is None:
        ref_path = _expected_reference_path(path)
        if ref_path.is_file():
            reference = ref_path
            rel = ref_path.relative_to(REPO_ROOT) if ref_path.is_relative_to(REPO_ROOT) else ref_path
            print(f"  reference: auto-found {rel}")
        else:
            print("  reference: none (sanity-only; value compare skipped)")
            rel = ref_path.relative_to(REPO_ROOT) if ref_path.is_relative_to(REPO_ROOT) else ref_path
            print(f"  To compare vs Race Studio, export CSV to: {rel}")
            return issues

    if not reference.is_file():
        print(f"  ERROR: reference not found: {reference}")
        return issues + 1

    ref_times, ref_cols = _load_reference_csv(reference, dll_units=_dll_units_by_channel(log))
    print(f"  reference: {reference.name} ({len(ref_times)} rows, {len(ref_cols)} columns)")

    ok_count = 0
    fail_count = 0
    skip_no_ref = 0
    skip_no_data = 0
    skip_known = 0
    failures: list[str] = []
    rs_only: list[str] = []
    known_limitations: list[str] = []

    matched_rs: set[str] = set()
    for name in check_channels:
        if name in _KNOWN_DLL_LIMITATIONS:
            skip_known += 1
            known_limitations.append(f"  {name}: skipped — {_KNOWN_DLL_LIMITATIONS[name]}")
            if verbose:
                print(f"  {name}: skipped — {_KNOWN_DLL_LIMITATIONS[name]}")
            continue

        ref_name = _resolve_ref_column(name, ref_cols)
        if ref_name is None:
            skip_no_ref += 1
            if verbose:
                print(f"  {name}: no matching RS column — skip")
            continue

        matched_rs.add(ref_name)
        cd = channel_data(name, log.channels[name])
        if not cd["timestamps"]:
            skip_no_data += 1
            if verbose:
                print(f"  {name}: empty in DLL — skip")
            continue

        result = _compare_channel(
            name,
            cd["timestamps"],
            cd["values"],
            ref_times,
            ref_cols[ref_name],
            atol=atol,
            rtol=rtol,
            sample_stride=stride,
        )
        if result is None:
            skip_no_data += 1
            continue
        if result["status"] == "skip":
            skip_no_data += 1
            if verbose:
                print(f"  {name}: {result['reason']}")
            continue
        if result["status"] == "ok":
            ok_count += 1
            if verbose:
                print(f"  {name}: ok ({result['checked']} samples)")
        else:
            fail_count += 1
            issues += 1
            msg = (
                f"  {name}: MISMATCH {result['mismatches']}/{result['checked']} samples "
                f"(max abs err {result['max_abs_error']:.6g})"
            )
            failures.append(msg)

    for rs_name in sorted(ref_cols):
        if rs_name not in matched_rs:
            rs_only.append(rs_name)

    print(
        f"  compare summary: {ok_count} ok, {fail_count} fail, "
        f"{skip_no_ref} no RS column, {skip_no_data} no samples"
        + (f", {skip_known} known DLL limits" if skip_known else "")
    )
    for msg in known_limitations:
        print(msg)
    for msg in failures:
        print(msg)
    if rs_only:
        print(f"  RS-only columns (no DLL channel matched): {len(rs_only)}")
        if verbose:
            for name in rs_only:
                print(f"    - {name}")

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate AiM DLL parser output (see tests/fixtures/README.md).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
File locations (relative to repo root):
  XRK logs:     {FIXTURES_DIR.relative_to(REPO_ROOT)}/<session>.xrk
  RS reference: {FIXTURES_DIR.relative_to(REPO_ROOT)}/<session>_rs.csv

Examples:
  python scripts/validate_dll.py tests/fixtures
  python scripts/validate_dll.py tests/fixtures/my_session.xrk
  python scripts/validate_dll.py tests/fixtures/my_session.xrk -r tests/fixtures/my_session_rs.csv
""",
    )
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=FIXTURES_DIR,
        help=f"XRK file or directory (default: {FIXTURES_DIR.relative_to(REPO_ROOT)})",
    )
    parser.add_argument("--reference", "-r", type=Path, help="Race Studio CSV (default: <xrk_stem>_rs.csv beside XRK)")
    parser.add_argument("--show-paths", action="store_true", help="Print where to put fixture files and exit")
    parser.add_argument(
        "--channels",
        nargs="*",
        default=None,
        metavar="NAME",
        help="Only these channels (default: all DLL channels with a matching RS column)",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Print per-channel ok/skip lines")
    parser.add_argument("--atol", type=float, default=0.01, help="Absolute tolerance per sample")
    parser.add_argument("--rtol", type=float, default=0.001, help="Relative tolerance per sample")
    parser.add_argument("--stride", type=int, default=10, help="Check every Nth reference row")
    args = parser.parse_args()

    if args.show_paths:
        _print_fixture_help()
        return 0

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    paths: list[Path] = []
    if args.path.is_dir():
        paths = sorted(args.path.glob("*.xrk")) + sorted(args.path.glob("*.xrz"))
    elif args.path.is_file():
        paths = [args.path]
    else:
        print(f"Not found: {args.path}", file=sys.stderr)
        if args.path == FIXTURES_DIR:
            _print_fixture_help()
        return 1

    if not paths:
        if args.path.resolve() == FIXTURES_DIR.resolve():
            _print_fixtures_dir_empty()
        else:
            print(f"No .xrk/.xrz files in {args.path}", file=sys.stderr)
        return 1

    total = sum(
        validate_file(
            p,
            reference=args.reference,
            channels=args.channels if args.channels else None,
            atol=args.atol,
            rtol=args.rtol,
            stride=args.stride,
            verbose=args.verbose,
        )
        for p in paths
    )
    print(f"\nDone. {total} issue(s) across {len(paths)} file(s).")
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
