"""Shared client for resolving the active crisis operation at a precise location.

Used by the GPS-capable chat channels (Telegram, WhatsApp) at report intake:
when the reporter shared a precise location, ask the backend which crisis
operation is active there so the report links to it (Report.crisis_event_id).

Non-GPS channels (SMS, IVR) deliberately do NOT call this - their text/audio
geocoded locations are too coarse to trust for zone-matching, so they stay
GLOBAL (no fake-matching). The backend treats the returned event id as a hint
and re-derives the linkage authoritatively from the submitted location, so a
stale lookup here can never mislabel a report.
"""
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")


async def resolve_active_event_id(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    """Return the id of the active CrisisEvent whose zone covers (lat, lng), or
    None when there is no active zone / the lookup fails.

    Never raises - any failure (no active zone, network error, non-200 status)
    returns None so the caller submits a GLOBAL report unchanged.
    """
    if lat is None or lng is None:
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{BACKEND_URL}/api/v1/crisis-forms/active",
                params={"lat": lat, "lng": lng},
                headers={"Accept": "application/json"},
            )
        if r.status_code != 200:
            return None
        data = r.json() or {}
        if data.get("active") and data.get("event_id"):
            return data["event_id"]
    except Exception as e:
        logger.warning("active-event lookup failed at (%s,%s): %s", lat, lng, e)
    return None
