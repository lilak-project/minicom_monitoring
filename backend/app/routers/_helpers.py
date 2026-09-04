"""Shared bits of the route layer."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

from ..monitor import Source, monitor


async def run_io(func, *args, **kwargs) -> Any:
    """Run a blocking call off the event loop.

    Opening a tty waits on the driver and listing the ports walks /proc for
    every process on the machine; neither belongs on the loop that is also
    serving the status socket.
    """
    return await run_in_threadpool(func, *args, **kwargs)


def find_source(source_id: str) -> Source:
    try:
        return monitor.get(source_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No console {source_id!r}") from None
