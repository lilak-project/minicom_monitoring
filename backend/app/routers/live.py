"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state"}], "note": ""}

Assembled from state the service already holds; never touches hardware or a
remote host on the request path, so it is safe to poll every few seconds.
"""

from __future__ import annotations

import time

from fastapi import APIRouter

from ..monitor import monitor

router = APIRouter(tags=["live"])


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
        items.append({"label": "now", "value": "—" if rate.get("value") is None else f"{float(rate['value']):.0f}", "unit": "intr/s",
                      "state": "running" if (connected and fresh) else ("warn" if connected else "down")})
        items.append({"label": "mean", "value": "—" if mean is None else f"{float(mean):.0f}", "unit": "intr/s", "state": ""})
        items.append({"label": "link", "value": "on" if connected else "off", "unit": "", "state": "ok" if connected else "down",
                      "sub": (s.get("last_error") or "")[:40]})
        break                                            # the first (active) source
    if not items:
        items.append({"label": "minicom", "value": "—", "unit": "", "state": "off", "sub": "no source"})
    return {"ok": True, "items": items}
