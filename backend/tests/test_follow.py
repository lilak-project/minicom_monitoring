"""Following the DAQ: its run starts ours, a new attempt restarts it, its end stops only a followed run.

    python tests/test_follow.py
"""

import os
import tempfile

os.environ.setdefault("MINICOM_DATA_DIR", tempfile.mkdtemp())

from app import follow  # noqa: E402
from app.monitor import monitor  # noqa: E402

calls = []
monitor.start_run = lambda label, note="", daq=None: (calls.append(("start", label, daq)), setattr(monitor, "run", {"run": label, "daq": daq}))
monitor.stop_run = lambda: (calls.append(("stop",)), setattr(monitor, "run", None))

monitor.run = None
follow.apply({"run": 240, "note": "beam", "started": "T1"})
follow.apply({"run": 240, "note": "beam", "started": "T1"})  # same attempt: nothing
assert calls == [("start", "240", "240@T1")], calls
follow.apply({"run": 240, "started": "T2"})  # same number, new attempt
assert calls[-1] == ("start", "240", "240@T2"), calls
follow.apply(None)
assert calls[-1] == ("stop",), calls

calls.clear()
monitor.run = {"run": "9", "daq": None}  # started by hand
follow.apply(None)
assert calls == [], calls
s = follow.summary({"live": None, "daq_up": True, "processes": [{"label": "a", "running": True}, {"label": "b", "running": False}]})
assert s["down"] == ["b"] and s["components"] == 2 and s["daq_up"], s
print("ok")
