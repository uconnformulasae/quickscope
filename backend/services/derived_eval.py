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
)

_SAFE_BUILTINS = {
    "range": range, "len": len, "min": min, "max": max, "abs": abs,
    "round": round, "sum": sum, "zip": zip, "enumerate": enumerate,
    "map": map, "filter": filter, "list": list, "dict": dict, "tuple": tuple,
    "float": float, "int": int, "bool": bool, "str": str, "sorted": sorted,
    "reversed": reversed, "isinstance": isinstance,
    "True": True, "False": False, "None": None,
    "print": lambda *a, **kw: None,
}


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
    """numpy's public callables/constants, minus modules and file I/O."""
    return types.SimpleNamespace(**{
        name: getattr(np, name)
        for name in dir(np)
        if not _BLOCKED_ATTR_RE.match(name)
        and name not in _BLOCKED_ATTRS
        and not isinstance(getattr(np, name, None), types.ModuleType)
    })


def run(expression: str, channels: dict, *, np, math_module, interpolate, timeout: float) -> dict:
    """Run a validated script and return the local variables it produced."""
    code = compile(validate(expression), "<derived>", "exec")
    g = {
        "__builtins__": dict(_SAFE_BUILTINS),
        "channels": channels,
        "np": _safe_numpy(np),
        "interpolate": interpolate,
        "math": math_module,
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
