"""Streaming CSV export for parsed XRK logs."""

from __future__ import annotations

import csv
import io
from typing import Iterable

import numpy as np
from fastapi.responses import StreamingResponse

from state import channel_data, channel_meta
from services.xrk_export import quickscope_export_basename

_EXPORT_CHUNK_ROWS = 5000


def _interp_on_timebase(timestamps, values, timebase):
    """Linear interpolation of one channel onto ``timebase`` (sorted, ms)."""
    ts = np.asarray(timestamps, dtype=np.float64)
    vs = np.asarray(values, dtype=np.float64)
    out = np.full(len(timebase), np.nan)
    if len(ts) == 0:
        return out
    inside = (timebase >= ts[0]) & (timebase <= ts[-1])
    if len(ts) == 1:
        out[inside] = vs[0]
        return out
    t = timebase[inside]
    hi = np.clip(np.searchsorted(ts, t, side="right"), 1, len(ts) - 1)
    lo = hi - 1
    dt = ts[hi] - ts[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.where(dt > 0, (t - ts[lo]) / dt, 1.0)
    out[inside] = vs[lo] + frac * (vs[hi] - vs[lo])
    return out


def streaming_csv_response(
    log,
    filename: str | None,
    channel_names: Iterable[str],
    aim_session_id: str | None = None,
) -> StreamingResponse:
    """Build a streaming CSV download for ``channel_names`` from a parsed log."""
    names = [n.strip() for n in channel_names if n and n.strip()]
    ch_data = {}
    for name in names:
        if name in log.channels:
            ch_data[name] = channel_data(name, log.channels[name], drop_gaps=True)

    if not ch_data:
        raise ValueError("None of the specified channels found")

    timebase = np.unique(np.concatenate([
        np.asarray(cd["timestamps"], dtype=np.float64) for cd in ch_data.values()
    ]))

    units_map = {}
    for name in ch_data:
        if name in log.channels:
            cm = channel_meta(name, log.channels[name])
            units_map[name] = cm["units"]

    columns = [
        _interp_on_timebase(cd["timestamps"], cd["values"], timebase)
        for cd in ch_data.values()
    ]

    def _csv_chunks():
        output = io.StringIO()
        writer = csv.writer(output)
        headers = ["Time (s)"]
        for name in ch_data:
            u = units_map.get(name, "")
            headers.append(f"{name} ({u})" if u else name)
        writer.writerow(headers)

        for start in range(0, len(timebase), _EXPORT_CHUNK_ROWS):
            stop = start + _EXPORT_CHUNK_ROWS
            for i, ts in enumerate(timebase[start:stop].tolist(), start):
                row = [f"{ts / 1000:.6f}"]
                for col in columns:
                    val = col[i]
                    row.append(f"{val:.5f}" if val == val else "")
                writer.writerow(row)
            yield output.getvalue().encode("utf-8")
            output.seek(0)
            output.truncate(0)
        tail = output.getvalue()
        if tail:
            yield tail.encode("utf-8")

    basename = quickscope_export_basename(filename, aim_session_id)

    return StreamingResponse(
        _csv_chunks(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{basename}_export.csv"'},
    )
