"""Who else has a serial port open.

Linux will happily let two processes open the same tty. Nothing stops it and
nothing warns about it -- both then read from the same stream and each gets
whichever bytes the other did not, which for a gauge that free-runs a checksummed
frame means both sides silently lose most of their readings.

That is a live hazard here: minicom is usually sitting on the console this
service wants, and opening it anyway would not fail -- it would halve both. So
the port is checked before it is opened, and the answer is shown in the Sources
tab beside the port rather than only appearing as a refusal after the fact. The
way out is the capture source, which reads what minicom is already writing and
costs the port nothing.

Two checks, because neither is enough on its own.

`/proc/<pid>/fd` names the process exactly, but only for processes this user
can see -- and minicom on this bench is started with `sudo`, so its file
descriptors are unreadable and the scan comes back empty on the one case that
matters most.

The UUCP lock file covers that. `minicom`, `cu`, `screen`, `picocom` and the
rest all create `/run/lock/LCK..<port>` holding the owner's pid before they
open a port, and remove it after; it is the convention that has kept two
terminal programs off one modem since before any of them. It is readable by
anybody, so it sees a root minicom that the /proc scan cannot, and this service
writes one itself while a port is open so the exclusion runs both ways.

A lock file naming a pid that no longer exists is stale -- a program killed with
SIGKILL leaves one behind -- and is reported as such rather than as a holder,
because treating it as one would make the port permanently unopenable.
"""

from __future__ import annotations

import errno
import os
import re
from pathlib import Path

_PROC = Path("/proc")

#: Where the UUCP lock files live. /var/lock is a symlink to the first on every
#: distribution that has both; the second is here for the ones that do not.
_LOCK_DIRS = (Path("/run/lock"), Path("/var/lock"))


def _command(pid: str) -> str:
    try:
        raw = (_PROC / pid / "cmdline").read_bytes()
    except OSError:
        return ""
    return " ".join(part for part in raw.decode("utf-8", "replace").split("\0") if part)


#: Naming the interpreter tells nobody anything; the script it is running does.
_INTERPRETERS = ("python", "python3", "sh", "bash", "node", "perl", "ruby")


def short_name(command: str) -> str:
    """"cmms_web.py" out of "python3 cmms_web.py --host 0.0.0.0 --port 8000"."""
    parts = command.split()
    if not parts:
        return "a process"
    first = os.path.basename(parts[0])
    if any(first.startswith(name) for name in _INTERPRETERS):
        for part in parts[1:]:
            if not part.startswith("-"):
                return os.path.basename(part)
    return first


def holders(port: str, exclude_self: bool = True) -> list[dict]:
    """Every process holding `port` open, as {pid, command, name}.

    Returns an empty list when the port is free, when it does not exist, or on
    any platform without /proc and without a lock file -- a check that cannot
    run must not become a refusal to open a port that is in fact available.
    """
    if not port:
        return []
    found = _fd_holders(port, exclude_self)
    lock = lock_holder(port)
    # The lock file usually names a process the /proc scan already found; it is
    # only news when it does not, which is the sudo case.
    if lock and not lock["stale"] and lock["pid"] != os.getpid():
        if not any(item["pid"] == lock["pid"] for item in found):
            found.append(lock)
    return found


def _fd_holders(port: str, exclude_self: bool = True) -> list[dict]:
    """Processes this user can see with `port` open, from /proc."""
    if not _PROC.is_dir():
        return []
    try:
        target = os.path.realpath(port)
    except OSError:
        return []

    mine = str(os.getpid())
    found: list[dict] = []
    for entry in _PROC.iterdir():
        if not entry.name.isdigit() or (exclude_self and entry.name == mine):
            continue
        fd_dir = entry / "fd"
        try:
            handles = list(fd_dir.iterdir())
        except OSError:
            continue  # another user's process, or it exited mid-scan
        for handle in handles:
            try:
                if os.path.realpath(handle) == target:
                    command = _command(entry.name)
                    found.append(
                        {
                            "pid": int(entry.name),
                            "command": command,
                            "name": short_name(command),
                            "via": "open file descriptor",
                            "stale": False,
                        }
                    )
                    break
            except OSError:
                continue
    return found


def describe(port: str) -> str:
    """A sentence naming what already has the port, or "" when it is free."""
    found = holders(port)
    if not found:
        return ""
    who = ", ".join(
        f"{item['name']} (pid {item['pid']}{', by its lock file' if item.get('via') == 'lock file' else ''})"
        for item in found
    )
    return f"{port} is already open by {who}"


# -- UUCP lock files ---------------------------------------------------


def lock_path(port: str, directory: Path | None = None) -> Path:
    """`/run/lock/LCK..ttyUSB1` for `/dev/ttyUSB1`."""
    name = os.path.basename(os.path.realpath(port) if port.startswith("/dev/") else port)
    return (directory or _LOCK_DIRS[0]) / f"LCK..{name}"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError as err:
        # EPERM means it exists and belongs to somebody else, which is exactly
        # the case this check was added for.
        return err.errno == errno.EPERM
    return True


def lock_holder(port: str) -> dict | None:
    """The process named by the port's lock file, or None.

    A stale lock -- one whose pid is gone -- comes back with `stale` set, so
    the caller can say so instead of reporting a holder that is not there.
    """
    for directory in _LOCK_DIRS:
        path = lock_path(port, directory)
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        match = re.search(r"\d+", text)
        if not match:
            continue
        pid = int(match.group())
        command = _command(str(pid))
        return {
            "pid": pid,
            "command": command,
            # A root process's cmdline is unreadable too; the lock file at
            # least says something has the port.
            "name": short_name(command) if command else "a lock file",
            "via": "lock file",
            "stale": not _alive(pid),
            "path": str(path),
        }
    return None


class PortLock:
    """Hold the UUCP lock file for a port for as long as this service has it.

    Best effort by design: `/run/lock` is world-writable on every machine this
    runs on, but if it is not, failing to take the lock must not stop the
    console being read -- the lock is a courtesy to the next program, not this
    one's own exclusion.
    """

    def __init__(self, port: str) -> None:
        self.port = port
        self.path: Path | None = None

    def acquire(self) -> None:
        path = lock_path(self.port)
        try:
            # O_EXCL, so two services racing for the same port cannot both
            # believe they took it.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError:
            holder = lock_holder(self.port)
            if holder and not holder["stale"]:
                return  # somebody has it; the caller already refused to open
            # Stale: the program that wrote it is gone. Take it over.
            try:
                path.unlink()
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            except OSError:
                return
        except OSError:
            return
        # The UUCP format: ten characters of ASCII pid and a newline, which is
        # what minicom and the others parse.
        with os.fdopen(fd, "w") as handle:
            handle.write(f"{os.getpid():10d}\n")
        self.path = path

    def release(self) -> None:
        if self.path is None:
            return
        try:
            # Only ours: if something else took it over in between, leaving it
            # alone is right.
            holder = lock_holder(self.port)
            if holder is None or holder["pid"] == os.getpid():
                self.path.unlink(missing_ok=True)
        except OSError:
            pass
        self.path = None
