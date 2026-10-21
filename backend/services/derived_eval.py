"""Restricted evaluator for user-written Python derived channels.

Python cannot be sandboxed by trimming ``__builtins__`` alone (object
introspection such as ``().__class__.__base__.__subclasses__()`` reaches every
loaded class), so scripts are checked against a syntax-tree allowlist first and
then run with a minimal namespace:

* no imports, class definitions, or dunder/frame/code-object attribute access;
* ``numpy`` is exposed without file I/O, ctypes, or submodule access;
* a cooperative deadline replaces ``SIGALRM`` so it works on Windows and off the
  main thread (it interrupts Python-level loops, not one long numpy call).
"""

from __future__ import annotations

import ast
import re
import sys
import time
import types

_BLOCKED_ATTR_RE = re.compile(r"^(_|(gi|ag|cr|f|tb|co|func)_)")
_BLOCKED_ATTRS = frozenset({
    "format", "format_map", "mro", "tofile", "dump", "dumps", "ctypes",
    "load", "save", "savez", "savez_compressed", "loadtxt", "savetxt",
    "genfromtxt", "fromfile", "fromregex", "memmap", "DataSource", "open",
})
_BLOCKED_NODES = (
    ast.Import, ast.ImportFrom, ast.ClassDef, ast.Global, ast.Nonlocal,
    ast.AsyncFunctionDef, ast.Await, ast.AsyncFor, ast.AsyncWith,
    ast.Try, ast.ExceptHandler,
)
if hasattr(ast, "TryStar"):
    _BLOCKED_NODES = _BLOCKED_NODES + (ast.TryStar,)

_SAFE_BUILTINS = {
    "range": range, "len": len, "min": min, "max": max, "abs": abs,
    "round": round, "sum": sum, "zip": zip, "enumerate": enumerate,
    "map": map, "filter": filter, "list": list, "dict": dict, "tuple": tuple,
    "float": float, "int": int, "bool": bool, "str": str, "sorted": sorted,
    "reversed": reversed, "isinstance": isinstance,
    "True": True, "False": False, "None": None,
    "print": lambda *a, **kw: None,
}

_SAFE_NUMPY_ALLOWLIST = frozenset({
    "array", "asarray", "asanyarray", "zeros", "ones", "full", "zeros_like",
    "ones_like", "full_like", "arange", "linspace", "logspace", "geomspace",
    "sin", "cos", "tan", "arcsin", "arccos", "arctan", "arctan2", "sinh", "cosh", "tanh",
    "arcsinh", "arccosh", "arctanh", "exp", "exp2", "expm1", "log", "log2", "log10", "log1p",
    "sqrt", "cbrt", "square", "absolute", "abs", "fabs", "sign", "copysign",
    "floor", "ceil", "trunc", "round", "rint", "clip",
    "maximum", "minimum", "fmax", "fmin", "nanmax", "nanmin", "nanmean", "nanstd", "nanvar",
    "mean", "std", "var", "median", "sum", "cumsum", "prod", "cumprod", "diff", "gradient",
    "interp", "convolve", "isnan", "isinf", "isfinite", "where", "select",
    "pi", "e", "nan", "inf", "float32", "float64", "int32", "int64", "bool_",
})

_safe_np_attrs: dict | None = None


class ScriptRejected(ValueError):
    """The script uses a construct that is not allowed."""


def validate(expression: str) -> ast.AST:
    try:
        tree = ast.parse(expression, mode="exec")
    except SyntaxError as e:
        raise ScriptRejected(f"SyntaxError: {e}") from e
    for node in ast.walk(tree):
        if isinstance(node, _BLOCKED_NODES):
            raise ScriptRejected(f"{type(node).__name__} is not allowed in derived channel scripts")
        if isinstance(node, ast.Attribute) and (
            _BLOCKED_ATTR_RE.match(node.attr) or node.attr in _BLOCKED_ATTRS
        ):
            raise ScriptRejected(f"Access to attribute '{node.attr}' is not allowed")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ScriptRejected(f"Name '{node.id}' is not allowed")
    return tree


def _safe_numpy(np) -> types.SimpleNamespace:
    """numpy's public callables/constants, strictly limited to mathematical functions.

    A fresh namespace per run, so a script that rebinds ``np.sin`` only
    affects itself, never later scripts.
    """
    global _safe_np_attrs
    if _safe_np_attrs is None:
        attrs = {}
        for name in _SAFE_NUMPY_ALLOWLIST:
            if hasattr(np, name):
                val = getattr(np, name)
                if not isinstance(val, types.ModuleType):
                    attrs[name] = val
        _safe_np_attrs = attrs
    return types.SimpleNamespace(**_safe_np_attrs)


def _safe_math(math_module) -> types.SimpleNamespace:
    """Per-run copy of ``math``'s public names.

    Handing scripts the real module would let ``math.sin = ...`` corrupt
    every other user of ``math`` in the server (lap detection, GPS preview).
    """
    return types.SimpleNamespace(**{
        k: getattr(math_module, k) for k in dir(math_module) if not k.startswith("_")
    })


def run(expression: str, channels: dict, *, np, math_module, interpolate, timeout: float) -> dict:
    """Run a validated script and return the local variables it produced."""
    code = compile(validate(expression), "<derived>", "exec")
    g = {
        "__builtins__": dict(_SAFE_BUILTINS),
        "channels": channels,
        "np": _safe_numpy(np),
        "interpolate": interpolate,
        "math": _safe_math(math_module),
    }
    local_vars: dict = {}

    deadline = time.monotonic() + timeout

    def tracer(frame, event, arg):
        if time.monotonic() > deadline:
            raise TimeoutError("Script exceeded time limit")
        return tracer

    previous = sys.gettrace()
    sys.settrace(tracer)
    try:
        exec(code, g, local_vars)
    finally:
        sys.settrace(previous)
    return local_vars
