"""Shared helper for the per-session trace files (live view, file download)."""

from __future__ import annotations

from pathlib import Path
from typing import TextIO


def open_unique(directory: Path, name: str) -> tuple[Path, TextIO]:
    """Create ``directory/name`` for writing, never overwriting an existing file.

    Two traces started in the same second share a timestamped name; the second
    gets a ``-1``, ``-2``, ... suffix instead of truncating the first.
    """
    directory.mkdir(parents=True, exist_ok=True)
    base = Path(name)
    for n in range(1000):
        candidate = directory / (base.name if n == 0 else f"{base.stem}-{n}{base.suffix}")
        try:
            return candidate, candidate.open("x", encoding="utf-8")
        except FileExistsError:
            continue
    raise FileExistsError(f"could not create a unique trace file for {name} in {directory}")
