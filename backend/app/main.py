"""minicom monitoring service.

Watches the CoBo console -- the thing you would otherwise be reading in
minicom -- and turns its periodic rate line into a trigger rate you can see
from across the room, a chart, a mean, and a CSV.

Serves a JSON API plus a WebSocket status stream, and (once the frontend is
built) the single-page UI from the same origin and port.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from . import csvlog, runs, store
from .config import STATIC_DIR
from .monitor import monitor
from . import elog
from .routers import logs, runs as runs_router, series, sources, status

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("minicom")


class _QuietPolling(logging.Filter):
    """Keep the chart's and the console's polling out of the access log.

    A browser following a live run re-reads its window and its scrollback every
    few seconds. At INFO that is a wall of identical lines and nothing else in
    the log is readable.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = str(args[2])
            return not (path.startswith("/api/sources/")
                        and ("/series" in path or "/console" in path))
        return True


logging.getLogger("uvicorn.access").addFilter(_QuietPolling())


def _open_autostart() -> None:
    """Re-open the consoles marked autostart, so a restart is not a re-setup."""
    for source in monitor.sources():
        if not source.spec.autostart:
            continue
        try:
            source.start()
        except Exception as err:  # noqa: BLE001
            # A board that is switched off, or a port minicom has, must not
            # stop the service coming up -- the panel says why, per console.
            log.warning("could not open %s: %s", source.spec.name, err)
            source.status = "error"
            source.last_error = str(err)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    runs.index.load()
    # Numbering has to clear the files as well as the index: a directory
    # carried over from another install, or from the logger this replaces,
    # holds run numbers no entry here knows about.
    runs.index.observe_files([item["filename"] for item in csvlog.listing()])
    # Nothing is recording yet, so every entry still marked open is one this
    # service was killed in the middle of. Rebuild those from their files
    # before anything adds to the index.
    runs.index.repair(set())
    monitor.load(store.load())
    _open_autostart()
    await status.broadcaster.start()
    try:
        yield
    finally:
        await status.broadcaster.stop()
        # Release the serial ports, and close every CSV cleanly.
        monitor.stop_all()


app = FastAPI(
    title="minicom Monitoring",
    description=(
        "The CoBo serial console as a web page. Reads the port directly, or follows "
        "the capture file minicom is writing, and plots the trigger rate it prints."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# The Vite dev server runs on another port; in production the UI is same-origin
# and these headers are simply unused.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"http://(localhost|127\.0\.0\.1"
        r"|10\.\d+\.\d+\.\d+"
        r"|192\.168\.\d+\.\d+"
        r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sources.router)
app.include_router(series.router)
app.include_router(runs_router.router)
app.include_router(logs.router)
app.include_router(status.router)
# The LILAK elog asks this service to fill a task log; see app/elog.py.
app.include_router(elog.router)


@app.get("/api/health", tags=["meta"])
async def health() -> dict:
    return {
        "ok": True,
        "sources": [source.spec.id for source in monitor.sources()],
        "reading": [source.spec.id for source in monitor.sources() if source.reading],
        "recording": [
            source.recording.run for source in monitor.sources() if source.recording
        ],
    }


class UiFiles(StaticFiles):
    """Serve the built UI, revalidating the entry point on every load.

    Vite fingerprints the asset filenames, so those can be cached hard. The
    HTML that points at them must not be, or a browser keeps running the
    previous build after a redeploy and calls endpoints that no longer exist.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith(".html") or path in ("", "."):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif response.status_code == 200 and "/assets/" in scope.get("path", ""):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if STATIC_DIR.is_dir():
    # Mounted last so it never shadows /api or /ws.
    app.mount("/", UiFiles(directory=STATIC_DIR, html=True), name="ui")
else:
    log.warning("Frontend build not found at %s - run `npm run build` in frontend/", STATIC_DIR)

    @app.get("/", tags=["meta"])
    async def missing_ui() -> dict:
        return {
            "ok": False,
            "error": "Frontend is not built.",
            "hint": "cd frontend && npm install && npm run build",
            "api_docs": "/docs",
        }
