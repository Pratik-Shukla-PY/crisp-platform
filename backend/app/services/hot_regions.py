"""
Hot-region snapshot service.

Phase 5.1 (May 2026, docs/NEARBY_REPORTS_PIPELINE.md §9.5) - step G4
of the geospatial scaling roadmap. Provides the read + refresh helpers
used by:

  - The /nearby endpoint   - `lookup_fresh_snapshot(lat, lng, db)`
  - The admin CRUD + refresh endpoints in api/endpoints/hot_regions.py

The actual aggregator call (`aggregate_nearby` + the surrounding query)
lives in api/endpoints/reports.py; this module's `refresh_region`
delegates back to a thin reusable entry point we expose there.

OPT-IN GATE:

  Operators flip `CRISP_NEARBY_HOT_REGIONS=1` to consume snapshots on
  the /nearby read path. The admin CRUD endpoints are gated by
  `require_admin` regardless - the table itself stays writable so
  operators can pre-populate regions before they flip the flag.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.report import NearbyHotRegion
from app.services.nearby_aggregator import haversine_km

log = logging.getLogger(__name__)


def is_hot_regions_enabled() -> bool:
    """True iff the operator opted into the snapshot read path. The
    admin surface stays usable even when this is off - operators can
    seed regions before flipping the flag."""
    return os.environ.get("CRISP_NEARBY_HOT_REGIONS", "").strip() in ("1", "true", "yes")


def find_containing_region(
    lat: float, lng: float, db: Session,
) -> Optional[NearbyHotRegion]:
    """Return the SMALLEST enabled hot region whose circle contains
    (lat, lng), or None.

    "Smallest" so that nested regions resolve to the most-specific one
    (e.g. "delhi-central" inside a broader "delhi-ncr"). Ties are
    broken by name for determinism."""
    rows = (
        db.query(NearbyHotRegion)
          .filter(NearbyHotRegion.is_enabled == True)   # noqa: E712
          .all()
    )
    best: Optional[NearbyHotRegion] = None
    for r in rows:
        try:
            d = haversine_km(lat, lng, r.centre_lat, r.centre_lng)
        except Exception:
            continue
        if d > (r.radius_km or 0.0):
            continue
        if best is None or (r.radius_km, r.name) < (best.radius_km, best.name):
            best = r
    return best


def is_snapshot_fresh(region: NearbyHotRegion) -> bool:
    """True iff the region has a stored snapshot that's younger than
    its configured refresh_interval_min."""
    if region.refreshed_at is None or region.snapshot_json is None:
        return False
    # `refreshed_at` may be naive in some DB drivers depending on the
    # timezone handling - coerce to UTC so subtraction never raises.
    refreshed = region.refreshed_at
    if refreshed.tzinfo is None:
        refreshed = refreshed.replace(tzinfo=timezone.utc)
    age_min = (datetime.now(timezone.utc) - refreshed).total_seconds() / 60.0
    return age_min < float(region.refresh_interval_min or 15)


def lookup_fresh_snapshot(
    lat: float, lng: float, db: Session,
) -> Optional[dict]:
    """End-to-end helper for the /nearby endpoint. Returns the cached
    response dict when:
      - hot-regions feature is enabled
      - caller's coords fall inside a hot region
      - region's snapshot is fresh

    Returns None otherwise; caller proceeds with the live aggregator."""
    if not is_hot_regions_enabled():
        return None
    region = find_containing_region(lat, lng, db)
    if region is None:
        return None
    if not is_snapshot_fresh(region):
        return None
    return region.snapshot_json or None


def store_snapshot(
    region: NearbyHotRegion, payload: dict, db: Session,
) -> None:
    """Persist a freshly computed /nearby payload onto the region row.
    Stamps refreshed_at to now-UTC. Caller is responsible for the
    commit (or for using this inside a larger txn)."""
    region.snapshot_json = payload
    region.refreshed_at = datetime.now(timezone.utc)
