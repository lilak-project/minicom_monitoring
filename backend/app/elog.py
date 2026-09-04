"""The LILAK elog endpoint: one POST that answers both of elog's questions.

elog talks to a service through a single URL. Two different bodies arrive on it:

    {"event": "elog_handshake", "elog_url": …}
        -> who we are and what fields we can fill (Discover, once, at registration)

    {"format_id", "format_name", "task_log_id", "run_number", "requested_at", "mode"}
        -> the values themselves (every fill, on a task or on a schedule)

Two rules shape everything below.

**Five seconds.** elog gives up after that (`WEBHOOK_TIMEOUT_SEC`) and turns the
task into a manual one with the error as a comment. `mode` may also be
"realtime", which repeats as often as twice a second. So a reader here must be
cheap and must never block on hardware it does not already hold.

**The field list is fixed.** elog builds a log format from `log_fields` at
registration and matches it later by name *and* field signature: declare a
different set and a second format appears rather than the first one changing.
So `log_fields` must come from configuration, never from what is currently
plugged in, connected or selected -- otherwise unplugging a cable forks the
format and last week's entries stop lining up with this week's.

Copied into each service rather than shared from one place: these services are
each movable as a single folder (SERVICE_CONTRACT §9), and a shared import
would tie them together at runtime for eighty lines.
"""

from __future__ import annotations

import logging
import socket
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("elog")

HANDSHAKE = "elog_handshake"

#: A field elog can put on a log format.
#: `type` is one of number_entry | number | text | body | title | tags | level.
#: `metric` (number types only) makes it an Infography variable.
Field = dict[str, Any]


def number(key: str, label: str, unit: str = "", metric: bool = True) -> Field:
    """A numeric field. number_entry is the shape elog normalises to {value,error}."""
    return {"key": key, "label": label, "type": "number_entry", "unit": unit, "metric": metric}


def text(key: str, label: str) -> Field:
    return {"key": key, "label": label, "type": "text"}


def body(label: str = "Summary") -> Field:
    return {"key": "body", "label": label, "type": "body"}


def value(number_value: float | None, error: float = 0.0) -> dict:
    """One number_entry value. None stays None -- a channel that reported
    nothing is not the same as one that reported zero."""
    return {"value": None if number_value is None else float(number_value), "error": error}


def make_router(
    *,
    service_name: str,
    description: str,
    log_fields: list[Field] | Callable[[], Awaitable[list[Field]]],
    read: Callable[[dict], Awaitable[dict]],
    directory: str = "",
    path: str = "/api/elog",
) -> APIRouter:
    """The endpoint. `read(envelope)` returns the `fields` dict for one request.

    `log_fields` is normally a plain list -- a constant, which is what the
    "fixed field list" rule above asks for. It may instead be an async callable
    for a service whose fields come from its own saved configuration (which
    actuators are set up, say). That is still configuration and still stable;
    it just cannot be written down at import time. Such a callable should RAISE
    rather than return a short list when it cannot read that configuration, so
    Discover fails loudly instead of quietly registering half a format.

    Mount this BEFORE any catch-all `/api/{path}` route: FastAPI matches in
    registration order, and the read-only mirrors answer 405 to every POST they
    do not recognise -- including this one.
    """
    router = APIRouter(tags=["elog"])

    @router.post(path, summary="LILAK elog handshake and data request")
    async def elog_endpoint(request: Request):
        try:
            envelope = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"detail": "body must be JSON"})
        if not isinstance(envelope, dict):
            return JSONResponse(status_code=400, content={"detail": "body must be a JSON object"})

        event = envelope.get("event")
        if event == HANDSHAKE:
            log.info("elog handshake from %s", envelope.get("elog_url") or "?")
            try:
                fields = log_fields if isinstance(log_fields, list) else await log_fields()
            except Exception as err:
                log.warning("handshake refused: %s", err)
                return JSONResponse(status_code=503, content={"detail": str(err)})
            return {
                "name": service_name,
                "description": description,
                "hostname": socket.gethostname(),
                "directory": directory,
                # A service, not a system: elog asks us, we never push runs at it.
                "is_system": False,
                "log_fields": fields,
            }
        if event:
            # Only the handshake is an event. Anything else is a system-only
            # message (elog_credentials) or a typo, and answering it with
            # readings would be worse than saying so.
            return JSONResponse(
                status_code=400,
                content={"detail": f"unknown event {event!r}; this is a plain service, not a system"},
            )

        fields = await read(envelope)
        return {"fields": fields}

    return router


# ── This service's answer ────────────────────────────────────────────────────

from .config import LOG_ROOT                                       # noqa: E402
from .monitor import monitor                                       # noqa: E402
from .parser import PRIMARY                                        # noqa: E402

#: The window "recent rate" is averaged over. One minute is short enough that a
#: beam trip shows up in the next fill, and long enough that the per-second
#: jitter of the console line does not.
MEAN_WINDOW_SEC = 60.0

#: Fixed, however many consoles are configured. The PRIMARY console's two rates
#: are the graphable numbers; every console is listed in the body.
LOG_FIELDS = [
    number("intr_per_s", "Trigger rate (latest)", "intr/s"),
    number("intr_per_s_1min", "Trigger rate (mean over 1 min)", "intr/s"),
    text("console", "Console"),
    text("run_time", "Time since run start"),
    body("Every console"),
]


def _latest(snapshot: dict) -> float | None:
    """The last trigger rate this console printed."""
    for channel in snapshot.get("channels", []):
        if channel.get("key") == PRIMARY.key:
            return channel.get("value")
    return None


def _fmt(rate: float | None) -> str:
    return "—" if rate is None else f"{rate:,.1f}"


async def read(envelope: dict) -> dict:
    """The rates already in memory.

    Never opens a serial port and never waits on one: the reader thread owns
    the port, and this only reads the buffers it has already filled. That is
    what makes the endpoint safe to call in elog's realtime mode.
    """
    sources = monitor.sources()

    rows = []
    for source in sources:
        snapshot = source.snapshot()
        rows.append((snapshot, _latest(snapshot), source.mean_over(MEAN_WINDOW_SEC)))

    # The console this service is really about: the first one still reading.
    # Falls back to the first configured one, so a stopped console reports
    # itself with null rates rather than disappearing from the log.
    reading = [row for row in rows if row[0].get("status") == "reading"]
    primary = (reading or rows or [(None, None, None)])[0]

    lines = [
        f"{(snapshot.get('name') or snapshot['id']):<16} {snapshot['status']:<9} "
        f"last {_fmt(latest):>10}  1 min {_fmt(mean):>10}  intr/s"
        for snapshot, latest, mean in rows
    ] or ["No console is configured."]

    snapshot, latest, mean = primary
    return {
        "intr_per_s": value(latest),
        "intr_per_s_1min": value(mean),
        "console": (snapshot or {}).get("name") or (snapshot or {}).get("id") or "",
        "run_time": (snapshot or {}).get("run_time") or "",
        "body": "\n".join(lines),
    }


router = make_router(
    service_name="minicom Monitoring",
    description="CoBo console trigger rate — the latest intr/s and its mean over the last minute.",
    log_fields=LOG_FIELDS,
    read=read,
    directory=str(LOG_ROOT),
)
