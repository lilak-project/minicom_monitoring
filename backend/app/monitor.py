"""The consoles this service is watching, and what it has heard from them.

One `Source` is one console: a serial port, or a capture file another program
is writing. Each owns a reader thread, a ring of raw lines (what minicom's
screen would be showing), one `Buffer` per number on the rate line, and the CSV
those numbers are written to.

Samples stay here. A browser asks for the window its chart is showing and gets
that window decimated to what a chart can draw -- so watching a run that has
been going for a week costs the same as watching one that started a minute ago.
The mean travels with the window and is computed from every sample in it, not
from the points that survived decimation: an average of the extremes that
happened to be kept is not the average of anything.
"""

from __future__ import annotations

import re

import logging
import os
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .config import CONSOLE_LIMIT, DEFAULT_BAUD, DEFAULT_MAX_POINTS
from .csvlog import RateLog, run_path
from .parser import CHANNELS, CHANNEL_BY_KEY, PRIMARY, RATE_MARK_RE, clean, parse_rate_line
from . import portlock, reader, runs
from .series import Buffer, decimate

#: The trend behind an overview tile: the last ten minutes, at most 120 points.
TRACE_SECONDS = 600.0
TRACE_POINTS = 120

log = logging.getLogger(__name__)

#: A source is one of these two things and nothing else.
KINDS = ("serial", "capture")


@dataclass
class SourceSpec:
    """What a console is, as it is stored and as it is edited."""

    id: str
    name: str
    kind: str = "serial"
    #: serial
    port: str = ""
    baud: int = DEFAULT_BAUD
    #: capture
    path: str = ""
    #: Re-open it when the service starts.
    autostart: bool = False

    def validate(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"a source is 'serial' or 'capture', not {self.kind!r}")
        if not self.name.strip():
            raise ValueError("a source needs a name")
        if self.kind == "serial" and not self.port:
            raise ValueError("a serial source needs a port, e.g. /dev/ttyUSB1")
        if self.kind == "capture" and not self.path:
            raise ValueError("a capture source needs the path minicom is writing to")
        if self.kind == "serial" and self.baud not in reader.BAUD_RATES:
            raise ValueError(f"unsupported baud rate {self.baud}")

    @property
    def origin(self) -> str:
        return self.port if self.kind == "serial" else self.path

    def as_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "port": self.port,
            "baud": self.baud, "path": self.path, "autostart": self.autostart,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SourceSpec":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            kind=str(data.get("kind", "serial")),
            port=str(data.get("port", "")),
            baud=int(data.get("baud", DEFAULT_BAUD)),
            path=str(data.get("path", "")),
            autostart=bool(data.get("autostart", False)),
        )


