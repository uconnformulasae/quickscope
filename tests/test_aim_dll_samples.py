"""AimDll sample reads, with a fake DLL (the real one is Windows-only)."""

from __future__ import annotations

from parsers.aim_dll import AimDll


class _FakeGpsDll:
    """Reports room for 5 samples but only fills 3 -- like a real short read."""

    def get_GPS_channel_samples_count(self, idx, channel):
        return 5

    def get_GPS_channel_samples(self, idx, channel, times, values, count):
        for i in range(3):
            times[i] = 1000.0 + i * 100
            values[i] = 41.8 + i * 1e-4
        return 3


def test_gps_samples_drop_the_unfilled_tail_of_the_buffer():
    dll = AimDll.__new__(AimDll)  # skip loading the real DLL
    dll._dll = _FakeGpsDll()
    times, values = dll.get_GPS_channel_samples(0, 0)
    assert times == [1000.0, 1100.0, 1200.0]
    assert len(values) == 3 and 0.0 not in values
