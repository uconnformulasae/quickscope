"""Tests for AiM live snapshot decoding from channel-layout blobs."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "docs" / "protocol" / "captures"))

from parse_aim_stream import load_stream, parse_frames  # noqa: E402
from services.aim_live_layout import decode_live_channels, parse_channel_layout  # noqa: E402

FIXTURE = ROOT / "docs" / "protocol" / "captures" / "fixtures" / "live_2026_follow_raw.txt"


def test_live_fixture_decodes_channels_from_layout() -> None:
    assert FIXTURE.is_file()
    _, s2c = load_stream(FIXTURE)
    sframes = parse_frames(s2c, "S")
    layout = next(
        f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 15060
    )
    live = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 691)
    fields = parse_channel_layout(layout, live_frame_len=691)
    assert len(fields) >= 50
    channels = decode_live_channels(live, fields)
    assert len(channels) >= 10
