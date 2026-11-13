"""Where QuickScope keeps its data. The one place this is worked out.

``QUICKSCOPE_DATA_DIR`` overrides the default (``backend/data``); the packaged
app points it at the user's application-data folder.
"""

import os
from pathlib import Path

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
