"""One run across every open console: start gives them one number, stop ends all.

    python tests/test_run.py
"""

import os
import tempfile

os.environ.setdefault("MINICOM_DATA_DIR", tempfile.mkdtemp())

from app import monitor as m  # noqa: E402


class Fake:
    def __init__(self, reading):
        self.reading, self.label = reading, None
        self.last_error = None

    def start_recording(self, label, note=""):
        self.label = label

    def stop_recording(self):
        self.label = None


def test_run_starts_and_stops_every_open_console():
    mon = m.Monitor()
    a, b, closed = Fake(True), Fake(True), Fake(False)
    mon.sources = lambda: [a, b, closed]
    run = mon.start_run("77")
    assert run["run"] == "77" and a.label == b.label == "77" and closed.label is None
    assert m.RUN_FILE.exists() and m.Monitor().run["run"] == "77"  # survives a restart
    assert mon.stop_run()["run"] == "77" and a.label is None and mon.run is None
    assert not m.RUN_FILE.exists()


if __name__ == "__main__":
    test_run_starts_and_stops_every_open_console()
    print("ok")
