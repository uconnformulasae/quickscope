"""Streaming CSV export for parsed XRK logs."""

from __future__ import annotations

import csv
import io
import json
import math
from typing import Iterable

import numpy as np
from fastapi.responses import StreamingResponse

from sanitize import MAX_UNIT_LEN, clean_text, csv_safe_cell
from state import channel_arrays, channel_meta
from services.xrk_export import content_disposition, quickscope_export_basename

_EXPORT_CHUNK_ROWS = 5000


def parse_conversions(convert: str | None) -> dict[str, tuple[str, float, float]]:
    """Parse the ``convert`` query param: JSON ``{name: {"unit", "scale", "offset"}}``.

    Raises ``ValueError`` when it is malformed.
    """
    conversions: dict[str, tuple[str, float, float]] = {}
    if not convert:
        return conversions
    try:
        parsed = json.loads(convert)
        if not isinstance(parsed, dict):
            raise ValueError
        for cname, spec in parsed.items():
            unit = clean_text(str(spec["unit"]), max_len=MAX_UNIT_LEN, truncate=True)
            scale, offset = float(spec["scale"]), float(spec.get("offset", 0.0))
            if not (math.isfinite(scale) and math.isfinite(offset)):
                raise ValueError("non-finite conversion")
            conversions[cname] = (unit, scale, offset)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ValueError("Malformed convert parameter") from exc
    return conversions


def parse_export_query(
    channels: str, convert: str | None,
) -> tuple[list[str], dict[str, tuple[str, float, float]]]:
    """Channel names and conversions from the export routes' ``channels``/``convert`` params.

    Raises ``ValueError`` (with a user-facing message) when either is unusable.
    """
    conversions = parse_conversions(convert)
    names = [n.strip() for n in channels.split(",") if n.strip()]
    if not names:
        raise ValueError("No channels specified")
    return names, conversions


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
    conversions: dict[str, tuple[str, float, float]] | None = None,
) -> StreamingResponse:
    """Build a streaming CSV download for ``channel_names`` from a parsed log.

    ``conversions`` maps channel name -> ``(unit, scale, offset)``; matching
    columns are written as ``value * scale + offset`` under ``unit``.
    """
    names = [n.strip() for n in channel_names if n and n.strip()]
    ch_data = {}
    for name in names:
        if name in log.channels:
            ts, vals = channel_arrays(name, log.channels[name])
            finite = np.isfinite(vals)  # sensor dropouts are not exported
            ch_data[name] = {"timestamps": ts[finite], "values": vals[finite]}

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
    for idx, name in enumerate(ch_data):
        if conversions and name in conversions:
            unit, scale, offset = conversions[name]
            columns[idx] = columns[idx] * scale + offset
            units_map[name] = unit

    def _csv_chunks():
        output = io.StringIO()
        writer = csv.writer(output)
        headers = ["Time (s)"]
        for name in ch_data:
            u = units_map.get(name, "")
            headers.append(f"{name} ({u})" if u else name)
        # Channel names and units come from the XRK file or the request; a
        # leading "=" would run as a formula when the CSV is opened in Excel.
        writer.writerow([csv_safe_cell(h) for h in headers])

        # Format a whole chunk per column, then zip into rows: indexing numpy
        # scalars one cell at a time costs millions of calls on a long session.
        for start in range(0, len(timebase), _EXPORT_CHUNK_ROWS):
            stop = start + _EXPORT_CHUNK_ROWS
            cells = [[f"{ts / 1000:.6f}" for ts in timebase[start:stop].tolist()]]
            for col in columns:
                cells.append([f"{v:.5f}" if v == v else "" for v in col[start:stop].tolist()])
            writer.writerows(zip(*cells))
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
        headers={"Content-Disposition": content_disposition(f"{basename}_export.csv")},
    )
