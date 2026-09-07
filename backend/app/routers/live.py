"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub"}]}

now / mean intr/s and whether the capture is connected. When nothing is being
read right now (minicom closed, no capture, service just restarted) the LAST
values are shown instead of dashes -- taken from the newest CSV log this
service wrote -- marked with when they were taken. Never touches the serial
port on the request path.
"""

from __future__ import annotations

import csv
import io
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from .. import csvlog
from ..monitor import monitor

router = APIRouter(tags=["live"])

_TAIL_BYTES = 64 * 1024


def _last_from_csv() -> dict | None:
    """The newest logged sample (and a mean over the file's tail)."""
    files = csvlog.listing()
    if not files:
        return None
    try:
        path = csvlog.resolve(files[0]["filename"])
        with open(path, "rb") as fh:
            fh.seek(0, io.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - _TAIL_BYTES))
            chunk = fh.read().decode("utf-8", "replace")
        with open(path, encoding="utf-8") as fh:
            header = fh.readline().strip().split(",")
    except (OSError, ValueError):
        return None
    lines = [ln for ln in chunk.splitlines() if ln and not ln.startswith("timestamp")]
    if size > _TAIL_BYTES and lines:
        lines = lines[1:]                      # the first one may be cut
    rows = list(csv.DictReader(lines, fieldnames=header))
    if not rows:
        return None
    last = rows[-1]
    rates = []
    for r in rows:
        try:
            rates.append(float(r.get("intr_per_s") or ""))
        except ValueError:
            pass
    try:
        now = float(last.get("intr_per_s") or "")
    except ValueError:
        now = None
    return {"now": now, "mean": (sum(rates) / len(rates)) if rates else None,
            "at": last.get("timestamp_utc"), "total": last.get("total_intr"), "file": files[0]["filename"]}


def _when(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso).astimezone().strftime("%m-%d %H:%M")
    except ValueError:
        return str(iso)[:16]


@router.get("/api/live")
def live() -> dict:
    items = []
    for s in monitor.snapshots():
        chans = {c.get("key"): c for c in (s.get("channels") or [])}
        rate = chans.get("intr_per_s") or {}
        last_at = s.get("last_sample_at")
        fresh = last_at is not None and (time.time() - float(last_at)) < 15
        connected = s.get("status") == "reading"
        mean = s.get("session_mean")
        if isinstance(mean, dict):
            mean = mean.get("intr_per_s")
        now = rate.get("value")
        sub_now = ""
        if now is None or not fresh:
            # Not updating: show the last logged values, and say when they were taken.
            logged = _last_from_csv()
            if logged:
                if now is None:
                    now = logged["now"]
                if mean is None:
                    mean = logged["mean"]
                sub_now = f"last {_when(logged['at'])}"
        items.append({"label": "now", "value": "—" if now is None else f"{float(now):.0f}", "unit": "intr/s",
                      "state": "running" if (connected and fresh) else "off", "sub": sub_now})
        items.append({"label": "mean", "value": "—" if mean is None else f"{float(mean):.0f}", "unit": "intr/s", "state": ""})
        items.append({"label": "link", "value": "on" if connected else "off", "unit": "", "state": "ok" if connected else "down",
                      "sub": (s.get("last_error") or "")[:40]})
        break                                            # the first (active) source
    if not items:
        logged = _last_from_csv()
        if logged:
            items = [{"label": "now", "value": "—" if logged["now"] is None else f"{logged['now']:.0f}", "unit": "intr/s", "state": "off", "sub": f"last {_when(logged['at'])}"},
                     {"label": "mean", "value": "—" if logged["mean"] is None else f"{logged['mean']:.0f}", "unit": "intr/s", "state": ""},
                     {"label": "link", "value": "off", "unit": "", "state": "down"}]
        else:
            items.append({"label": "minicom", "value": "—", "unit": "", "state": "off", "sub": "no source"})
    return {"ok": True, "items": items}
