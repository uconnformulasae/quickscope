"""
ctypes wrapper for the official AiM Race Studio 3 MatLabXRK DLL.

Windows-only. The DLL is proprietary AiM software — obtain from AiM's RS3
developer package or place at backend/vendor/MatLabXRK-2017-64-ReleaseU.dll.
"""

from __future__ import annotations

import sys
import threading
from ctypes import CDLL, POINTER, Structure, byref, c_char_p, c_double, c_int
from pathlib import Path
from typing import TYPE_CHECKING

from libxrk.base import LogFile

from .log_adapter import dll_to_logfile

if TYPE_CHECKING:
    from collections.abc import Iterator

DEFAULT_DLL_NAME = "MatLabXRK-2017-64-ReleaseU.dll"

# The AiM DLL is not thread-safe — concurrent open/parse calls crash with
# access violations (e.g. load_session + gps-preview racing on the same file).
_parse_lock = threading.Lock()


class AimDllError(Exception):
    """Error from AIM DLL operations."""


class _TimeStruct(Structure):
    """ctypes layout for struct tm returned by get_date_and_time."""

    _fields_ = [
        ("tm_sec", c_int),
        ("tm_min", c_int),
        ("tm_hour", c_int),
        ("tm_mday", c_int),
        ("tm_mon", c_int),
        ("tm_year", c_int),
        ("tm_wday", c_int),
        ("tm_yday", c_int),
        ("tm_isdst", c_int),
    ]


def resolve_dll_path() -> Path | None:
    """Return the first existing DLL path, or None."""
    import os

    candidates: list[Path] = []
    env = os.environ.get("AIM_XRK_DLL")
    if env:
        candidates.append(Path(env))

    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.append(Path(sys._MEIPASS) / DEFAULT_DLL_NAME)

    here = Path(__file__).resolve().parent
    candidates.append(here.parent / "vendor" / DEFAULT_DLL_NAME)
    candidates.append(here / DEFAULT_DLL_NAME)

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def dll_available() -> bool:
    return sys.platform == "win32" and resolve_dll_path() is not None