@dataclass
class Source:
    """A console being read, or one that has been and is now stopped."""

    spec: SourceSpec
    status: str = "stopped"
    last_error: str | None = None
    opened_at: float | None = None
    #: Every number on the rate line, keyed as `parser.CHANNELS` names them.
    buffers: dict[str, Buffer] = field(default_factory=lambda: {c.key: Buffer() for c in CHANNELS})
    #: The raw lines, as minicom would have shown them.
    console: deque = field(default_factory=lambda: deque(maxlen=CONSOLE_LIMIT))
    #: Monotonic per source, so a browser can ask for "everything after N"
    #: without the answer depending on how much has aged out of the ring.
    console_seq: int = 0
    lines: int = 0
    samples: int = 0
    #: Lines that announced themselves as rate lines and did not parse. This
    #: exists because they once did so in silence: the board scales its data
    #: rate to `kb/s` when a run goes quiet, the pattern only took `Mb/s`, and
    #: a night of an idle run was dropped without a mark anywhere. A parser
    #: that stops matching must say so rather than look like a quiet board.
    unparsed: int = 0
    last_unparsed: str | None = None
    #: The newest line that is not a rate line ("Waiting for interrupt", "Sending heart
    #: beat"): what the board last said, beside what it last counted.
    last_info: str | None = None
    last_info_at: float | None = None
    latest: dict | None = None
    #: Sums kept as they arrive, so the session mean is not a re-scan of the
    #: whole buffer every time the status socket ticks.
    _sum: float = 0.0
    #: The recording going, if any. Reading and recording are separate: a
    #: console that is open is always charted, and whether it is also being
    #: written to a run file is this.
    recording: runs.Run | None = None
    _log: RateLog | None = None
    _rec_lock: threading.Lock = field(default_factory=threading.Lock)
    #: Total triggers going backwards is the board starting a new run.
    runs: int = 0
    _last_total: int | None = None
    #: Answering "who else has this port" walks every /proc/<pid>/fd, which is
    #: far too much to do twice a second for the status broadcast. It changes
    #: only when a process starts or exits, so a few seconds stale is exact
    #: enough for a line of text on a panel.
    _held: list = field(default_factory=list)
    _held_at: float = 0.0
    #: Our own UUCP lock, held for as long as the port is, so the next program
    #: to reach for it is warned the same way we were.
    _lock_file: portlock.PortLock | None = None
    _thread: threading.Thread | None = None
    _stop: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # -- lifecycle -------------------------------------------------------

    @property
    def reading(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.reading:
            return
        if self.spec.kind == "serial":
            held = portlock.describe(self.spec.port)
            if held:
                # Refused rather than shared: see reader.py. The message names
                # the process, because the next question is always "by what?".
                raise RuntimeError(
                    f"{held}. Two readers on one tty split the byte stream and both lose "
                    f"lines. Stop it first, or add this console as a capture file instead."
                )

        self._stop = threading.Event()
        if self.spec.kind == "serial":
            self._lock_file = portlock.PortLock(self.spec.port)
            self._lock_file.acquire()
        self.last_error = None
        self.opened_at = time.time()
        self.status = "reading"
        # The last component only: a capture's full path would put the whole
        # directory tree into the filename, and its basename is what names it.
        self._thread = threading.Thread(target=self._run, name=f"read-{self.spec.id}", daemon=True)
        self._thread.start()
        try:
            # Opening a console starts recording it. On a shift the failure that
            # costs something is forgetting to press record, not an extra file.
            self.start_recording()
        except (OSError, ValueError) as err:
            # Reading is the half somebody is watching; a console that cannot
            # be written to must still appear on the chart.
            log.warning("%s: could not start recording: %s", self.spec.id, err)
            self.last_error = f"not recording: {err}"

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        self._thread = None
        self.status = "stopped"
        if self._lock_file is not None:
            self._lock_file.release()
            self._lock_file = None
        # The cached answer is now wrong in the direction that matters: the
        # port just became free and the panel should say so at once.
        self._held_at = 0.0
        self.stop_recording()

    def _run(self) -> None:
        try:
            if self.spec.kind == "serial":
                lines = reader.serial_lines(self.spec.port, self.spec.baud, self._stop)
            else:
                lines = reader.capture_lines(self.spec.path, self._stop)
            for raw in lines:
                self._ingest(raw)
        except Exception as err:  # noqa: BLE001 -- a reader thread must not die silently
            log.warning("%s: reader stopped: %s", self.spec.id, err)
            self.status = "error"
            self.last_error = str(err)
        else:
            self.status = "stopped"
        finally:
            # A reader that died on its own ends its recording too, rather than
            # leaving a run that looks like it is still going.
            self.stop_recording()

    # -- recording -------------------------------------------------------

    @property
    def stem(self) -> str:
        """What this console is called in a filename: `ttyUSB1`.

        The last path component with any extension dropped, so a capture at
        `/tmp/minicom_ttyUSB1.cap` records to `cobo_rate_minicom_ttyUSB1_34.csv`
        rather than carrying a `.cap` through the middle of the name.
        """
        name = os.path.basename(self.spec.origin) or self.spec.name
        return os.path.splitext(name)[0] or name

    def start_recording(self, label: str | None = None, note: str = "") -> runs.Run:
        """Begin writing rate lines to a run file, ending whatever was going.

        `label` is the run number. Left out, it is one past the highest anybody
        has recorded -- so pressing New run twice gives 34 then 35, and typing
        the DAQ's own number is how you make them agree.
        """
        self.stop_recording()
        text = runs.safe_run_label(label) if label else runs.index.next_label()
        at = time.time()
        path = run_path(self.stem, text)
        writer = RateLog(path)
        entry = runs.Run(
            id=runs.index.make_id(self.spec.id, text, at),
            source_id=self.spec.id,
            source_name=self.spec.name,
            origin=self.spec.origin,
            run=text,
            filename=path.name,
            path=str(path),
            started_at=at,
            note=note.strip()[:200],
            appended=writer.appending,
        )
        with self._rec_lock:
            self._log = writer
            self.recording = entry
        runs.index.add(entry)
        return entry

    def stop_recording(self) -> runs.Run | None:
        """Close the run file.  The console keeps reading and charting."""
        with self._rec_lock:
            entry, writer = self.recording, self._log
            self.recording, self._log = None, None
        if writer is not None:
            writer.close()
        if entry is not None:
            entry.stopped_at = time.time()
            runs.index.save()
        return entry

    # -- ingest ----------------------------------------------------------

    def _ingest(self, raw: str) -> None:
        text = clean(raw)
        if not text:
            return
        at = time.time()
        with self._lock:
            self.lines += 1
            self.console_seq += 1
            self.console.append({"seq": self.console_seq, "at": at, "text": text})

        sample = parse_rate_line(text, at)
        if sample is None:
            if RATE_MARK_RE.search(text):
                with self._lock:
                    self.unparsed += 1
                    self.last_unparsed = text[:200]
            else:
                # The board frames its messages in dashes; the words are the information.
                info = " · ".join(part.strip() for part in re.split(r"-{3,}", text) if part.strip())
                if info:
                    with self._lock:
                        self.last_info, self.last_info_at = info[:200], at
            return

        for channel in CHANNELS:
            self.buffers[channel.key].append(at, float(sample[channel.key]))

        with self._lock:
            self.samples += 1
            self._sum += sample["intr_per_s"]
            total = sample["total_intr"]
            if self._last_total is None or total < self._last_total:
                self.runs += 1
            self._last_total = total
            self.latest = sample

        with self._rec_lock:
            entry, writer = self.recording, self._log
        if writer is not None and entry is not None:
            try:
                writer.write(sample)
                # The run's summary is accumulated here rather than re-derived
                # from the file, so the Runs table costs nothing to draw
                # however long the run has been going.
                entry.observe(at, sample["intr_per_s"])
            except OSError as err:
                # A full disk must not stop the monitoring, which is the part
                # somebody is watching. Say so once and keep reading.
                if self.last_error != str(err):
                    log.warning("%s: cannot write the run file: %s", self.spec.id, err)
                self.last_error = f"recording: {err}"

    # -- reading out -----------------------------------------------------

    def holders(self, ttl: float = 5.0) -> list[dict]:
        """Other processes with this port open, re-checked at most every `ttl`."""
        if self.spec.kind != "serial" or not self.spec.port:
            return []
        now = time.time()
        if now - self._held_at > ttl:
            self._held = portlock.holders(self.spec.port)
            self._held_at = now
        return self._held

    def clear(self) -> None:
        """Start the chart and the numbers over: every buffer emptied, every count and
        mean back to nothing. The console text, the board's last message and a run
        file being written are left as they are -- a CSV is a record, not a statistic."""
        for buffer in self.buffers.values():
            buffer.clear()
        with self._lock:
            self.lines = self.samples = self.unparsed = self.runs = 0
            self.last_unparsed = None
            self._sum = 0.0
            self._last_total = None
            self.latest = None
            if self.reading:
                self.opened_at = time.time()      # "since opened" now reads "since cleared"

    def trace(self, seconds: float = TRACE_SECONDS, points: int = TRACE_POINTS) -> list[float]:
        """The trigger rate over the last few minutes, small enough to ride on every
        status frame: what a tile draws behind its number."""
        times, values = self.buffers[PRIMARY.key].window(time.time() - seconds, None)
        return decimate(times, values, points)[1]

    @property
    def session_mean(self) -> float | None:
        """Mean trigger rate over everything heard since this source opened."""
        with self._lock:
            return self._sum / self.samples if self.samples else None

    def mean_over(self, seconds: float, key: str = PRIMARY.key) -> float | None:
        """Mean of one channel over the last `seconds`, or None if nothing landed.

        A window, not a decay: "the rate over the last minute" is a plain
        average of the samples inside it, so it can be checked by hand against
        the console. None rather than 0.0 when the window is empty -- a source
        that has said nothing for a minute has no rate, and reporting zero
        would read as a beam that stopped.
        """
        buffer = self.buffers.get(key)
        if buffer is None:
            return None
        _times, values = buffer.window(time.time() - seconds, None)
        return sum(values) / len(values) if values else None

    def console_since(self, seq: int, limit: int = 400) -> tuple[list[dict], int]:
        """Lines after `seq`, newest last, and the sequence to ask from next.

        A browser that has been on another tab for an hour asks for far more
        than it can show; it gets the tail, and `dropped` in the caller's view
        is the difference between what it asked for and what exists.
        """
        with self._lock:
            lines = [item for item in self.console if item["seq"] > seq][-limit:]
            return lines, self.console_seq

    def snapshot(self) -> dict:
        latest = self.latest
        channels = []
        for channel in CHANNELS:
            buffer = self.buffers[channel.key]
            span = buffer.span
            newest = buffer.latest
            channels.append(
                {
                    "key": channel.key,
                    "index": channel.index,
                    "label": channel.label,
                    "unit": channel.unit,
                    "value": newest[1] if newest else None,
                    "at": newest[0] if newest else None,
                    "points": len(buffer),
                    "dropped": buffer.dropped,
                    "first_at": span[0] if span else None,
                    "last_at": span[1] if span else None,
                }
            )
        return {
            **self.spec.as_dict(),
            "origin": self.spec.origin,
            "status": "reading" if self.reading else self.status,
            "last_error": self.last_error,
            "opened_at": self.opened_at,
            "lines": self.lines,
            "samples": self.samples,
            "unparsed": self.unparsed,
            "last_unparsed": self.last_unparsed,
            "last_info": self.last_info,
            "last_info_at": self.last_info_at,
            "runs": self.runs,
            "session_mean": self.session_mean,
            "run_time": latest["run_time"] if latest else None,
            "run_time_seconds": latest["run_time_seconds"] if latest else None,
            "last_sample_at": latest["at"] if latest else None,
            "trace": self.trace(),
            "channels": channels,
            "recording": self.recording.as_dict() if self.recording else None,
            "next_run": runs.index.next_label(),
            "held_by": self.holders(),
        }

    def series(
        self,
        keys: list[str],
        start: float | None,
        end: float | None,
        max_points: int,
    ) -> list[dict]:
        """One window of samples per requested channel, decimated, with its mean."""
        out = []
        for key in keys:
            channel = CHANNEL_BY_KEY[key]
            times, values = self.buffers[key].window(start, end)
            total = len(times)
            # Every sample in the window, not the points that survived: an
            # average over kept extremes is biased by exactly the thing
            # decimation was chosen for.
            stats = {
                "mean": statistics.fmean(values) if values else None,
                "min": min(values) if values else None,
                "max": max(values) if values else None,
                "stdev": statistics.stdev(values) if len(values) > 1 else None,
                "count": total,
            }
            times, values, decimated = decimate(times, values, max_points)
            out.append(
                {
                    "key": key,
                    "index": channel.index,
                    "label": channel.label,
                    "unit": channel.unit,
                    "t": times,
                    "v": values,
                    "total": total,
                    "decimated": decimated,
                    "stats": stats,
                }
            )
        return out


def slug(name: str, taken: set[str]) -> str:
    base = "".join(char if char.isalnum() else "-" for char in name.lower()).strip("-")
    base = "-".join(part for part in base.split("-") if part) or "console"
    if base not in taken:
        return base
    for suffix in range(2, 500):
        candidate = f"{base}-{suffix}"
        if candidate not in taken:
            return candidate
    raise ValueError("too many sources with that name")


class Monitor:
    """Every console this service knows about."""

    def __init__(self) -> None:
        self._sources: dict[str, Source] = {}
        self._lock = threading.Lock()
        self.started_at = time.time()

    # -- registry --------------------------------------------------------

    def sources(self) -> list[Source]:
        with self._lock:
            return list(self._sources.values())

    def get(self, source_id: str) -> Source:
        with self._lock:
            try:
                return self._sources[source_id]
            except KeyError:
                raise KeyError(source_id) from None

    def add(self, spec: SourceSpec) -> Source:
        spec.validate()
        with self._lock:
            if not spec.id:
                spec.id = slug(spec.name, set(self._sources))
            existing = self._sources.get(spec.id)
            if existing is not None:
                # An edit. The buffers stay: renaming a console does not mean
                # throwing away the run you are watching.
                was_reading = existing.reading
                if was_reading:
                    existing.stop()
                existing.spec = spec
                source = existing
            else:
                source = Source(spec=spec)
                self._sources[spec.id] = source
                was_reading = False
        if was_reading:
            source.start()
        return source

    def remove(self, source_id: str) -> None:
        source = self.get(source_id)
        source.stop()
        with self._lock:
            self._sources.pop(source_id, None)

    def load(self, specs: list[SourceSpec]) -> None:
        for spec in specs:
            try:
                self.add(spec)
            except ValueError as err:
                log.warning("ignoring stored source %s: %s", spec.id, err)

    def stop_all(self) -> None:
        for source in self.sources():
            source.stop()

    # -- views -----------------------------------------------------------

    def snapshots(self) -> list[dict]:
        return [source.snapshot() for source in self.sources()]

    def config(self) -> dict:
        return {
            "started_at": self.started_at,
            "default_max_points": DEFAULT_MAX_POINTS,
            # Every timestamp this service hands out is on this clock, and the
            # chart asks for its window in the same numbers. A browser on
            # another machine whose clock is off would otherwise ask for a
            # window that does not overlap the samples and get an empty chart
            # with nothing to say why -- so the clock travels with the data.
            "server_time": time.time(),
        }


monitor = Monitor()
