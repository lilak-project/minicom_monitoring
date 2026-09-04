"""The CSVs this service has written."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import csvlog
from ..parser import CSV_FIELDS
from ._helpers import run_io

router = APIRouter(prefix="/api", tags=["logs"])


@router.get("/logs")
async def list_logs() -> dict:
    return {
        "csv_dir": str(csvlog.CSV_DIR),
        "columns": list(CSV_FIELDS),
        "logs": await run_io(csvlog.listing),
    }


@router.get("/logs/{filename}/download")
async def download(filename: str) -> FileResponse:
    try:
        path = csvlog.resolve(filename)
    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    return FileResponse(path, media_type="text/csv", filename=path.name)
