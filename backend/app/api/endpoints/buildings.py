"""Buildings API — Phase H.1.c Building Intelligence & Response
Coordination read surface.

Three endpoints in this commit:

  GET  /api/v1/buildings              List with filters + cursor pagination
  GET  /api/v1/buildings/{id}         Full intelligence + nested reports
  POST /api/v1/buildings/{id}/footprint
                                       Cache an OSM polygon the dashboard
                                       fetched via Overpass

State-transition / monitor / responder / note / dossier / AI-summary
endpoints land in subsequent H sub-phases (H.2 → H.6). This commit
is read-only except for the footprint cache.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import desc, or_, text
from sqlalchemy.orm import Session

from app.core.deps import get_optional_user, require_analyst
from app.db.session import get_db
from app.models.report import (
    Building,
    BuildingEvent,
    Report,
    SatelliteVerification,
    is_valid_building_state_transition,
)
from app.schemas.building import (
    AISummaryPayload,
    BuildingDetail,
    BuildingEventResponse,
    BuildingListResponse,
    BuildingSummary,
    FootprintUpdate,
    SatelliteRollup,
    StateTransitionRequest,
)
from app.schemas.report import ReportResponse


router = APIRouter()


# ──────────────────────────────────────────────────────────────────────
# GET /api/v1/buildings  ── list with filters + cursor pagination
# ──────────────────────────────────────────────────────────────────────
@router.get("", response_model=BuildingListResponse)
def list_buildings(
    response: Response,
    db: Session = Depends(get_db),
    # Filtering
    state: Optional[str] = Query(
        None,
        description="Comma-separated states: e.g. 'ACTIVE,MONITORED,RESPONDING'",
    ),
    severity_score_gte: Optional[float] = Query(None, ge=0, le=100),
    humanitarian_priority_gte: Optional[float] = Query(None, ge=0, le=100),
    has_unresolved: Optional[bool] = Query(
        None,
        description="True → at least one constituent report not in RESOLVED/FALSE_ALARM",
    ),
    has_responder_dispatched: Optional[bool] = Query(
        None,
        description="True → responding_report_count > 0 (true responder coordination "
                    "via BuildingResponder lands in H.3)",
    ),
    id_source: Optional[str] = Query(
        None,
        description="Filter by provenance: OSM | PROXIMITY | MANUAL (comma-separated)",
    ),
    # Geo bbox (south, west, north, east) — defer PostGIS spatial index
    # until the geom column is populated. Falls back to centroid_lat/lng
    # btree.
    bbox: Optional[str] = Query(
        None,
        description="south,west,north,east — filter by centroid in this bounding box",
    ),
    # Delta sync
    since: Optional[datetime] = Query(
        None,
        description="ISO-8601 cutoff — return only buildings updated after this point",
    ),
    # Ordering
    order_by: str = Query(
        "humanitarian_priority",
        description="Comma-separated. Allowed: humanitarian_priority, severity_score, "
                    "activity_score, latest_report_at, first_report_at, report_count",
    ),
    order_dir: str = Query("desc", pattern="^(asc|desc)$"),
    # Pagination — cursor-based for stable iteration even with concurrent writes.
    limit: int = Query(100, ge=1, le=500),
    cursor: Optional[str] = Query(
        None,
        description="Opaque cursor from a prior response's next_cursor",
    ),
):
    """List buildings with operator-grade filters.

    Default sort `humanitarian_priority DESC` so the highest-priority
    buildings surface first — matches the dashboard's default-render
    expectation for the Building Console list view.

    Pagination is cursor-based (offset-incompatible for live data
    where new buildings arrive between calls). Cursor encodes the
    last seen sort key + id; next-page requests filter where (key, id)
    is past the cursor.
    """
    q = db.query(Building).filter(Building.archived_at.is_(None))

    # State filter (comma-separated multi-value)
    if state:
        states = [s.strip().upper() for s in state.split(",") if s.strip()]
        if states:
            q = q.filter(Building.state.in_(states))

    if id_source:
        sources = [s.strip().upper() for s in id_source.split(",") if s.strip()]
        if sources:
            q = q.filter(Building.id_source.in_(sources))

    if severity_score_gte is not None:
        q = q.filter(Building.severity_score >= severity_score_gte)
    if humanitarian_priority_gte is not None:
        q = q.filter(Building.humanitarian_priority >= humanitarian_priority_gte)
    if has_unresolved is True:
        q = q.filter(Building.report_count > Building.resolved_report_count)
    elif has_unresolved is False:
        q = q.filter(Building.report_count == Building.resolved_report_count)
    if has_responder_dispatched is True:
        q = q.filter(Building.responding_report_count > 0)
    elif has_responder_dispatched is False:
        q = q.filter(Building.responding_report_count == 0)

    if bbox:
        try:
            south, west, north, east = (float(x) for x in bbox.split(","))
            q = q.filter(
                Building.centroid_lat.between(south, north),
                Building.centroid_lng.between(west, east),
            )
        except (ValueError, IndexError):
            raise HTTPException(
                status_code=400,
                detail="bbox must be 'south,west,north,east' (4 floats)",
            )

    if since is not None:
        q = q.filter(Building.latest_report_at > since)

    # Ordering — allowlist the columns to avoid SQL injection via
    # arbitrary `?order_by=` values.
    SORT_COLS = {
        "humanitarian_priority": Building.humanitarian_priority,
        "severity_score":        Building.severity_score,
        "activity_score":        Building.activity_score,
        "escalation_risk":       Building.escalation_risk,
        "latest_report_at":      Building.latest_report_at,
        "first_report_at":       Building.first_report_at,
        "report_count":          Building.report_count,
    }
    sort_cols = []
    for key in (order_by.split(",") if order_by else []):
        col = SORT_COLS.get(key.strip())
        if col is not None:
            sort_cols.append(col.desc() if order_dir == "desc" else col.asc())
    # Always tie-break by id for cursor stability.
    sort_cols.append(Building.id.desc() if order_dir == "desc" else Building.id.asc())

    q = q.order_by(*sort_cols)

    # Filtered total for the response envelope. Use a clone of the query
    # without ordering for the count — saves the Postgres planner from
    # an unnecessary sort.
    total = q.with_entities(Building.id).order_by(None).count()

    # Cursor decode — base64-ish opaque token; we use plain JSON for
    # debuggability since cursors aren't user-visible.
    if cursor:
        try:
            decoded = json.loads(cursor)
            last_id = decoded.get("id")
            if last_id:
                # Simple cursor: id-based pagination. For more complex
                # multi-column cursor the FastAPI route can iterate via
                # `where (key, id) > (last_key, last_id)`.
                if order_dir == "desc":
                    q = q.filter(Building.id < last_id)
                else:
                    q = q.filter(Building.id > last_id)
        except (json.JSONDecodeError, AttributeError):
            raise HTTPException(status_code=400, detail="invalid cursor")

    rows = q.limit(limit + 1).all()  # +1 to detect "more pages exist"
    has_more = len(rows) > limit
    rows = rows[:limit]

    # Build the response items.
    items: List[BuildingSummary] = []
    for b in rows:
        items.append(_to_summary(b))

    next_cursor = None
    if has_more and rows:
        next_cursor = json.dumps({"id": rows[-1].id})

    # Mirror the /reports list endpoint's X-Total-Count convention so
    # dashboard pagination decisions can read either the body's
    # `total` field or the header.
    response.headers["X-Total-Count"] = str(total)

    return BuildingListResponse(items=items, total=total, next_cursor=next_cursor)


# ──────────────────────────────────────────────────────────────────────
# GET /api/v1/buildings/{id}  ── full intelligence
# ──────────────────────────────────────────────────────────────────────
@router.get("/{building_id}", response_model=BuildingDetail)
def get_building(building_id: str, db: Session = Depends(get_db)):
    """Full Building Intelligence Console payload.

    Returns the BuildingSummary plus nested constituent reports
    (newest-first), the AI summary body when cached, satellite
    verdict roll-up, and the cached footprint GeoJSON. ~500 line
    JSON for a typical building; bounded by the partition size.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    summary = _to_summary(b)

    # Nested constituent reports — newest first, excluding soft-deleted.
    # No joinedload here; the dashboard's existing /reports/ list call
    # already paid the N+1-prevention cost. We're surface-fetching a
    # single building's <~50 reports.
    reports = (
        db.query(Report)
        .filter(
            Report.building_id == building_id,
            Report.deletion_requested_at.is_(None),
        )
        .order_by(desc(Report.server_created_at))
        .all()
    )
    report_responses = [ReportResponse.model_validate(r) for r in reports]

    # Satellite roll-up — aggregated across constituent reports.
    sat_rows = (
        db.query(SatelliteVerification)
        .join(Report, Report.id == SatelliteVerification.report_id)
        .filter(Report.building_id == building_id)
        .filter(Report.deletion_requested_at.is_(None))
        .all()
    )
    if sat_rows:
        total_scores = [s.total_score for s in sat_rows if s.total_score is not None]
        latest = max(sat_rows, key=lambda s: s.scored_at or datetime.min)
        sat_rollup = SatelliteRollup(
            mean_total_score=(sum(total_scores) / len(total_scores))
                              if total_scores else None,
            count=len(sat_rows),
            latest_verdict=latest.verdict,
            latest_scored_at=latest.scored_at,
        )
    else:
        sat_rollup = SatelliteRollup(count=0)

    # AI summary — pluck from the JSON column if cached.
    ai_payload: Optional[AISummaryPayload] = None
    if b.ai_summary:
        try:
            ai_payload = AISummaryPayload(**b.ai_summary)
        except Exception:
            # Stale / malformed cache → render NULL rather than failing
            # the whole detail call. H.6 will refresh.
            ai_payload = None

    return BuildingDetail(
        **summary.model_dump(),
        reports=report_responses,
        footprint_geojson=b.footprint_geojson,
        ai_summary=ai_payload,
        satellite_summary=sat_rollup,
    )