class AimDll:
    """Pythonic wrapper around MatLabXRK-2017-64-ReleaseU.dll."""

    def __init__(self, dll_path: str | Path | None = None) -> None:
        if dll_path is None:
            resolved = resolve_dll_path()
            if resolved is None:
                raise FileNotFoundError(
                    f"AiM DLL not found ({DEFAULT_DLL_NAME}). "
                    "Place it in backend/vendor/ or set AIM_XRK_DLL."
                )
            dll_path = resolved

        dll_path = Path(dll_path)
        if not dll_path.is_file():
            raise FileNotFoundError(f"AiM DLL not found: {dll_path}")

        self._dll = CDLL(str(dll_path))
        self._setup_functions()
        self._open_files: list[int] = []

    def _setup_functions(self) -> None:
        d = self._dll

        d.open_file.argtypes = [c_char_p]
        d.open_file.restype = c_int

        d.close_file_i.argtypes = [c_int]
        d.close_file_i.restype = None

        d.get_laps_count.argtypes = [c_int]
        d.get_laps_count.restype = c_int

        d.get_lap_info.argtypes = [c_int, c_int, POINTER(c_double), POINTER(c_double)]
        d.get_lap_info.restype = c_int

        d.get_channels_count.argtypes = [c_int]
        d.get_channels_count.restype = c_int

        d.get_channel_name.argtypes = [c_int, c_int]
        d.get_channel_name.restype = c_char_p

        d.get_channel_units.argtypes = [c_int, c_int]
        d.get_channel_units.restype = c_char_p

        d.get_channel_samples_count.argtypes = [c_int, c_int]
        d.get_channel_samples_count.restype = c_int

        d.get_channel_samples.argtypes = [
            c_int,
            c_int,
            POINTER(c_double),
            POINTER(c_double),
            c_int,
        ]
        d.get_channel_samples.restype = c_int

        for name in (
            "get_vehicle_name",
            "get_track_name",
            "get_racer_name",
            "get_championship_name",
            "get_venue_type_name",
        ):
            fn = getattr(d, name)
            fn.argtypes = [c_int]
            fn.restype = c_char_p

        from ctypes import Structure

        d.get_date_and_time.argtypes = [c_int]
        d.get_date_and_time.restype = POINTER(_TimeStruct)

        d.get_GPS_channels_count.argtypes = [c_int]
        d.get_GPS_channels_count.restype = c_int

        d.get_GPS_channel_name.argtypes = [c_int, c_int]
        d.get_GPS_channel_name.restype = c_char_p

        d.get_GPS_channel_units.argtypes = [c_int, c_int]
        d.get_GPS_channel_units.restype = c_char_p

        d.get_GPS_channel_samples_count.argtypes = [c_int, c_int]
        d.get_GPS_channel_samples_count.restype = c_int

        d.get_GPS_channel_samples.argtypes = [
            c_int,
            c_int,
            POINTER(c_double),
            POINTER(c_double),
            c_int,
        ]
        d.get_GPS_channel_samples.restype = c_int

    def __enter__(self) -> AimDll:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close_all()

    def close_all(self) -> None:
        for idx in self._open_files:
            try:
                self._dll.close_file_i(idx)
            except Exception:
                pass
        self._open_files.clear()

    def open_file(self, path: str | Path) -> int:
        path = Path(path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"File not found: {path}")

        idx = self._dll.open_file(str(path).encode("utf-8"))
        if idx <= 0:
            raise AimDllError(f"Failed to open file: {path} (DLL returned {idx})")

        self._open_files.append(int(idx))
        return int(idx)

    def close_file(self, idx: int) -> None:
        self._dll.close_file_i(idx)
        if idx in self._open_files:
            self._open_files.remove(idx)

    def get_laps_count(self, idx: int) -> int:
        return int(self._dll.get_laps_count(idx))

    def get_lap_info(self, idx: int, lap: int) -> tuple[float, float]:
        start = c_double()
        duration = c_double()
        if self._dll.get_lap_info(idx, lap, byref(start), byref(duration)) == 0:
            raise AimDllError(f"Failed to get lap info for lap {lap}")
        return start.value, duration.value

    def get_channels_count(self, idx: int) -> int:
        return int(self._dll.get_channels_count(idx))

    def _decode(self, raw: bytes | None, latin: bool = False) -> str:
        if not raw:
            return ""
        return raw.decode("latin-1" if latin else "utf-8")

    def get_channel_name(self, idx: int, channel: int) -> str:
        return self._decode(self._dll.get_channel_name(idx, channel))

    def get_channel_units(self, idx: int, channel: int) -> str:
        return self._decode(self._dll.get_channel_units(idx, channel))

    def get_channel_samples(self, idx: int, channel: int) -> tuple[list[float], list[float]]:
        count = int(self._dll.get_channel_samples_count(idx, channel))
        if count <= 0:
            return [], []
        times = (c_double * count)()
        values = (c_double * count)()
        result = self._dll.get_channel_samples(idx, channel, times, values, count)
        if result <= 0:
            raise AimDllError(f"Failed to get samples for channel {channel}")
        return list(times), list(values)

    def get_vehicle_name(self, idx: int) -> str:
        return self._decode(self._dll.get_vehicle_name(idx))

    def get_track_name(self, idx: int) -> str:
        return self._decode(self._dll.get_track_name(idx))

    def get_racer_name(self, idx: int) -> str:
        return self._decode(self._dll.get_racer_name(idx))

    def get_championship_name(self, idx: int) -> str:
        return self._decode(self._dll.get_championship_name(idx))

    def get_venue_type_name(self, idx: int) -> str:
        return self._decode(self._dll.get_venue_type_name(idx))

    def get_date_and_time(self, idx: int) -> tuple[str, str]:
        ptr = self._dll.get_date_and_time(idx)
        if not ptr:
            return "", ""
        tm = ptr.contents
        # struct tm: tm_mon is 0-based in C
        date = f"{tm.tm_mday:02d}/{tm.tm_mon + 1:02d}/{tm.tm_year + 1900}"
        time_str = f"{tm.tm_hour:02d}:{tm.tm_min:02d}:{tm.tm_sec:02d}"
        return date, time_str

    def get_GPS_channels_count(self, idx: int) -> int:
        return int(self._dll.get_GPS_channels_count(idx))

    def get_GPS_channel_name(self, idx: int, channel: int) -> str:
        return self._decode(self._dll.get_GPS_channel_name(idx, channel), latin=True)

    def get_GPS_channel_units(self, idx: int, channel: int) -> str:
        return self._decode(self._dll.get_GPS_channel_units(idx, channel), latin=True)

    def get_GPS_channel_samples(self, idx: int, channel: int) -> tuple[list[float], list[float]]:
        count = int(self._dll.get_GPS_channel_samples_count(idx, channel))
        if count <= 0:
            return [], []
        times = (c_double * count)()
        values = (c_double * count)()
        result = self._dll.get_GPS_channel_samples(idx, channel, times, values, count)
        if result <= 0:
            return [], []
        return list(times), list(values)

    def iter_regular_channels(self, idx: int) -> Iterator[tuple[str, str, list[float], list[float]]]:
        for ch in range(self.get_channels_count(idx)):
            name = self.get_channel_name(idx, ch)
            units = self.get_channel_units(idx, ch)
            times, values = self.get_channel_samples(idx, ch)
            yield name, units, times, values

    def iter_gps_channels(self, idx: int) -> Iterator[tuple[str, str, list[float], list[float]]]:
        for ch in range(self.get_GPS_channels_count(idx)):
            name = self.get_GPS_channel_name(idx, ch)
            units = self.get_GPS_channel_units(idx, ch)
            times, values = self.get_GPS_channel_samples(idx, ch)
            yield name, units, times, values


def parse(path: str | Path) -> LogFile:
    """Open path with the AiM DLL and return a libxrk-compatible LogFile."""
    with _parse_lock:
        with AimDll() as dll:
            idx = dll.open_file(path)
            try:
                return dll_to_logfile(dll, idx, str(Path(path).name))
            finally:
                dll.close_file(idx)
