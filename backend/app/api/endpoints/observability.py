"""
Admin observability endpoints for the Nearby Reports pipeline.

Phase 2 (May 2026, docs §7 + §13) — exposes the operational view of
the nearby aggregation state for the dashboard's triage queue and
the "Cluster history" public timeline.

Current endpoints:

  GET /api/v1/admin/observability/nearby/acute
      Returns the list of currently-acute clusters (is_acute=true)
      observed across all cached nearby aggregations in the last
      cache-TTL window. HIGH-confidence acute events come first.
      Drives the dashboard's Phase 4 "Acute alerts" tray.

  GET /api/v1/admin/observability/nearby/events?group_id=...
      Returns the lifecycle event timeline for a given group_id —
      promote / downgrade / acute_on / fading / resolved / created /
      removed. Backs the dashboard's "Cluster history" view.

Both endpoints are ADMIN-gated (require_admin). The data they
expose is the SAME aggregator output citizens get — just without
the citizen-tier suppression + privacy projection. Privacy
invariants in docs §10 still hold (no PII / no per-report data).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.deps import require_admin
from app.db.session import get_db
from app.models.report import NearbyGroupEvent
from app.api.endpoints.reports import _NEARBY_CACHE  # in-process aggregator cache


router = APIRouter()


@router.get("/nearby/acute")
def get_acute_clusters(
    _user = Depends(require_admin),
):
    """Return currently-acute clusters across all cached aggregations.

    Sorted: HIGH-confidence acute first, then LOW. Each entry carries
    the group's centroid + count + label so the dashboard can plot
    the alert pin without a second query.

    Phase 2 reads from the in-process aggregator cache. Phase 4 will
    layer in a recent-events query (last 15 min) for the dashboard
    triage feed even when the cache is cold.
    """
    out_high = []
    out_low = []
    seen: set[str] = set()
    for entry in _NEARBY_CACHE.values():
        for g in entry.get("raw_groups", []):
            if not g.is_acute or g.id in seen:
                continue
            seen.add(g.id)
            row = {
                "id": g.id,
                "kind": g.kind,
                "label": g.label,
                "count": g.count,
                "tier": g.tier,
                "acute_grade": g.acute_grade,
                "centroid_lat": g.centroid_lat,
                "centroid_lng": g.centroid_lng,
                "latest_at": g.latest_at.isoformat(),
                "crisis_types": g.crisis_types,
                "severity_max": g.severity_max,
            }
            (out_high if g.acute_grade == "high" else out_low).append(row)
    return {
        "high_confidence": out_high,
        "low_confidence": out_low,
        "total": len(out_high) + len(out_low),
    }


@router.get("/nearby/events")
def get_group_events(
    group_id: str = Query(..., min_length=1, max_length=128),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    """Return the lifecycle event timeline for a given nearby group.

    Newest first. Used by the dashboard's "Cluster history" panel to
    show analysts how a cluster evolved (e.g. weak → emerging →
    verified → fading → resolved over a 3-day window)."""
    rows = (
        db.query(NearbyGroupEvent)
          .filter(NearbyGroupEvent.group_id == group_id)
          .order_by(NearbyGroupEvent.occurred_at.desc())
          .limit(limit)
          .all()
    )
    return {
        "group_id": group_id,
        "events": [
            {
                "id": r.id,
                "event_kind": r.event_kind,
                "from_tier": r.from_tier,
                "to_tier": r.to_tier,
                "from_count": r.from_count,
                "to_count": r.to_count,
                "payload": r.payload,
                "occurred_at": r.occurred_at.isoformat(),
            }
            for r in rows
        ],
    }
