# PyInstaller spec for QuickScope backend
#
# Usage (from the `backend/` directory):
#   pyinstaller quickscope-backend.spec --noconfirm
#
# Produces: ./dist/quickscope-backend/
#   - quickscope-backend (executable)
#   - _internal/         (python stdlib + libxrk + pandas + ...)

# ruff: noqa
# pyright: ignore
# type: ignore

from PyInstaller.utils.hooks import collect_all, collect_submodules

# Native-extension packages that PyInstaller must bundle wholesale.
# libxrk imports pyarrow transitively so we collect it explicitly too — its
# C extensions won't be picked up otherwise.
libxrk_datas, libxrk_binaries, libxrk_hidden = collect_all("libxrk")
pandas_datas, pandas_binaries, pandas_hidden = collect_all("pandas")
pyarrow_datas, pyarrow_binaries, pyarrow_hidden = collect_all("pyarrow")

# uvicorn discovers protocols/loops/lifespan impls dynamically
uvicorn_hidden = collect_submodules("uvicorn")

# Our own routes modules are imported via `from routes import ...`
routes_hidden = [
    "routes.sessions",
    "routes.analysis",
    "routes.settings",
]

hiddenimports = (
    libxrk_hidden
    + pandas_hidden
    + pyarrow_hidden
    + uvicorn_hidden
    + routes_hidden
)


a = Analysis(
    ["entry.py"],
    pathex=[],
    binaries=libxrk_binaries + pandas_binaries + pyarrow_binaries,
    datas=libxrk_datas + pandas_datas + pyarrow_datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # Trim unused GUI stdlib; keep pydoc because pyarrow's vendored
        # docscrape imports it at module load.
        "tkinter",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="quickscope-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="quickscope-backend",
)