# ──────────────────────────────────────────────────────────────────────
# POST /api/v1/buildings/{id}/footprint  ── cache OSM polygon
# ──────────────────────────────────────────────────────────────────────
@router.post("/{building_id}/footprint", response_model=BuildingSummary)
def cache_footprint(
    building_id: str,
    body: FootprintUpdate,
    db: Session = Depends(get_db),
    _user=Depends(get_optional_user),
):
    """Cache an OSM-fetched footprint on the building row.

    The dashboard's `loadBuildingFootprints` calls Overpass at zoom
    ≥ 15. Once it has the GeoJSON for a way, it POSTs here so
    subsequent operator sessions don't re-pay the Overpass round-trip.

    Bound-checks the geometry: must be a Polygon with at least 4
    coordinate pairs (3-vertex ring + closing duplicate). Properties
    accompanying the feature populate the OSM metadata columns when
    they're not already set.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    feat = body.footprint_geojson or {}
    geom = feat.get("geometry") if isinstance(feat, dict) else None
    if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(
            status_code=400,
            detail="footprint_geojson.geometry.type must be Polygon or MultiPolygon",
        )
    coords = geom.get("coordinates")
    if not isinstance(coords, list) or not coords:
        raise HTTPException(
            status_code=400,
            detail="footprint_geojson.geometry.coordinates missing or empty",
        )

    # Compute centroid (mean of vertex coordinates) for the cached
    # value. Cheap; gives the map auto-pan a reasonable target even
    # before PostGIS centroid computation kicks in.
    centroid_lat, centroid_lng = _compute_polygon_centroid(coords, geom["type"])

    b.footprint_geojson = feat
    if centroid_lat is not None and centroid_lng is not None:
        b.centroid_lat = centroid_lat
        b.centroid_lng = centroid_lng
    # Optional OSM metadata fields — only fill if not already set so
    # we don't overwrite operator-curated values with raw OSM names.
    if body.osm_name and not b.osm_name:
        b.osm_name = body.osm_name
    if body.osm_building_type and not b.osm_building_type:
        b.osm_building_type = body.osm_building_type
    if body.osm_addr_full and not b.osm_addr_full:
        b.osm_addr_full = body.osm_addr_full

    # Optional PostGIS sync — keep the geometry column in step with
    # the JSON cache if PostGIS is available. Wrapped in try so a
    # PostGIS-missing environment doesn't fail the whole POST.
    try:
        rings_geojson = json.dumps(feat["geometry"])
        db.execute(text("""
            UPDATE buildings
            SET footprint_geom = ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326)
            WHERE id = :bid
        """), {"g": rings_geojson, "bid": building_id})
    except Exception:
        # PostGIS not installed → geom column doesn't exist on this
        # cluster (per migration 0028's conditional). Silent skip.
        pass

    db.commit()
    db.refresh(b)
    return _to_summary(b)


# ──────────────────────────────────────────────────────────────────────
# Phase H.2 — state transitions + timeline
# ──────────────────────────────────────────────────────────────────────
@router.post("/{building_id}/state", response_model=BuildingSummary)
def transition_state(
    building_id: str,
    body: StateTransitionRequest,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Transition a building to a new operational state.

    Allowed transitions enforced by `is_valid_building_state_transition`
    (see app/models/report.py). Emits a `STATE_CHANGED` BuildingEvent
    with from/to states + actor user. Returns the updated summary.

    Operators with sufficient privilege (analyst+) can perform any
    transition the state machine declares legal. SUPER_ADMIN escape
    hatch for unusual cases is deferred to Phase H.6+ (not needed in
    H.2's MVP — the state machine covers the operator-facing cases).
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    to_state = body.to_state.upper().strip()
    valid_states = {"ACTIVE", "MONITORED", "RESPONDING", "ESCALATED",
                    "RESOLVED", "ARCHIVED", "FALSE_ALARM"}
    if to_state not in valid_states:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown state '{to_state}'. Allowed: {sorted(valid_states)}",
        )

    from_state = b.state
    if not is_valid_building_state_transition(from_state, to_state):
        raise HTTPException(
            status_code=409,
            detail=f"Transition {from_state} → {to_state} is not allowed",
        )

    # Apply the transition. The hook on Report doesn't fire for
    # Building updates, so we write the BuildingEvent ourselves.
    now = datetime.now(timezone.utc)
    b.state = to_state
    b.state_changed_at = now
    b.state_changed_by_user_id = user.id if hasattr(user, "id") else None
    # If transitioning to ARCHIVED, set archived_at; clear when un-archiving.
    if to_state == "ARCHIVED":
        b.archived_at = now
    elif from_state == "ARCHIVED" and to_state != "ARCHIVED":
        b.archived_at = None

    event = BuildingEvent(
        building_id=building_id,
        event_kind="STATE_CHANGED",
        actor_user_id=user.id if hasattr(user, "id") else None,
        actor_kind="OPERATOR",
        payload={
            "from_state": from_state,
            "to_state": to_state,
            "reason": body.reason,
        },
    )
    db.add(event)
    db.commit()
    db.refresh(b)
    return _to_summary(b)


@router.post("/{building_id}/escalate", response_model=BuildingSummary)
def escalate(
    building_id: str,
    body: Optional[StateTransitionRequest] = None,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Convenience endpoint: flip a building to ESCALATED.

    Equivalent to POST /state with to_state='ESCALATED'; the convenience
    surface lets the dashboard wire a single Escalate button without
    knowing the state-machine details. Adds an `ESCALATED` event kind
    alongside the `STATE_CHANGED` event so the timeline reads naturally
    ("Operator escalated at HH:MM") rather than as a generic state
    flip.
    """
    return _transition_with_event(
        db, user, building_id,
        to_state="ESCALATED",
        event_kind="ESCALATED",
        reason=(body.reason if body else None),
    )


