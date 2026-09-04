"""The chart's window, and the console's scrollback."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..config import DEFAULT_MAX_POINTS, MAX_MAX_POINTS
from ..parser import CHANNEL_BY_KEY, PRIMARY
from ._helpers import find_source, run_io

router = APIRouter(prefix="/api", tags=["series"])


@router.get("/sources/{source_id}/series")
async def series(
    source_id: str,
    keys: str = Query(PRIMARY.key, description="comma-separated channel keys"),
    start: float | None = Query(None, alias="from"),
    end: float | None = Query(None, alias="to"),
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=4, le=MAX_MAX_POINTS),
) -> dict:
    """The samples between `from` and `to`, decimated, each with its mean.

    The mean is over every sample in the window rather than over the points
    that survived decimation -- min/max decimation keeps the extremes, so an
    average of what is drawn is an average of the peaks.
    """
    source = find_source(source_id)
    wanted = [key.strip() for key in keys.split(",") if key.strip()]
    unknown = [key for key in wanted if key not in CHANNEL_BY_KEY]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"No channel called {unknown[0]!r}; try one of {', '.join(CHANNEL_BY_KEY)}",
        )
    if not wanted:
        wanted = [PRIMARY.key]

    data = await run_io(source.series, wanted, start, end, max_points)
    return {
        "id": source_id,
        "name": source.spec.name,
        "start": start,
        "end": end,
        "max_points": max_points,
        "series": data,
    }


@router.get("/sources/{source_id}/console")
async def console(
    source_id: str,
    since: int = Query(0, ge=0, description="sequence number of the last line already held"),
    limit: int = Query(400, ge=1, le=2000),
) -> dict:
    """Raw console lines after `since` -- what minicom's screen would show.

    Polled rather than pushed. The console is quiet for seconds at a time and
    then prints a burst, and a poll that carries a sequence number costs one
    small request either way, where a socket per source would be a second
    connection per browser to keep alive for the sake of it.
    """
    source = find_source(source_id)
    lines, latest = source.console_since(since, limit)
    return {
        "id": source_id,
        "since": since,
        "latest": latest,
        # A tab left in the background misses more than it can be sent; saying
        # so is better than a scrollback with a silent hole in it.
        "gap": bool(lines) and lines[0]["seq"] > since + 1,
        "lines": lines,
    }
