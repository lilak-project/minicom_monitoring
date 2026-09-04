"""The one line on a CoBo console that carries numbers.

A GET-electronics CoBo prints its progress to the serial console every few
seconds, and in among the boot chatter and the shell prompt exactly one line is
periodic and quantitative::

    >>>   93.8 Mb/s   1225.3 intr/s   83937 intr.  0.00% mem. occupied  ;  1 min 13 s since run start <<<

`intr/s` is the trigger rate: one interrupt is one accepted trigger read out of
the board, so the number is the rate the experiment is actually taking data at.
The other three ride along on the same line and cost nothing to keep.

The regular expression is the one from ``shift_service/minicom_monitor``'s
``cobo_rate_logger.py``, unchanged, and the CSV columns below are that file's
columns in that file's order -- so a log written here and a log written there
are the same log, and either program can read either file.

Everything reaching this module has been through a terminal. A minicom capture
holds the escape sequences minicom was sent as well as the text, and a console
that redraws a status line leaves carriage returns in the middle of it, so the
text is cleaned before it is matched rather than the pattern being loosened to
tolerate the debris.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

RATE_RE = re.compile(
    r">>>\s*"
    # The board scales this one: a busy run reads `276.1 Mb/s`, an idle one
    # `83.6 kb/s`, and the two extremes of a spill have been seen as `b/s` and
    # `Gb/s`. Only the prefix changes, so it is captured and divided out --
    # matching `Mb/s` alone drops every quiet line on the floor, which is most
    # of them, silently.
    r"(?P<rate>\d+(?:\.\d+)?)\s*(?P<rate_prefix>[kmg]?)b/s\s+"
    r"(?P<intr_s>\d+(?:\.\d+)?)\s*intr/s\s+"
    r"(?P<intr>\d+)\s*intr\.\s+"
    r"(?P<mem_pct>\d+(?:\.\d+)?)%\s*mem\.\s*occupied\s*;\s*"
    r"(?P<run_time>.*?)\s+since\b",
    re.IGNORECASE,
)

#: To Mb/s, which is the unit the `mbps` column has always been in -- so a row
#: written from a `kb/s` line is comparable with one written from a `Mb/s` line
#: and with every file the logger this replaces wrote.
_RATE_SCALE = {"": 1e-6, "k": 1e-3, "m": 1.0, "g": 1e3}

#: A line that announces itself as a rate line. Used to notice when one of them
#: does not parse, which is how the `kb/s` case stayed invisible for a night.
RATE_MARK_RE = re.compile(r">>>.*intr/s", re.IGNORECASE)

#: CSI sequences, the OSC title-setting ones, and the lone two-character escapes
#: a terminal program emits. None of them are text and all of them appear in a
#: minicom capture.
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")

#: Anything else unprintable, backspace and the bell included.
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean(text: str) -> str:
    """A console line as a human read it, with the terminal's control bytes gone."""
    return _CONTROL_RE.sub("", _ANSI_RE.sub("", text)).strip()


@dataclass(frozen=True)
class Channel:
    """One number on the rate line, and how it is written."""

    key: str
    index: int
    label: str
    unit: str
    #: Long-form, for the axis and the reference panel.
    description: str


#: `index` is the position in the palette and in the wire format, and is fixed:
#: the trigger rate is series 0 and stays series 0, whatever a browser is
#: currently showing, so its colour does not change when another is added.
CHANNELS: tuple[Channel, ...] = (
    Channel("intr_per_s", 0, "Trigger rate", "intr/s",
            "Accepted triggers read out per second — what the run is taking data at."),
    Channel("mbps", 1, "Data rate", "Mb/s",
            "Bandwidth off the board. Rises with the trigger rate and with the number of "
            "channels above threshold in each event."),
    Channel("mem_pct", 2, "Buffer occupancy", "%",
            "How full the board's memory is. Sustained high occupancy means the readout "
            "is not keeping up and events are about to be dropped."),
    Channel("total_intr", 3, "Triggers", "intr",
            "Triggers since the run started. Monotonic; it resets when a new run does."),
)

CHANNEL_BY_KEY = {channel.key: channel for channel in CHANNELS}
CHANNEL_BY_INDEX = {channel.index: channel for channel in CHANNELS}

#: The trigger rate is what the page is for; everything else is context.
PRIMARY = CHANNELS[0]

#: Exactly the columns ``cobo_rate_logger.py`` writes, in its order.
CSV_FIELDS = (
    "timestamp_utc",
    "mbps",
    "intr_per_s",
    "total_intr",
    "mem_occupied_pct",
    "run_time",
    "run_time_seconds",
    "raw_line",
)

#: `mem_occupied_pct` in the file, `mem_pct` on the wire -- the file's name is
#: the one that already exists in every CSV written since June.
CSV_COLUMN = {"intr_per_s": "intr_per_s", "mbps": "mbps",
              "mem_pct": "mem_occupied_pct", "total_intr": "total_intr"}


def parse_duration_seconds(value: str) -> int | None:
    """"3 min 47 s" -> 227.  None when the text holds no duration at all."""
    total = 0.0
    found = False
    for amount, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([A-Za-z]+)", value):
        found = True
        number = float(amount)
        unit = unit.lower()
        if unit.startswith("day") or unit == "d":
            total += number * 86400
        elif unit.startswith("hour") or unit in {"h", "hr", "hrs"}:
            total += number * 3600
        elif unit.startswith("min") or unit == "m":
            total += number * 60
        elif unit.startswith("sec") or unit == "s":
            total += number
    return int(total) if found else None


def parse_rate_line(line: str, at: float | None = None) -> dict | None:
    """The four numbers out of one console line, or None if it is not one.

    `at` is the wall clock the line was read at. It is passed in rather than
    taken here because a capture file is replayed faster than it was written,
    and stamping a thousand backlogged lines with the same instant would put a
    vertical wall on the left of the chart.
    """
    match = RATE_RE.search(line)
    if not match:
        return None

    run_time = " ".join(match.group("run_time").split())
    stamp = datetime.fromtimestamp(at, timezone.utc) if at is not None else datetime.now(timezone.utc)
    scale = _RATE_SCALE[match.group("rate_prefix").lower()]
    # Rounded because the product of a printed 4-significant-figure number and
    # a power of ten is otherwise 0.13190000000000002 in the CSV.
    mbps = round(float(match.group("rate")) * scale, 9)
    return {
        "at": at,
        "timestamp_utc": stamp.isoformat(timespec="seconds"),
        "mbps": mbps,
        "intr_per_s": float(match.group("intr_s")),
        "total_intr": int(match.group("intr")),
        "mem_pct": float(match.group("mem_pct")),
        "run_time": run_time,
        "run_time_seconds": parse_duration_seconds(run_time),
        "raw_line": line,
    }
