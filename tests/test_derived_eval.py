"""Python derived-channel sandbox: one script must not affect the server or
the next script."""

from __future__ import annotations

import math

import numpy as np
import pytest

from services import derived_eval


def _run(expression: str) -> dict:
    return derived_eval.run(
        expression, {}, np=np, math_module=math, interpolate=lambda *_: 0.0, timeout=5,
    )


def test_rebinding_math_functions_does_not_touch_the_real_math_module():
    real_sin = math.sin
    _run("math.sin = lambda x: 999.0\nmath.pi = 3")
    assert math.sin is real_sin
    assert math.pi == pytest.approx(3.14159, abs=1e-4)
    # And lap detection / GPS preview, which use math directly, are unaffected.
    from services import lap_detection

    assert lap_detection._haversine_m(41.0, -72.0, 41.01, -72.0) == pytest.approx(1111.9, abs=2)


def test_rebinding_np_in_one_script_does_not_leak_into_the_next():
    _run("np.sin = lambda x: 0")
    out = _run("y = np.sin(np.pi / 2)")
    assert out["y"] == pytest.approx(1.0)


def test_math_still_works_inside_scripts():
    assert _run("y = math.sqrt(16) + math.floor(2.7)")["y"] == 6.0


@pytest.mark.parametrize("name", ["empty", "empty_like", "ndarray"])
def test_uninitialised_buffers_and_raw_ndarray_are_not_exposed(name):
    with pytest.raises(AttributeError):
        _run(f"y = np.{name}")
