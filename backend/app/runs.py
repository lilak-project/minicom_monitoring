"""Recordings, and the index of the ones that have been taken.

A **run** here is a span of time whose rate lines were written to one file.
It is not the same thing as the board's own run -- the board restarts its
trigger count when a run starts on it, and this service notices that, but a
recording is what an operator chose to keep, which may cover part of a board
run or several of them.

Reading and recording are separate. A console that is open is always charted
and always in the scrollback; whether it is also being written to a file is the
recording state, and it can be stopped and started without disturbing either.
Opening a console starts a recording, because on a shift the failure that costs
something is forgetting to press record, not an extra file.

The index lives beside the CSVs and holds one entry per recording, with the
summary the Runs table shows: how long it ran, how many rate lines it caught,
and what the trigger rate averaged. Those are accumulated as the samples
arrive, so the table costs nothing to draw however long the run was.

An entry with no end is a recording the service did not close -- it was killed
mid-run. The CSV is still there and still complete up to the last flush, so the
entry is repaired from the file rather than shown as a run that never finished.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime

from .config import DATA_DIR

log = logging.getLogger(__name__)

#: The index, beside sources.json.
RUN_FILE = DATA_DIR / "runs.json"

#: `cobo_rate_ttyUSB1_34.csv` -- the trailing number is the run.
_RUN_FILE = re.compile(r"cobo_rate_.+?_(\d+)\.csv")
#: `cobo_rate_ttyUSB1_20260831_234711.csv` -- a stamp, not a run number.
_TIMESTAMPED = re.compile(r"_\d{8}_\d{6}\.csv$")


@dataclass
class Run:
    """One recording: the file, and what went into it."""

    id: str
    source_id: str
    source_name: str
    #: The port or capture file it was read from, for the record.
    origin: str
    #: The run label. A number, normally -- the DAQ's own run number.
    run: str
    filename: str
    path: str
    started_at: float
    stopped_at: float | None = None
    #: Free text the operator attached when starting it.
    note: str = ""
    #: True when this recording appended to a file an earlier one had made.
    appended: bool = False
    #: Set when the entry had to be rebuilt from the file after a crash.
    interrupted: bool = False

    rows: int = 0
    first_at: float | None = None
    last_at: float | None = None
    #: Trigger-rate summary over the whole recording.
    mean: float | None = None
    min: float | None = None
    max: float | None = None
    #: Kept so the mean can be extended one sample at a time.
    _sum: float = field(default=0.0, repr=False)

    def observe(self, at: float, rate: float) -> None:
        """Fold one rate line into the summary."""
        self.rows += 1
        self._sum += rate
        self.mean = self._sum / self.rows
        self.min = rate if self.min is None else min(self.min, rate)
        self.max = rate if self.max is None else max(self.max, rate)
        if self.first_at is None:
            self.first_at = at
        self.last_at = at

    @property
    def running(self) -> bool:
        return self.stopped_at is None

    @property
    def seconds(self) -> float | None:
        end = self.stopped_at or self.last_at
        if end is None:
            return None
        return max(0.0, end - self.started_at)

    def as_dict(self) -> dict:
        data = {key: value for key, value in asdict(self).items() if not key.startswith("_")}
        data["running"] = self.running
        data["seconds"] = self.seconds
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Run":
        known = {f for f in cls.__dataclass_fields__ if not f.startswith("_")}
        run = cls(**{key: value for key, value in data.items() if key in known})
        run._sum = (run.mean or 0.0) * run.rows
        return run


def safe_run_label(value: str) -> str:
    """A run label that can be a filename and a URL segment.

    The same characters `cobo_rate_logger.py --run` allows, and for the same
    reason: the label goes into the filename, and a run called `../x` must not
    be able to say where the file lands.
    """
    label = value.strip()
    if not label:
        raise ValueError("a run needs a number or a name")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", label):
        raise ValueError(
            "a run may contain only letters, numbers, dots, dashes and underscores"
        )
    if len(label) > 40:
        raise ValueError("a run label is at most 40 characters")
    return label


class RunIndex:
    """Every recording this service has taken, newest last."""

    def __init__(self) -> None:
        self._runs: list[Run] = []
        self._lock = threading.Lock()
        self._loaded = False
        #: Highest run number seen in the log directory but not in the index --
        #: files from the logger this service replaces, or from an install
        #: whose index was lost. Numbering has to clear those too, or the first
        #: run after a fresh start would be 1 and would append to a run 1 that
        #: somebody took last month.
        self._floor = 0

    # -- persistence -----------------------------------------------------

    def load(self) -> None:
        with self._lock:
            self._loaded = True
            try:
                raw = json.loads(RUN_FILE.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return
            except (OSError, ValueError) as err:
                log.warning("could not read %s: %s", RUN_FILE, err)
                return
            if not isinstance(raw, list):
                return
            for item in raw:
                if isinstance(item, dict):
                    try:
                        self._runs.append(Run.from_dict(item))
                    except TypeError:
                        log.warning("ignoring malformed run entry %r", item.get("id"))

    def _save_locked(self) -> None:
        RUN_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps([run.as_dict() for run in self._runs], indent=2) + "\n"
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=RUN_FILE.parent,
            prefix=".runs-", suffix=".tmp", delete=False,
        )
        try:
            with handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(handle.name, RUN_FILE)
        except OSError as err:
            log.warning("could not write %s: %s", RUN_FILE, err)
            try:
                os.unlink(handle.name)
            except OSError:
                pass

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    # -- registry --------------------------------------------------------

    def add(self, run: Run) -> None:
        with self._lock:
            self._runs.append(run)
            self._save_locked()

    def all(self) -> list[Run]:
        with self._lock:
            return list(self._runs)

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            return next((run for run in self._runs if run.id == run_id), None)

    def observe_files(self, filenames: list[str]) -> None:
        """Raise the numbering floor past any run number already on disk.

        Called once at start-up. A scan per call would be far too much for
        `next_label`, which rides along on every status frame.
        """
        highest = 0
        for name in filenames:
            # `..._20260831_234711.csv` is a date and a time, not run 234711.
            # That was this service's own naming before runs existed, and
            # reading it as a number would put the next run six digits away.
            if _TIMESTAMPED.search(name):
                continue
            match = _RUN_FILE.fullmatch(name)
            if match:
                highest = max(highest, int(match.group(1)))
        with self._lock:
            self._floor = max(self._floor, highest)

    def next_label(self) -> str:
        """One past the highest run number anybody has recorded.

        Across every console, not per console: a DAQ run number names the run,
        and two boards recording the same run should land on
        `cobo_rate_ttyUSB0_34.csv` and `cobo_rate_ttyUSB1_34.csv` -- which is
        what the logger this replaces did.
        """
        with self._lock:
            numbers = [int(run.run) for run in self._runs if run.run.isdigit()]
            numbers.append(self._floor)
        return str(max(numbers) + 1)

    def make_id(self, source_id: str, label: str, at: float) -> str:
        stamp = datetime.fromtimestamp(at).strftime("%Y%m%d_%H%M%S")
        base = f"{source_id}-{label}-{stamp}"
        with self._lock:
            taken = {run.id for run in self._runs}
        if base not in taken:
            return base
        for suffix in range(2, 100):
            if f"{base}-{suffix}" not in taken:
                return f"{base}-{suffix}"
        raise ValueError("too many recordings in one second")

    # -- repair ----------------------------------------------------------

    def repair(self, live_ids: set[str]) -> None:
        """Close out entries the service never got to close.

        A run whose entry has no end and which nothing is currently recording
        was interrupted -- the process was killed. The CSV is flushed on every
        row, so the file is the truth: the summary is recomputed from it and
        the entry says it was interrupted rather than claiming to still be
        going, which is what it would otherwise look like forever.
        """
        changed = False
        with self._lock:
            stale = [run for run in self._runs if run.running and run.id not in live_ids]
        for run in stale:
            _rebuild(run)
            run.interrupted = True
            changed = True
        if changed:
            self.save()


def _rebuild(run: Run) -> None:
    """Recompute a run's summary from its CSV."""
    rows = 0
    total = 0.0
    low = high = None
    first = last = None
    try:
        with open(run.path, newline="", encoding="utf-8", errors="replace") as handle:
            for record in csv.DictReader(handle):
                try:
                    rate = float(record["intr_per_s"])
                    at = datetime.fromisoformat(record["timestamp_utc"]).timestamp()
                except (KeyError, TypeError, ValueError):
                    continue
                rows += 1
                total += rate
                low = rate if low is None else min(low, rate)
                high = rate if high is None else max(high, rate)
                first = at if first is None else first
                last = at
    except OSError as err:
        log.warning("could not re-read %s: %s", run.path, err)
        run.stopped_at = run.last_at or run.started_at
        return

    run.rows = rows
    run._sum = total
    run.mean = total / rows if rows else None
    run.min = low
    run.max = high
    run.first_at = first
    run.last_at = last
    # The file's own last row is when it really stopped, not now.
    run.stopped_at = last or run.started_at


index = RunIndex()
