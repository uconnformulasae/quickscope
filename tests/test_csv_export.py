"""parse_export_query: the shared query parsing behind both CSV export routes."""

from __future__ import annotations

import pytest

from services.csv_export import parse_export_query


def test_splits_and_trims_channel_names():
    names, conversions = parse_export_query(" Speed, RPM ,,", None)

    assert names == ["Speed", "RPM"]
    assert conversions == {}


def test_parses_conversions():
    _, conversions = parse_export_query("Speed", '{"Speed": {"unit": "mph", "scale": 0.621371}}')

    assert conversions == {"Speed": ("mph", 0.621371, 0.0)}


@pytest.mark.parametrize("channels", ["", " , ,"])
def test_rejects_an_empty_channel_list(channels):
    with pytest.raises(ValueError, match="No channels specified"):
        parse_export_query(channels, None)


def test_rejects_malformed_conversions():
    with pytest.raises(ValueError, match="Malformed convert parameter"):
        parse_export_query("Speed", '{"Speed": {"scale": 2}}')
