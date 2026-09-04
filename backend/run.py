#!/usr/bin/env python3
"""Start the minicom monitoring server.

    python run.py                          # listen on the LAN, port 8006
    python run.py --port 8007
    python run.py --host 127.0.0.1         # this machine only
    python run.py --capture /tmp/cobo.cap  # follow a capture file at start-up
    python run.py --port-device /dev/ttyUSB1
    python run.py --reload                 # development
"""

from __future__ import annotations

import argparse
import errno
import sys

import uvicorn

from app.config import DEFAULT_BAUD, STATIC_DIR
from app.monitor import SourceSpec, monitor
from app.net import browser_url, lan_addresses
from app import store


def _add_from_flags(args: argparse.Namespace) -> None:
    """A console named on the command line, added and marked autostart.

    Saved like one added from the page, so `--capture` once is enough and the
    next start already has it.
    """
    specs = []
    if args.port_device:
        specs.append(SourceSpec(id="", name=args.port_device.rsplit("/", 1)[-1],
                                kind="serial", port=args.port_device, baud=args.baud,
                                autostart=True))
    if args.capture:
        specs.append(SourceSpec(id="", name="minicom capture", kind="capture",
                                path=args.capture, autostart=True))
    if not specs:
        return
    monitor.load(store.load())
    for spec in specs:
        monitor.add(spec)
    store.save([source.spec for source in monitor.sources()])


def main() -> int:
    parser = argparse.ArgumentParser(description="minicom monitoring server")
    parser.add_argument("--host", default="0.0.0.0",
                        help="0.0.0.0 lets other PCs on the LAN connect")
    parser.add_argument("--port", type=int, default=8006, help="the HTTP port")
    parser.add_argument("--port-device", default="",
                        help="serial console to watch, e.g. /dev/ttyUSB1 (added and remembered)")
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    parser.add_argument("--capture", default="",
                        help="minicom capture file to follow (added and remembered)")
    parser.add_argument("--reload", action="store_true", help="restart on code changes")
    args = parser.parse_args()

    _add_from_flags(args)

    primary = browser_url(args.host, args.port)
    print(f"UI:        {primary}", flush=True)
    print(f"API docs:  {primary}/docs", flush=True)

    if args.host in ("127.0.0.1", "localhost"):
        print("Bound to loopback only - other machines cannot reach this.", flush=True)
    else:
        # This host is on the instrument subnet, the lab LAN and a VPN at once,
        # so list every address rather than guessing which one you came in on.
        others = [ip for ip in lan_addresses() if f"http://{ip}:{args.port}" != primary]
        if others:
            print("Also reachable at:", flush=True)
            for ip in others:
                print(f"  http://{ip}:{args.port}", flush=True)

    if not STATIC_DIR.is_dir():
        print(f"note: no frontend build at {STATIC_DIR}; run `npm run build` in frontend/",
              flush=True)

    try:
        uvicorn.run("app.main:app", host=args.host, port=args.port,
                    reload=args.reload, log_level="info")
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"Port {args.port} is already in use. "
                f"Either the server is already running, or retry with --port {args.port + 1}.",
                file=sys.stderr,
            )
            return 1
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
