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
FIXTURE_IC = ROOT / "docs" / "protocol" / "captures" / "fixtures" / "live_ic_494b_follow_raw.txt"


def _layout_and_live(fixture: Path, live_len: int) -> tuple[list, bytes]:
    _, s2c = load_stream(fixture)
    sframes = parse_frames(s2c, "S")
    layout = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) >= 11000)
    live = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == live_len)
    return parse_channel_layout(layout, live_frame_len=1 << 16), live


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


def test_two_byte_channels_are_half_floats_on_both_cars() -> None:
    """Regression test: 2-byte type 2/6 channels are IEEE f16, not int16.
    Read as int16 (x0.0001 for type 6, x0.001 for "*Voltage"), a parked car
    showed -2.4 g lateral / -1.74 g vertical, a 29.2 V External Voltage and a
    20008 C logger. As f16 the IMU reads gravity on Z only."""
    for fixture, live_len in ((FIXTURE_707B, 707), (FIXTURE_IC, 494)):
        fields, live = _layout_and_live(fixture, live_len)
        ch = decode_live_channels(live, fields)
        assert -1.05 < ch["VerticalAcc"] < -0.95, fixture.name
        assert abs(ch["LateralAcc"]) < 0.2 and abs(ch["InlineAcc"]) < 0.2, fixture.name
        assert abs(ch["YawRate"]) < 2.0, fixture.name
        # +104 in the record is the display range minimum (-99.9), not an offset.
        assert 10.0 < ch["Logger Temperature"] < 45.0, fixture.name
        assert 11.0 < ch["External Voltage"] < 15.0, fixture.name


def test_channel_units_come_from_the_layout_quantity_code() -> None:
    fields, live = _layout_and_live(FIXTURE_IC, 494)
    units = {f.name: f.unit for f in fields}
    assert units["VerticalAcc"] == "g"
    assert units["YawRate"] == "°/s"
    assert units["S8_RPM"] == "rpm"
    assert units["S8_map1"] == "bar"
    assert units["S8_ect1"] == "°C"
    assert units["S8_tps1"] == "%"
    assert units["S8_vbat"] == "V"
    assert units["S8_lfSpeed"] == "km/h"
    assert units["S8_gear"] == ""

    # Quantity 0x15 voltages arrive in mV and are shown in V.
    ch = decode_live_channels(live, fields)
    assert 11.0 < ch["S8_vbat"] < 15.0
    assert 0.0 <= ch["S8_ft1V"] < 5.0

    ev_fields, _ = _layout_and_live(FIXTURE_707B, 707)
    ev_units = {f.name: f.unit for f in ev_fields}
    # The pack is its own quantity, already in V -- must not be rescaled.
    assert ev_units["Pack_Voltage"] == "V"
    assert ev_units["Min_Cell_Voltage"] == "V"
    assert ev_units["Pack_Current"] == "A"
    assert ev_units["Torque_Command"] == "Nm"


def test_unplugged_sensors_decode_as_no_data() -> None:
    """AiM sends -inf for a missing sensor (f16 0xfc00 thermocouples, f32
    0xff800000 rotor temps); those must be absent, not -1024 or -inf."""
    fields, live = _layout_and_live(FIXTURE_IC, 494)
    ch = decode_live_channels(live, fields)
    for name in ("0TC01", "0TC04", "LF_BRKTempCH1"):
        assert name not in ch
