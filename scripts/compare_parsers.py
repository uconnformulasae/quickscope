#!/usr/bin/env python3
"""
Compare AiM DLL (primary) vs libxrk (fallback) parser output on XRK fixtures.

Usage (from repo root):
    .venv/Scripts/python.exe scripts/compare_parsers.py path/to/file.xrk
    .venv/Scripts/python.exe scripts/compare_parsers.py path/to/fixtures_dir/
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from parsers import aim_dll, _parse_libxrk  # noqa: E402


def _channel_summary(log) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, table in sorted(log.channels.items()):
        units = ""
        for i in range(table.schema.__len__()):
            field = table.schema.field(i)
            if field.name != "timecodes" and field.metadata:
                units = field.metadata.get(b"units", b"").decode()
        out[name] = {"samples": table.num_rows, "units": units}
    return out


def compare_file(path: Path) -> int:
    print(f"\n=== {path.name} ===")

    if not aim_dll.dll_available():
        print("  AiM DLL not available on this platform — skipping primary comparison")
        log = _parse_libxrk(path)
        print(f"  libxrk only: {len(log.channels)} channels, {log.laps.num_rows} laps")
        return 0

    dll_log = aim_dll.parse(path)
    lib_log = _parse_libxrk(path)

    dll_ch = _channel_summary(dll_log)
    lib_ch = _channel_summary(lib_log)

    only_dll = sorted(set(dll_ch) - set(lib_ch))
    only_lib = sorted(set(lib_ch) - set(dll_ch))
    both = sorted(set(dll_ch) & set(lib_ch))

    print(f"  DLL:   {len(dll_ch)} channels, {dll_log.laps.num_rows} laps")
    print(f"  libxrk: {len(lib_ch)} channels, {lib_log.laps.num_rows} laps")

    if only_dll:
        print(f"  only in DLL ({len(only_dll)}): {only_dll[:8]}{'...' if len(only_dll) > 8 else ''}")
    if only_lib:
        print(f"  only in libxrk ({len(only_lib)}): {only_lib[:8]}{'...' if len(only_lib) > 8 else ''}")

    unit_mismatches = []
    count_mismatches = []
    for name in both:
        if dll_ch[name]["units"] != lib_ch[name]["units"]:
            unit_mismatches.append(
                (name, dll_ch[name]["units"], lib_ch[name]["units"])
            )
        if dll_ch[name]["samples"] != lib_ch[name]["samples"]:
            count_mismatches.append(
                (name, dll_ch[name]["samples"], lib_ch[name]["samples"])
            )

    if unit_mismatches:
        print(f"  unit mismatches ({len(unit_mismatches)}):")
        for name, du, lu in unit_mismatches[:10]:
            print(f"    {name}: DLL={du!r} libxrk={lu!r}")

    if count_mismatches:
        print(f"  sample-count mismatches ({len(count_mismatches)}):")
        for name, dc, lc in count_mismatches[:10]:
            print(f"    {name}: DLL={dc} libxrk={lc}")

    if dll_log.laps.num_rows != lib_log.laps.num_rows:
        print(
            f"  lap count mismatch: DLL={dll_log.laps.num_rows} "
            f"libxrk={lib_log.laps.num_rows}"
        )

    issues = len(unit_mismatches) + len(count_mismatches)
    if dll_log.laps.num_rows != lib_log.laps.num_rows:
        issues += 1
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="XRK/XRZ file or directory")
    args = parser.parse_args()

    paths: list[Path] = []
    if args.path.is_dir():
        paths = sorted(args.path.glob("*.xrk")) + sorted(args.path.glob("*.xrz"))
    elif args.path.is_file():
        paths = [args.path]
    else:
        print(f"Not found: {args.path}", file=sys.stderr)
        return 1

    if not paths:
        print("No .xrk/.xrz files found", file=sys.stderr)
        return 1

    total_issues = sum(compare_file(p) for p in paths)
    print(f"\nDone. {total_issues} issue(s) across {len(paths)} file(s).")
    return 0 if total_issues == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
