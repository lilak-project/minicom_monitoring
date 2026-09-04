"""Recordings: starting and stopping one, and what has been recorded."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import csvlog, runs
from ..parser import CSV_FIELDS
from ..schemas import RecordingRequest
from ._helpers import find_source, run_io

router = APIRouter(prefix="/api", tags=["runs"])


@router.post("/sources/{source_id}/recording/start")
async def start_recording(source_id: str, request: RecordingRequest) -> dict:
    """Begin a run file.  Whatever was recording on this console is closed first."""
    source = find_source(source_id)
    try:
        entry = await run_io(source.start_recording, request.run or None, request.note)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except OSError as err:
        raise HTTPException(status_code=409, detail=f"could not open the run file: {err}") from err
    return entry.as_dict()


@router.post("/sources/{source_id}/recording/stop")
async def stop_recording(source_id: str) -> dict:
    """Close the run file.  The console keeps reading and charting."""
    source = find_source(source_id)
    entry = await run_io(source.stop_recording)
    if entry is None:
        raise HTTPException(status_code=409, detail="This console is not recording.")
    return entry.as_dict()


@router.get("/runs")
async def list_runs() -> dict:
    """Every recording, newest first, with its summary."""
    recorded = [entry.as_dict() for entry in runs.index.all()]
    recorded.sort(key=lambda entry: entry["started_at"], reverse=True)
    known = {entry["filename"] for entry in recorded}
    return {
        "csv_dir": str(csvlog.CSV_DIR),
        "columns": list(CSV_FIELDS),
        "next_run": runs.index.next_label(),
        "runs": recorded,
        # CSVs in the directory that no recording accounts for -- copied in by
        # hand, or written by the logger this service replaces. Listed rather
        # than hidden, because a file in the log directory that the page does
        # not mention is a file somebody will assume was lost.
        "unlisted": [
            item for item in await run_io(csvlog.listing) if item["filename"] not in known
        ],
    }


@router.get("/runs/{run_id}")
async def read_run(run_id: str) -> dict:
    entry = runs.index.get(run_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"No recording {run_id!r}")
    return entry.as_dict()
