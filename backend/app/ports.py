"""What serial ports exist, and what is on them.

pyserial enumerates them properly when it is installed; a plain glob is the
fallback, because a list of ports is not worth a hard dependency and the names
under ``/sys`` carry most of the same facts.
"""

from __future__ import annotations

from pathlib import Path

from . import portlock

try:  # pragma: no cover - depends on the host
    from serial.tools import list_ports as _list_ports
except ImportError:  # pragma: no cover
    _list_ports = None


def _sys_attr(device: str, *names: str) -> str:
    """A USB attribute of the device behind /dev/ttyUSBn, walking up to find it."""
    node = Path("/sys/class/tty") / Path(device).name / "device"
    for _ in range(6):
        for name in names:
            candidate = node / name
            try:
                return candidate.read_text().strip()
            except OSError:
                continue
        node = node / ".."
        if not node.exists():
            break
    return ""


def _fallback() -> list[dict]:
    found = []
    for pattern in ("ttyUSB*", "ttyACM*", "ttyS[0-3]"):
        found.extend(sorted(Path("/dev").glob(pattern)))
    out = []
    for path in found:
        device = str(path)
        vendor = _sys_attr(device, "manufacturer")
        product = _sys_attr(device, "product")
        out.append(
            {
                "device": device,
                "description": " ".join(part for part in (vendor, product) if part) or "serial port",
                "hwid": _sys_attr(device, "idVendor") and
                        f"{_sys_attr(device, 'idVendor')}:{_sys_attr(device, 'idProduct')}",
                "serial_number": _sys_attr(device, "serial") or None,
            }
        )
    return out


def list_ports() -> list[dict]:
    """Every serial port, with whoever already has it open.

    `held_by` is the field that matters on this bench: minicom is usually on
    one of these, and the Sources tab says so beside the port rather than
    letting the operator find out by being refused.
    """
    if _list_ports is not None:
        ports = [
            {
                "device": port.device,
                # pyserial writes the string "n/a" where it knows nothing,
                # which would otherwise read as a device called n/a.
                "description": _tidy(_real(port.description)) or "serial port",
                "hwid": _real(port.hwid),
                "serial_number": port.serial_number,
            }
            for port in _list_ports.comports()
        ]
    else:
        ports = _fallback()

    out = []
    for port in ports:
        name = Path(port["device"]).name
        # A PC advertises thirty-two /dev/ttyS lines and has hardware behind at
        # most one of them. Listing the empty ones would bury the two USB
        # adapters that are actually here in a list nobody can scan, so a
        # built-in line is offered only when something is plugged into it.
        if name.startswith("ttyS") and not port["hwid"]:
            continue
        port["physical"] = True
        port["held_by"] = portlock.holders(port["device"])
        out.append(port)
    out.sort(key=lambda port: port["device"])
    return out


def _real(value: str | None) -> str:
    """pyserial's "n/a" is not a description; it is the absence of one."""
    text = (value or "").strip()
    return "" if text in ("", "n/a") else text


def _tidy(description: str) -> str:
    """Collapse pyserial's "X - X".

    It joins the product string to the interface string, and on a single-port
    adapter those are the same words twice.
    """
    parts = [part.strip() for part in description.split(" - ")]
    if len(parts) == 2 and parts[0] == parts[1]:
        return parts[0]
    return description
