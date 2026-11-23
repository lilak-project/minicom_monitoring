"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub"}]}

now / mean intr/s, an hour of trigger rate behind the number, and whether the
capture is connected. When nothing is being
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

#: How much of the past the sparkline shows, with how many points, and how
#: often it is recomputed however fast the wall polls.
SPARK_WINDOW_SEC = 3600.0
SPARK_POINTS = 60
SPARK_TTL = 15.0
_spark_cache: dict[str, tuple[float, list[float]]] = {}


def _spark(source_id: str) -> list[float]:
    """The last hour of trigger rate for one source, from the ring buffer."""
    held = _spark_cache.get(source_id)
    now = time.monotonic()
    if held is not None and now - held[0] < SPARK_TTL:
        return held[1]
    values: list[float] = []
    try:
        source = next((s for s in monitor.sources() if s.spec.id == source_id), None)
        if source is not None:
            series = source.series(["intr_per_s"], time.time() - SPARK_WINDOW_SEC, None, SPARK_POINTS)
            values = [float(v) for v in (series[0]["v"] if series else []) if v is not None]
    except Exception:                      # a source with no buffer yet
        values = []
    if len(values) < 2:
        values = []
    _spark_cache[source_id] = (now, values)
    return values


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


def _num(value) -> str:
    """The All tab's way: four significant figures, thousands grouped past 1000."""
    if value is None:
        return "—"
    v = float(value)
    return f"{v:,.0f}" if abs(v) >= 1000 else f"{v:.4g}"


@router.get("/api/live")
def live() -> dict:
    """One tile per console marked for live mode -- the All tab's card: the rate
    large, the hour behind it, data / memory and the board's last message under it."""
    items = []
    for s in monitor.snapshots():
        if not s.get("live", True):
            continue
        chans = {c.get("key"): c.get("value") for c in (s.get("channels") or [])}
        last_at = s.get("last_sample_at")
        reading = s.get("status") == "reading"
        fresh = reading and last_at is not None and time.time() - float(last_at) < 60
        state = "alarm" if s.get("status") == "error" else "running" if fresh else "warn" if reading else "off"
        if reading and chans.get("intr_per_s") is not None:
            facts = f"{_num(chans.get('mbps'))} MB/s · mem {float(chans.get('mem_pct') or 0):.2f} %"
        else:
            facts = (s.get("last_error") or ("closed" if not reading else "waiting"))[:60]
        said = s.get("last_info") or ""
        items.append({
            "label": s.get("name") or s.get("id"),
            "value": _num(chans.get("intr_per_s")) if reading else "—",
            "unit": "intr/s",
            "state": state,
            "sub": f"{facts} · {said}" if said else facts,
            "title": said or None,
            "spark": _spark(s.get("id") or ""),
            "spark_window": "1 h",
        })
    if not items:
        logged = _last_from_csv()
        if logged:
            items = [{"label": "now", "value": "—" if logged["now"] is None else f"{logged['now']:.0f}", "unit": "intr/s", "state": "off", "sub": f"last {_when(logged['at'])}"},
                     {"label": "mean", "value": "—" if logged["mean"] is None else f"{logged['mean']:.0f}", "unit": "intr/s", "state": ""},
                     {"label": "link", "value": "off", "unit": "", "state": "down"}]
        else:
            items.append({"label": "minicom", "value": "—", "unit": "", "state": "off", "sub": "no source"})
    return {"ok": True, "items": items}
