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
FIXTURE_707B = ROOT / "docs" / "protocol" / "captures" / "fixtures" / "live_707b_evo5_follow_raw.txt"


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


def test_707b_snapshot_recovers_trailing_channels() -> None:
    """Regression test: the 113-channel EVO5 sends 707 B `Syst` live frames, not
    691 B. Capping parse_channel_layout() at 691 silently drops any channel
    whose live_offset falls in the tail 16 bytes -- including Pack_Voltage,
    Pack_Current, Min_Cell_Voltage, and BMS_LV_input on this rig.
    """
    assert FIXTURE_707B.is_file()
    _, s2c = load_stream(FIXTURE_707B)
    sframes = parse_frames(s2c, "S")
    layout = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) >= 12000)
    live = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 707)

    fields_691 = parse_channel_layout(layout, live_frame_len=691)
    fields_707 = parse_channel_layout(layout, live_frame_len=707)
    channels_691 = decode_live_channels(live, fields_691)
    channels_707 = decode_live_channels(live, fields_707)

    # The old 691 B cap must not have recovered these tail channels...
    for name in ("Pack_Voltage", "Pack_Current", "Min_Cell_Voltage", "BMS_LV_input"):
        assert name not in channels_691
    # ...but the 707 B cap (matching services.aim_live.LIVE_FRAME_SIZE_113CH) must.
    for name in ("Pack_Voltage", "Pack_Current", "Min_Cell_Voltage", "BMS_LV_input"):
        assert name in channels_707

    # TPS was never affected by the cap (it lives early in the frame) -- confirm
    # both filters still see it so this test targets the tail-drop specifically.
    assert any("TPS" in k for k in channels_691)
    assert any("TPS" in k for k in channels_707)


def test_707b_snapshot_scales_millivolt_channels() -> None:
    """Regression test: BMS aux / raw-ADC "*_Voltage" f32 channels are sent in
    millivolts, unlike Pack_Voltage/Pack_Current which arrive pre-scaled in
    real V/A off the BMS CAN aggregate. Verified against wiresharklivedata.pcapng:
    Min_Cell_Voltage/BMS_LV_input/BSE_Voltage were displaying raw mV (e.g. 4012,
    1100, 490) as if they were already volts.
    """
    _, s2c = load_stream(FIXTURE_707B)
    sframes = parse_frames(s2c, "S")
    layout = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) >= 12000)
    live = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 707)

    fields = parse_channel_layout(layout, live_frame_len=707)
    channels = decode_live_channels(live, fields)

    # Pack_Voltage/Pack_Current are already real units -- must NOT be rescaled.
    assert 370.0 < channels["Pack_Voltage"] < 415.0  # CT-17 EV pack nominal/max
    assert abs(channels["Pack_Current"]) < 5.0

    # Raw-ADC / BMS-aux voltages must be recovered as volts, not millivolts.
    assert 3.0 < channels["Min_Cell_Voltage"] < 4.3  # single Li-ion cell
    assert 0.0 <= channels["BMS_LV_input"] < 30.0
    assert 0.0 <= channels["BSE_Voltage"] < 5.0  # 0-5 V brake sensor pot


def test_707b_snapshot_decodes_bool_state_and_fault_channels() -> None:
    """Regression test: type_code 512/514 channels (state/fault/alarm flags)
    are f32 booleans, not int32 or f64. Two distinct bugs on this rig's 707 B
    frame, both confirmed against wiresharklivedata.pcapng:

    - width=4 flags (Direction, BMS_Disch_Enable, ...) fell through to the
      generic int32 path, so BMS_Disch_Enable's real value (f32 1.0, raw
      bytes 0000803f) decoded as 1065353216 instead of 1.0.
    - width=8 fault/alarm flags (RTD_Fault, HWOverCurrent, ...) were dropped
      entirely by a blanket "width>=8 and type>=512" skip, so none of the
      UI's fault-panel indicators ever populated -- even though the real
      value sits in the first 4 bytes (the other 4 are a constant 0xA5A5A5A5
      firmware fill pattern, identical across every frame in the capture).
    """
    _, s2c = load_stream(FIXTURE_707B)
    sframes = parse_frames(s2c, "S")
    layout = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) >= 12000)
    live = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 707)

    fields = parse_channel_layout(layout, live_frame_len=707)
    channels = decode_live_channels(live, fields)

    # width=4 boolean/state flags decode as clean 0.0/1.0, not int32 garbage.
    assert channels["BMS_Disch_Enable"] in (0.0, 1.0)
    assert channels["Direction"] in (0.0, 1.0)
    assert channels["InverterEnable"] in (0.0, 1.0)

    # width=8 fault/alarm flags are recovered (were previously always absent).
    for name in ("RTD_Fault", "BSE_Fault", "DC_Undervoltage", "HWOverCurrent", "MotorOverTemp"):
        assert channels[name] == 0.0

    # The unmodeled 56 B GPS composite (type 65536) must stay excluded rather
    # than emit a garbage scalar under the "GPS" key.
    assert "GPS" not in channels
