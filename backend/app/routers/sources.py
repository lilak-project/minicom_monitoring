"""The consoles: listing them, adding one, and opening or closing it."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import ports as ports_module
from .. import store
from ..config import DEFAULT_CAPTURE_PATH
from ..monitor import SourceSpec, monitor
from ..parser import CHANNELS, PRIMARY
from ..reader import BAUD_RATES
from ..schemas import SourceRequest
from ._helpers import find_source, run_io

router = APIRouter(prefix="/api", tags=["sources"])


def _persist() -> None:
    store.save([source.spec for source in monitor.sources()])


@router.get("/sources")
async def list_sources() -> dict:
    """Every console, with its current reading."""
    return {**monitor.config(), "sources": monitor.snapshots()}


@router.get("/ports")
async def serial_ports() -> list[dict]:
    """Every serial port on this machine, and who already has it open."""
    return await run_io(ports_module.list_ports)


@router.get("/reference")
async def reference() -> dict:
    """What the numbers are, and the two ways to get at them.

    Static, so the page explains itself with nothing connected.
    """
    return {
        "primary": PRIMARY.key,
        "channels": [
            {
                "key": channel.key,
                "index": channel.index,
                "label": channel.label,
                "unit": channel.unit,
                "description": channel.description,
            }
            for channel in CHANNELS
        ],
        "baud_rates": list(BAUD_RATES),
        "default_capture_path": DEFAULT_CAPTURE_PATH,
        "kinds": [
            {
                "id": "serial",
                "label": "Serial port",
                "detail": (
                    "Read the console directly, the way minicom does. Nothing sits between "
                    "the board and the parser — but the port is exclusive, so minicom has "
                    "to be closed first."
                ),
            },
            {
                "id": "capture",
                "label": "minicom capture file",
                "detail": (
                    "Follow the file minicom is already writing: start it as "
                    "minicom -D /dev/ttyUSB1 -C capture.log. Costs the console nothing "
                    "and leaves minicom exactly as it was."
                ),
            },
        ],
    }


@router.put("/sources")
async def save_source(request: SourceRequest) -> dict:
    """Add a console, or edit one.  Does not open it."""
    spec = SourceSpec(
        id=request.id.strip(),
        name=request.name.strip(),
        kind=request.kind,
        port=request.port.strip(),
        baud=request.baud,
        path=request.path.strip(),
        autostart=request.autostart,
    )
    try:
        monitor.add(spec)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    _persist()
    return {**monitor.config(), "sources": monitor.snapshots()}


@router.delete("/sources/{source_id}", status_code=204)
async def delete_source(source_id: str) -> None:
    find_source(source_id)
    await run_io(monitor.remove, source_id)
    _persist()


@router.post("/sources/{source_id}/connect")
async def connect(source_id: str) -> dict:
    source = find_source(source_id)
    try:
        await run_io(source.start)
    except (RuntimeError, ValueError, OSError) as err:
        # Verbatim: the message names the port, or the process holding it.
        raise HTTPException(status_code=409, detail=str(err)) from err
    return source.snapshot()


@router.post("/sources/{source_id}/disconnect")
async def disconnect(source_id: str) -> dict:
    source = find_source(source_id)
    await run_io(source.stop)
    return source.snapshot()
