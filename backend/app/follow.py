"""Follow the GANIL DAQ: its run starts, minicom's run starts with the same number.

ganil_daq_monitoring already reads run control's logs and says which run is
going at `/api/status` (`live`: run, note, started -- or null). This asks it every
few seconds and moves `monitor.run` to match:

- a DAQ run appears, or a new attempt (same number, new start) -> start that run
- the DAQ run ends -> stop, but only a run this started; a hand-started run is left alone

The switch is a file (`DATA_DIR/follow_daq`) so it survives a restart.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.request
from pathlib import Path

from .config import DATA_DIR
from .monitor import monitor

log = logging.getLogger(__name__)

SWITCH = DATA_DIR / "follow_daq"
INTERVAL = float(os.environ.get("MINICOM_FOLLOW_INTERVAL", "3"))
#: Where to ask. Default: the ganil service under the same portal, found by its .port file.
URL = os.environ.get("MINICOM_DAQ_STATUS_URL", "")

state = {"error": None}


def on() -> bool:
    return SWITCH.exists()


def set_on(value: bool) -> None:
    if value:
        SWITCH.parent.mkdir(parents=True, exist_ok=True)
        SWITCH.touch()
    else:
        SWITCH.unlink(missing_ok=True)
        state["error"] = None


def status_url() -> str:
    if URL:
        return URL
    root = os.environ.get("PORTAL_DATA_ROOT")
    if not root:
        raise RuntimeError("not started by the portal; set MINICOM_DAQ_STATUS_URL")
    try:
        port = int((Path(root) / "ganil_daq_monitoring" / ".port").read_text().strip())
    except (OSError, ValueError):
        raise RuntimeError("ganil_daq_monitoring is not running") from None
    return f"http://127.0.0.1:{port}/api/status"


def fetch_live() -> dict | None:
    with urllib.request.urlopen(status_url(), timeout=5) as response:
        return json.load(response).get("live")


def apply(live: dict | None) -> None:
    """Move monitor.run to match the DAQ's `live` run."""
    current = monitor.run
    if live:
        key = f"{live.get('run')}@{live.get('started')}"
        if not current or current.get("daq") != key:
            monitor.start_run(str(live["run"]), live.get("note") or "", daq=key)
    elif current and current.get("daq"):
        monitor.stop_run()


def _loop(stop: threading.Event) -> None:
    while not stop.wait(INTERVAL):
        if not on():
            continue
        try:
            apply(fetch_live())
            state["error"] = None
        except Exception as err:  # noqa: BLE001 -- unreachable DAQ must not kill the loop
            # Keep the run as it is: a DAQ monitor that blinks is not the DAQ stopping.
            if state["error"] != str(err):
                log.warning("follow DAQ: %s", err)
            state["error"] = str(err)


_stop = threading.Event()


def start() -> None:
    threading.Thread(target=_loop, args=(_stop,), name="follow-daq", daemon=True).start()


def stop() -> None:
    _stop.set()
