"""Recent AiM device reachability — shared by session pull and live streaming.

Race Studio probes once when you select the logger, then reuses that identity
for live data and downloads. QuickScope mirrors that: any successful UDP
discovery or TCP session listing refreshes this cache so live WebSocket
connect can skip a redundant UDP round-trip.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

_DEFAULT_MAX_AGE_S = 120.0

_lock = threading.Lock()
_cached: "_CachedDevice | None" = None


@dataclass(frozen=True)
class CachedDevice:
    ip: str
    model: str = ""
    serial: str = ""
    vehicle: str = ""
    device_name: str = ""
    ssid: str = ""
    updated_monotonic: float = 0.0

    def age_s(self) -> float:
        return time.monotonic() - self.updated_monotonic


def record_from_parsed(info: dict[str, Any]) -> None:
    """Record fields from ``parse_discovery_text`` / ``discover_device``."""
    ip = str(info.get("ip") or "").strip()
    if not ip:
        return
    entry = CachedDevice(
        ip=ip,
        model=str(info.get("model") or ""),
        serial=str(info.get("serial") or ""),
        vehicle=str(info.get("vehicle") or ""),
        device_name=str(info.get("device_name") or ""),
        ssid=str(info.get("ssid") or ""),
        updated_monotonic=time.monotonic(),
    )
    with _lock:
        global _cached
        _cached = entry


def record_tcp_device(ip: str) -> None:
    """Refresh IP (and timestamp) after a successful TCP connect to port 2000."""
    ip = ip.strip()
    if not ip:
        return
    with _lock:
        global _cached
        now = time.monotonic()
        if _cached is not None and _cached.ip == ip:
            _cached = CachedDevice(
                ip=_cached.ip,
                model=_cached.model,
                serial=_cached.serial,
                vehicle=_cached.vehicle,
                device_name=_cached.device_name,
                ssid=_cached.ssid,
                updated_monotonic=now,
            )
        else:
            _cached = CachedDevice(ip=ip, updated_monotonic=now)


def record_identity(ip: str, *, model: str = "", serial: str = "", vehicle: str = "") -> None:
    with _lock:
        global _cached
        _cached = CachedDevice(
            ip=ip,
            model=model,
            serial=serial,
            vehicle=vehicle,
            device_name=_cached.device_name if _cached and _cached.ip == ip else "",
            ssid=_cached.ssid if _cached and _cached.ip == ip else "",
            updated_monotonic=time.monotonic(),
        )


def get_cached(*, max_age_s: float = _DEFAULT_MAX_AGE_S) -> CachedDevice | None:
    with _lock:
        entry = _cached
    if entry is None:
        return None
    if entry.age_s() > max_age_s:
        return None
    return entry


def clear_cache_for_tests() -> None:
    with _lock:
        global _cached
        _cached = None
