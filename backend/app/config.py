"""Filesystem locations and tunables shared by the whole backend."""

from __future__ import annotations

import os
from pathlib import Path

#: backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent

#: The service directory itself.
SERVICE_ROOT = BACKEND_ROOT.parent

#: Where this service's STATE lives -- kept apart from its code so the service
#: is movable as one folder (LILAK SERVICE_CONTRACT §9). Standalone this is
#: ``backend/``. Started by the LILAK portal it is the portal's own data dir for
#: this service, handed over as PORTAL_DATA_ROOT + PORTAL_SERVICE. Deriving it
#: here rather than spelling it out in the service manifest is what keeps
#: absolute paths out of that manifest.
_portal_root = os.environ.get("PORTAL_DATA_ROOT")
_portal_service = os.environ.get("PORTAL_SERVICE")
STATE_ROOT = (Path(_portal_root) / _portal_service
              if _portal_root and _portal_service else BACKEND_ROOT)

#: Where sources.json lives.  Override with MINICOM_DATA_DIR.
DATA_DIR = Path(os.environ.get("MINICOM_DATA_DIR", STATE_ROOT / "data")).resolve()

#: The consoles this service knows about, so a restart is not a re-setup.
SOURCE_FILE = DATA_DIR / "sources.json"

#: Root of the rate logs.  CSV files go in ``<LOG_ROOT>/CSV``.
LOG_ROOT = Path(os.environ.get("MINICOM_LOG_DIR", STATE_ROOT / "log")).resolve()

#: Built frontend (``frontend/dist``).  Served at / when present.
STATIC_DIR = Path(
    os.environ.get("MINICOM_STATIC_DIR", SERVICE_ROOT / "frontend" / "dist")
).resolve()

#: What a CoBo console runs at.  Every board on this bench is 115200 8N1.
DEFAULT_BAUD = int(os.environ.get("MINICOM_BAUD", "115200"))

#: How often the latest reading is pushed to the browsers.  Only the current
#: sample goes over this socket -- history is fetched per chart window, so the
#: rate here costs a few hundred bytes a tick however long the run has been.
BROADCAST_INTERVAL = float(os.environ.get("MINICOM_BROADCAST_INTERVAL", "0.5"))

#: Samples kept in memory per channel.  A CoBo prints a rate line about every
#: ten seconds, so 24 h is under nine thousand -- this is a fortnight of them.
#: Anything older is still in the CSV.
HISTORY_LIMIT = int(os.environ.get("MINICOM_HISTORY_LIMIT", "200000"))

#: Raw console lines kept per source: what minicom's scrollback would hold.
CONSOLE_LIMIT = int(os.environ.get("MINICOM_CONSOLE_LIMIT", "2000"))

#: Points a series endpoint will return before it decimates.  Two thousand is
#: about four per horizontal pixel on a wide chart -- past that the wire cost
#: is real and nothing new becomes visible.
DEFAULT_MAX_POINTS = 2000
MAX_MAX_POINTS = 20000

#: Offered as the placeholder when adding a capture file.
DEFAULT_CAPTURE_PATH = os.environ.get("MINICOM_CAPTURE_PATH", "/tmp/minicom_ttyUSB1.cap")
