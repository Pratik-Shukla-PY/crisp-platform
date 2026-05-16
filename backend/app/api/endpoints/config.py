"""
Public deployment-config endpoint.

Exposes a small JSON document with the deployment-tunable flags that
the PWA + RN clients need to know at boot. Always unauthenticated —
these flags are not secrets, they're behaviour switches the operator
sets per deployment (region sensitivity, density thresholds, etc).

Why a dedicated endpoint instead of bundling into every response:
  • Clients need it ONCE at boot, not on every poll.
  • Cacheable by Cloudflare / browser (5 min) — zero per-request cost.
  • New flags can land without reshaping high-traffic responses.

Currently exposes:
  • citizen_t1_visibility — whether Tier-1 "Weak Signal" nearby groups
    surface to citizens (admins always see them). See
    docs/NEARBY_REPORTS_PIPELINE.md §3.2 + §14.

Future flags (Phase 2-4) will add density buckets, disaster-mode
thresholds, push frequency caps, etc. — each landing in its own
top-level key here.
"""
from fastapi import APIRouter, Response

from app.core.config import settings


router = APIRouter()


@router.get("/")
def get_config(response: Response) -> dict:
    """Return deployment-tunable client flags. 5-minute browser cache."""
    response.headers["Cache-Control"] = "public, max-age=300"
    return {
        "nearby": {
            "citizen_t1_visibility": settings.CRISP_CITIZEN_T1_VISIBILITY,
        },
    }
