"""Getting the console's bytes, from the port or from minicom's capture file.

Two ways in, because there are two situations and only one of them is a choice.

**The port.** ``/dev/ttyUSB1`` read directly, exactly as ``minicom -D`` reads
it. This is the better source -- nothing is between the board and the parser --
but it is exclusive in practice: Linux lets two processes open the same tty and
warns about neither, and they then split the byte stream between them, so both
lose most of their lines. So the port is checked before it is opened (see
``portlock``) and a held port is refused rather than quietly halved.

**The capture file.** ``minicom -D /dev/ttyUSB1 -C capture.log`` writes
everything it shows to a file, and reading that file costs the console nothing.
This is what to use while somebody is sitting at minicom -- which, on this
bench, is most of the time. The cost is that a capture is a *terminal*
recording, escape sequences and all; ``parser.clean`` deals with that.

Both are generators over lines, and above this module nothing knows which one
it has.
"""

from __future__ import annotations

import errno
import os
import select
import termios
import threading
from collections.abc import Iterator
from pathlib import Path

_BAUD = {
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
    230400: termios.B230400,
}

#: Baud rates offered in the UI.  115200 is what every CoBo on this bench runs.
BAUD_RATES = tuple(sorted(_BAUD))

#: The console prints a rate line every few seconds, so a poll that wakes twice
#: a second is prompt and costs nothing.
_POLL = 0.5


def configure_serial(fd: int, baud: int) -> None:
    """Raw 8N1 at `baud`, which is what a console speaks.

    VMIN 0 / VTIME 10 means a read returns after a second whether or not
    anything arrived, so the stop flag is checked at least that often.
    """
    constant = _BAUD.get(baud)
    if constant is None:
        supported = ", ".join(str(rate) for rate in BAUD_RATES)
        raise ValueError(f"unsupported baud rate {baud}; supported: {supported}")

    attrs = termios.tcgetattr(fd)
    attrs[0] = 0  # iflag: no translation, no flow control
    attrs[1] = 0  # oflag: nothing on the way out; we never write
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0  # lflag: raw, no echo, no line discipline
    attrs[4] = constant
    attrs[5] = constant
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 10
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def _split(buffer: bytearray) -> Iterator[str]:
    """Complete lines out of the buffer, on either kind of line ending.

    A console uses both, often in one line: the board writes ``\\r\\n`` and a
    program redrawing a status line writes a bare ``\\r``.
    """
    while True:
        positions = [pos for pos in (buffer.find(b"\n"), buffer.find(b"\r")) if pos >= 0]
        if not positions:
            return
        at = min(positions)
        line = bytes(buffer[:at])
        del buffer[: at + 1]
        while buffer[:1] in (b"\n", b"\r"):
            del buffer[:1]
        yield line.decode("utf-8", errors="replace")


def serial_lines(port: str, baud: int, stop: threading.Event) -> Iterator[str]:
    """Lines from a serial console until `stop` is set."""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY)
    try:
        configure_serial(fd, baud)
        buffer = bytearray()
        while not stop.is_set():
            readable, _, _ = select.select([fd], [], [], _POLL)
            if not readable:
                continue
            chunk = os.read(fd, 4096)
            if not chunk:
                continue
            buffer.extend(chunk)
            yield from _split(buffer)
    finally:
        os.close(fd)


def capture_tail(path: str, count: int = 20, size: int = 16384) -> list[str]:
    """The last few complete lines already in a capture, read once when it is opened.

    Following starts at the end (see `capture_lines`), so a board that has gone
    quiet would otherwise say nothing at all; these lines say what it said last.
    Missing or unreadable is simply nothing.
    """
    try:
        with open(path, "rb") as handle:
            end = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, end - size))
            buffer = bytearray(handle.read())
    except OSError:
        return []
    lines = list(_split(buffer))
    if end > size and lines:
        lines = lines[1:]          # the first one was cut in half by the window
    return lines[-count:]


def capture_lines(path: str, stop: threading.Event, from_start: bool = False) -> Iterator[str]:
    """Lines from a file that another program is appending to.

    ``tail -F``, not ``tail -f``: the file may not exist yet when the source is
    added (minicom has not been started), it may be truncated, and it may be
    replaced wholesale when somebody restarts minicom onto a fresh capture.
    Each of those is a normal event here and none of them should end the
    stream -- a monitor that stops following because the operator restarted
    minicom is a monitor that is wrong exactly when it is being used.
    """
    target = Path(path)
    handle = None
    inode: tuple[int, int] | None = None
    buffer = bytearray()

    def close() -> None:
        nonlocal handle, inode
        if handle is not None:
            handle.close()
        handle, inode = None, None

    try:
        while not stop.is_set():
            if handle is None:
                try:
                    handle = target.open("rb")
                except OSError as err:
                    if err.errno not in (errno.ENOENT, errno.EACCES):
                        raise
                    # Not there yet, or not ours to read. Say nothing and wait;
                    # the status line already reports the file is missing.
                    stop.wait(_POLL)
                    continue
                stat = os.fstat(handle.fileno())
                inode = (stat.st_dev, stat.st_ino)
                # A capture already running is joined at its end, so opening
                # the source does not replay hours of an old run onto the
                # chart at today's timestamps.
                if not from_start:
                    handle.seek(0, os.SEEK_END)

            chunk = handle.read(65536)
            if chunk:
                buffer.extend(chunk)
                yield from _split(buffer)
                continue

            # Nothing new. Check the file is still the file we are reading.
            try:
                fresh = target.stat()
            except OSError:
                close()
                stop.wait(_POLL)
                continue

            if (fresh.st_dev, fresh.st_ino) != inode:
                # Replaced: minicom restarted onto a new capture. Follow it,
                # from its beginning -- it is new, so nothing is replayed.
                close()
                from_start = True
                continue
            if fresh.st_size < handle.tell():
                # Truncated in place: start over rather than sit past the end.
                handle.seek(0)
                buffer.clear()
                continue

            stop.wait(_POLL)
    finally:
        close()
