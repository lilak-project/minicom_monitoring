"""Request bodies.  Responses are plain dicts built by `monitor`."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .config import DEFAULT_BAUD


class SourceRequest(BaseModel):
    """A console to watch: a serial port, or a file minicom is writing."""

    id: str = ""
    name: str = Field(..., min_length=1, max_length=60)
    kind: str = "serial"
    port: str = ""
    baud: int = DEFAULT_BAUD
    path: str = ""
    autostart: bool = False


class RecordingRequest(BaseModel):
    """Start a recording.  An empty run means "the next number"."""

    run: str = Field("", max_length=40)
    note: str = Field("", max_length=200)