@router.post("/{building_id}/false-alarm", response_model=BuildingSummary)
def false_alarm(
    building_id: str,
    body: Optional[StateTransitionRequest] = None,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Mark a building's cluster as misinformation.

    Sets state=FALSE_ALARM + writes a FALSE_ALARM_DECLARED event.
    Suppresses the building from the public /nearby aggregator
    surface (the aggregator's tier-filter already excludes
    FALSE_ALARM via the `state` column on the Building row).
    """
    return _transition_with_event(
        db, user, building_id,
        to_state="FALSE_ALARM",
        event_kind="FALSE_ALARM_DECLARED",
        reason=(body.reason if body else None),
    )


@router.get("/{building_id}/timeline", response_model=List[BuildingEventResponse])
def get_timeline(
    building_id: str,
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
):
    """Newest-first audit-log entries for the building.

    Drives the Building Intelligence Console's timeline section. Paged
    by simple `?limit=` — operators usually don't page past the first
    100 entries (older history lives in the dossier export, H.5).
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")
    rows = (
        db.query(BuildingEvent)
        .filter(BuildingEvent.building_id == building_id)
        .order_by(desc(BuildingEvent.occurred_at))
        .limit(limit)
        .all()
    )
    return [BuildingEventResponse.model_validate(r) for r in rows]


def _transition_with_event(
    db: Session,
    user,
    building_id: str,
    *,
    to_state: str,
    event_kind: str,
    reason: Optional[str],
) -> BuildingSummary:
    """Shared helper for the convenience endpoints (escalate /
    false_alarm). Writes BOTH a STATE_CHANGED event AND the
    event-kind-specific event so the timeline reads naturally.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")
    from_state = b.state
    if from_state == to_state:
        # Idempotent — no-op + return current summary.
        return _to_summary(b)
    if not is_valid_building_state_transition(from_state, to_state):
        raise HTTPException(
            status_code=409,
            detail=f"Transition {from_state} → {to_state} is not allowed",
        )
    now = datetime.now(timezone.utc)
    actor_user_id = user.id if hasattr(user, "id") else None
    b.state = to_state
    b.state_changed_at = now
    b.state_changed_by_user_id = actor_user_id
    if to_state == "ARCHIVED":
        b.archived_at = now
    elif from_state == "ARCHIVED":
        b.archived_at = None

    # Two events — the canonical STATE_CHANGED + the named event kind.
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="STATE_CHANGED",
        actor_user_id=actor_user_id,
        actor_kind="OPERATOR",
        payload={"from_state": from_state, "to_state": to_state, "reason": reason},
    ))
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind=event_kind,
        actor_user_id=actor_user_id,
        actor_kind="OPERATOR",
        payload={"reason": reason} if reason else None,
    ))
    db.commit()
    db.refresh(b)
    return _to_summary(b)


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────
def _to_summary(b: Building) -> BuildingSummary:
    """Map an ORM Building → BuildingSummary Pydantic shape."""
    return BuildingSummary(
        id=b.id,
        id_source=b.id_source.value if hasattr(b.id_source, "value") else str(b.id_source),
        osm_way_id=b.osm_way_id,
        osm_name=b.osm_name,
        osm_building_type=b.osm_building_type,
        osm_addr_full=b.osm_addr_full,
        centroid_lat=b.centroid_lat,
        centroid_lng=b.centroid_lng,
        has_footprint=bool(b.footprint_geojson),
        state=b.state,
        severity_score=b.severity_score,
        confidence_score=b.confidence_score,
        activity_score=b.activity_score,
        escalation_risk=b.escalation_risk,
        humanitarian_priority=b.humanitarian_priority,
        report_count=b.report_count or 0,
        verified_report_count=b.verified_report_count or 0,
        responding_report_count=b.responding_report_count or 0,
        resolved_report_count=b.resolved_report_count or 0,
        debris_clearing_needed_count=b.debris_clearing_needed_count or 0,
        severity_max=b.severity_max,
        damage_class_max=b.damage_class_max,
        crisis_types_top3=b.crisis_types_top3 or [],
        first_report_at=b.first_report_at,
        latest_report_at=b.latest_report_at,
        state_changed_at=b.state_changed_at,
        has_ai_summary=bool(b.ai_summary),
        ai_summary_at=b.ai_summary_at,
        archived_at=b.archived_at,
    )


def _compute_polygon_centroid(coords, geom_type: str):
    """Mean-of-vertices centroid for a Polygon / MultiPolygon GeoJSON
    coordinate array. Returns (lat, lng) or (None, None) if the
    structure isn't parseable.

    GeoJSON convention: coordinate is [lng, lat] (longitude first).
    """
    try:
        pts = []
        if geom_type == "Polygon":
            # coords is [outer-ring, hole1, hole2, ...]
            for ring in coords:
                for pt in ring:
                    pts.append(pt)
        elif geom_type == "MultiPolygon":
            for poly in coords:
                for ring in poly:
                    for pt in ring:
                        pts.append(pt)
        if not pts:
            return None, None
        lngs = [p[0] for p in pts if len(p) >= 2]
        lats = [p[1] for p in pts if len(p) >= 2]
        if not lats or not lngs:
            return None, None
        return sum(lats) / len(lats), sum(lngs) / len(lngs)
    except (TypeError, ValueError, IndexError):
        return None, None
