"""The rate log on disk.

One CSV per session, in ``<LOG_ROOT>/CSV``, with the columns
``cobo_rate_logger.py`` has been writing since June and in its order -- so a
file from either program opens in the other, and in whatever the analysis is
already using to read them.

Written line by line and flushed on every sample. A rate line arrives every few
seconds, so the cost is nothing, and the alternative is that a service killed
mid-run loses the last buffered block of exactly the run somebody wanted.
"""

from __future__ import annotations

import csv
import os
import re
from pathlib import Path

from .config import LOG_ROOT
from .parser import CSV_FIELDS

CSV_DIR = LOG_ROOT / "CSV"


def safe_name(value: str) -> str:
    """A filename fragment out of a device path or a source name."""
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return name or "console"


def run_path(stem: str, run: str) -> Path:
    """`cobo_rate_ttyUSB1_34.csv` -- the name `cobo_rate_logger.py --run 34` uses.

    The run number is in the filename rather than a timestamp because that is
    how these files are already named, referred to and analysed: run 34 of the
    experiment is `..._34.csv` on every board that recorded it.
    """
    return CSV_DIR / f"cobo_rate_{safe_name(stem)}_{safe_name(run)}.csv"


class RateLog:
    """An open CSV, created on the first sample rather than on start.

    A recording of a console that turns out to be quiet should not leave an
    empty file behind -- and a zero-row CSV in a list of runs looks like a run
    that failed, not like a board that never spoke.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.rows = 0
        #: True when the file was already there and this is adding to it --
        #: re-recording a run number that has been recorded before.
        self.appending = path.exists() and path.stat().st_size > 0
        self._file = None
        self._writer: csv.DictWriter | None = None

    def _open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        existing = self.path.exists() and self.path.stat().st_size > 0
        self._file = self.path.open("a", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=list(CSV_FIELDS))
        if not existing:
            self._writer.writeheader()
            self._file.flush()

    def write(self, sample: dict) -> None:
        if self._writer is None:
            self._open()
        assert self._writer is not None and self._file is not None
        self._writer.writerow(
            {
                "timestamp_utc": sample["timestamp_utc"],
                "mbps": sample["mbps"],
                "intr_per_s": sample["intr_per_s"],
                "total_intr": sample["total_intr"],
                # The file's column name, which is not the wire's.
                "mem_occupied_pct": sample["mem_pct"],
                "run_time": sample["run_time"],
                "run_time_seconds": sample["run_time_seconds"],
                "raw_line": sample["raw_line"],
            }
        )
        self._file.flush()
        os.fsync(self._file.fileno())
        self.rows += 1

    @property
    def started(self) -> bool:
        return self._file is not None

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None
            self._writer = None


def listing() -> list[dict]:
    """Every CSV in the log directory, newest first."""
    if not CSV_DIR.is_dir():
        return []
    out = []
    for path in CSV_DIR.glob("*.csv"):
        try:
            stat = path.stat()
        except OSError:
            continue
        out.append(
            {
                "filename": path.name,
                "size": stat.st_size,
                "modified": stat.st_mtime,
            }
        )
    out.sort(key=lambda item: item["modified"], reverse=True)
    return out


def resolve(filename: str) -> Path:
    """A path inside the log directory, or ValueError.

    The filename arrives from a URL, so it is checked rather than trusted: a
    name is a name, never a path, and never one that climbs out of the folder.
    """
    if "/" in filename or "\\" in filename or filename in ("", ".", ".."):
        raise ValueError(f"{filename!r} is not a log file name")
    path = (CSV_DIR / filename).resolve()
    if path.parent != CSV_DIR.resolve() or not path.is_file():
        raise ValueError(f"No log file named {filename!r}")
    return path
