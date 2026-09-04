"""The consoles this service remembers, in one JSON file.

Small enough that the whole file is rewritten on every change, and written
through a temporary file so a service killed mid-save leaves the previous list
rather than half of the new one.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile

from .config import SOURCE_FILE
from .monitor import SourceSpec

log = logging.getLogger(__name__)


def load() -> list[SourceSpec]:
    try:
        raw = json.loads(SOURCE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as err:
        log.warning("could not read %s: %s", SOURCE_FILE, err)
        return []
    if not isinstance(raw, list):
        return []
    return [SourceSpec.from_dict(item) for item in raw if isinstance(item, dict)]


def save(specs: list[SourceSpec]) -> None:
    SOURCE_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps([spec.as_dict() for spec in specs], indent=2) + "\n"
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=SOURCE_FILE.parent, prefix=".sources-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, SOURCE_FILE)
    except OSError:
        os.unlink(handle.name)
        raise
