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
from fastapi.responses import JSONResponse
from sqlalchemy import desc, or_, text
from sqlalchemy.orm import Session

from app.core.deps import get_optional_user, require_admin, require_analyst
from app.db.session import get_db
from app.models.auth import User
from app.models.report import (
    Building,
    BuildingEvent,
    BuildingMonitor,
    BuildingNote,
    BuildingResponder,
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
    MonitorResponse,
    NoteCreate,
    NoteResponse,
    NoteUpdate,
    ResponderCreate,
    ResponderResponse,
    ResponderUpdate,
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
def get_building(
    building_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_optional_user),
):
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

    # Phase H.3 — active responders + monitors (cleared_at IS NULL).
    responders = (
        db.query(BuildingResponder)
        .filter(
            BuildingResponder.building_id == building_id,
            BuildingResponder.cleared_at.is_(None),
        )
        .order_by(desc(BuildingResponder.assigned_at))
        .all()
    )
    monitors = (
        db.query(BuildingMonitor)
        .filter(
            BuildingMonitor.building_id == building_id,
            BuildingMonitor.cleared_at.is_(None),
        )
        .order_by(desc(BuildingMonitor.started_at))
        .all()
    )

    # Phase H.4 — notes (newest-first, pinned first, capped at 50).
    note_payloads = _load_notes_for_building(db, building_id, viewer=_user, limit=50)

    return BuildingDetail(
        **summary.model_dump(),
        reports=report_responses,
        footprint_geojson=b.footprint_geojson,
        ai_summary=ai_payload,
        satellite_summary=sat_rollup,
        responders=[ResponderResponse.model_validate(r) for r in responders],
        monitors=[MonitorResponse.model_validate(m) for m in monitors],
        notes=note_payloads,
    )


def _load_notes_for_building(
    db: Session,
    building_id: str,
    viewer: Optional[User],
    limit: int = 50,
) -> List[NoteResponse]:
    """Project notes for a building into NoteResponse rows.

    - Pinned first, then newest-first within each group
    - Soft-deleted notes appear as tombstones (body blanked, deleted_at set)
    - ADMIN_ONLY notes are filtered out for non-admin viewers
    - author_email / author_name denormalised at read time so the
      dashboard can render attribution without a follow-up lookup
    """
    is_admin = bool(
        viewer
        and getattr(viewer, "role", "")
        in ("ADMIN", "SUPER_ADMIN", "admin", "super_admin")
    )
    q = (
        db.query(BuildingNote, User.email, User.full_name)
        .outerjoin(User, User.id == BuildingNote.author_user_id)
        .filter(BuildingNote.building_id == building_id)
    )
    if not is_admin:
        q = q.filter(BuildingNote.visibility != "ADMIN_ONLY")
    rows = (
        q.order_by(desc(BuildingNote.pinned), desc(BuildingNote.created_at))
        .limit(limit)
        .all()
    )
    out: List[NoteResponse] = []
    for note, email, full_name in rows:
        out.append(NoteResponse(
            id=note.id,
            building_id=note.building_id,
            author_user_id=note.author_user_id,
            author_email=email,
            author_name=full_name,
            # Tombstone: don't surface the body for soft-deleted notes.
            body="" if note.deleted_at else note.body,
            visibility=str(note.visibility),
            pinned=bool(note.pinned),
            created_at=note.created_at,
            edited_at=note.edited_at,
            deleted_at=note.deleted_at,
        ))
    return out


# ──────────────────────────────────────────────────────────────────────
# Phase H.3 — Responder coordination + watch list endpoints
# ──────────────────────────────────────────────────────────────────────
@router.post("/{building_id}/responders", response_model=ResponderResponse)
def assign_responder(
    building_id: str,
    body: ResponderCreate,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Assign a new responder to a building.

    Creates a BuildingResponder row + emits a RESPONDER_ASSIGNED
    BuildingEvent so the timeline reflects the action. If the building
    is in ACTIVE state it transitions to RESPONDING automatically.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    r = BuildingResponder(
        building_id=building_id,
        assigned_by_user_id=user.id if hasattr(user, "id") else None,
        responder_name=body.responder_name,
        responder_org=body.responder_org,
        responder_contact=body.responder_contact,
        eta_minutes=body.eta_minutes,
        notes=body.notes,
    )
    db.add(r)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="RESPONDER_ASSIGNED",
        actor_user_id=user.id if hasattr(user, "id") else None,
        actor_kind="OPERATOR",
        payload={
            "responder_name": body.responder_name,
            "responder_org": body.responder_org,
            "eta_minutes": body.eta_minutes,
        },
    ))
    # If the building was ACTIVE / MONITORED, escalate to RESPONDING
    # since at least one responder is now assigned.
    if b.state in ("ACTIVE", "MONITORED"):
        b.state = "RESPONDING"
        b.state_changed_at = datetime.now(timezone.utc)
        b.state_changed_by_user_id = user.id if hasattr(user, "id") else None
        db.add(BuildingEvent(
            building_id=building_id,
            event_kind="STATE_CHANGED",
            actor_user_id=user.id if hasattr(user, "id") else None,
            actor_kind="SYSTEM",
            payload={
                "from_state": "ACTIVE" if b.state == "RESPONDING" else b.state,
                "to_state": "RESPONDING",
                "reason": "auto-transition on responder assignment",
            },
        ))
    db.commit()
    db.refresh(r)
    return ResponderResponse.model_validate(r)


@router.patch("/{building_id}/responders/{responder_id}", response_model=ResponderResponse)
def update_responder(
    building_id: str,
    responder_id: str,
    body: ResponderUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Advance a responder's lifecycle.

    `action=dispatched` → set dispatched_at + emit RESPONDER_DISPATCHED.
    `action=arrived`    → set arrived_at + emit RESPONDER_ARRIVED.
    `action=cleared`    → set cleared_at + emit RESPONDER_CLEARED.
    eta_minutes and notes are free-text patches (no event emitted).
    """
    r = (
        db.query(BuildingResponder)
        .filter(
            BuildingResponder.id == responder_id,
            BuildingResponder.building_id == building_id,
        )
        .first()
    )
    if not r:
        raise HTTPException(status_code=404, detail="Responder not found")

    now = datetime.now(timezone.utc)
    if body.action == "dispatched":
        if r.dispatched_at:
            raise HTTPException(status_code=409,
                                detail="Responder already marked dispatched")
        r.dispatched_at = now
        db.add(BuildingEvent(
            building_id=building_id,
            event_kind="RESPONDER_DISPATCHED",
            actor_user_id=user.id if hasattr(user, "id") else None,
            actor_kind="OPERATOR",
            payload={"responder_id": responder_id, "responder_name": r.responder_name},
        ))
    elif body.action == "arrived":
        if r.arrived_at:
            raise HTTPException(status_code=409,
                                detail="Responder already marked arrived")
        r.arrived_at = now
        db.add(BuildingEvent(
            building_id=building_id,
            event_kind="RESPONDER_ARRIVED",
            actor_user_id=user.id if hasattr(user, "id") else None,
            actor_kind="OPERATOR",
            payload={"responder_id": responder_id, "responder_name": r.responder_name},
        ))
    elif body.action == "cleared":
        if r.cleared_at:
            raise HTTPException(status_code=409,
                                detail="Responder already cleared")
        r.cleared_at = now
        db.add(BuildingEvent(
            building_id=building_id,
            event_kind="RESPONDER_CLEARED",
            actor_user_id=user.id if hasattr(user, "id") else None,
            actor_kind="OPERATOR",
            payload={"responder_id": responder_id, "responder_name": r.responder_name},
        ))
    # Free-text patches.
    if body.eta_minutes is not None:
        r.eta_minutes = body.eta_minutes
    if body.notes is not None:
        r.notes = body.notes

    db.commit()
    db.refresh(r)
    return ResponderResponse.model_validate(r)


@router.post("/{building_id}/monitor", response_model=MonitorResponse)
def start_monitor(
    building_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Add the current user to the building's watch list.

    Idempotent — returns the existing active watch if one exists.
    Emits a MONITOR_STARTED BuildingEvent on first watch.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    # Check for existing active watch (partial unique index prevents
    # duplicates, but we want a friendly idempotent response).
    existing = (
        db.query(BuildingMonitor)
        .filter(
            BuildingMonitor.building_id == building_id,
            BuildingMonitor.user_id == user.id,
            BuildingMonitor.cleared_at.is_(None),
        )
        .first()
    )
    if existing:
        return MonitorResponse.model_validate(existing)

    m = BuildingMonitor(building_id=building_id, user_id=user.id)
    db.add(m)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="MONITOR_STARTED",
        actor_user_id=user.id,
        actor_kind="OPERATOR",
        payload={"user_id": user.id},
    ))
    db.commit()
    db.refresh(m)
    return MonitorResponse.model_validate(m)


@router.delete("/{building_id}/monitor", status_code=204)
def clear_monitor(
    building_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Stop watching the building (clears the current user's active watch)."""
    m = (
        db.query(BuildingMonitor)
        .filter(
            BuildingMonitor.building_id == building_id,
            BuildingMonitor.user_id == user.id,
            BuildingMonitor.cleared_at.is_(None),
        )
        .first()
    )
    if not m:
        return Response(status_code=204)
    m.cleared_at = datetime.now(timezone.utc)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="MONITOR_CLEARED",
        actor_user_id=user.id,
        actor_kind="OPERATOR",
        payload={"user_id": user.id},
    ))
    db.commit()
    return Response(status_code=204)


# ──────────────────────────────────────────────────────────────────────
# Phase H.4 — Operator notes thread
# ──────────────────────────────────────────────────────────────────────
@router.post("/{building_id}/notes", response_model=NoteResponse)
def add_note(
    building_id: str,
    body: NoteCreate,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Add a new operator note to a building.

    Notes are the long-form context channel that BuildingEvent (audit
    log) + Building.ai_summary (machine brief) deliberately don't try
    to be — free text, pinnable, edit + soft-delete.

    Emits a NOTE_ADDED BuildingEvent for the timeline. ADMIN_ONLY
    visibility requires the caller to be an admin (gate enforced
    here rather than client-side).
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    # ADMIN_ONLY visibility is admin-gated.
    is_admin = getattr(user, "role", "") in (
        "ADMIN", "SUPER_ADMIN", "admin", "super_admin"
    )
    if body.visibility == "ADMIN_ONLY" and not is_admin:
        raise HTTPException(
            status_code=403,
            detail="ADMIN_ONLY notes require admin role",
        )

    note = BuildingNote(
        building_id=building_id,
        author_user_id=user.id if hasattr(user, "id") else None,
        body=body.body.strip(),
        visibility=body.visibility or "ALL_OPERATORS",
        pinned=bool(body.pinned),
    )
    db.add(note)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="NOTE_ADDED",
        actor_user_id=user.id if hasattr(user, "id") else None,
        actor_kind="OPERATOR",
        # Don't ship the full body to the timeline — it can be 4 KB.
        # A 80-char snippet + the note id is enough context for the
        # timeline reader to click through if they want the full text.
        payload={
            "note_id": note.id,
            "preview": body.body.strip()[:80],
            "pinned": bool(body.pinned),
            "visibility": body.visibility or "ALL_OPERATORS",
        },
    ))
    db.commit()
    db.refresh(note)
    # Project through the same helper to include author email/name.
    rows = _load_notes_for_building(db, building_id, viewer=user, limit=1)
    return rows[0] if rows else NoteResponse.model_validate(note)


@router.patch("/{building_id}/notes/{note_id}", response_model=NoteResponse)
def edit_note(
    building_id: str,
    note_id: str,
    body: NoteUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Edit an existing note.

    Editing rules:
      - The author can edit body / visibility / pinned.
      - Admins can edit any note (incl. pin / unpin / change visibility).
      - Other analysts can pin / unpin but not edit body or visibility.
    """
    note = (
        db.query(BuildingNote)
        .filter(
            BuildingNote.id == note_id,
            BuildingNote.building_id == building_id,
        )
        .first()
    )
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if note.deleted_at:
        raise HTTPException(status_code=409, detail="Note is deleted")

    is_admin = getattr(user, "role", "") in (
        "ADMIN", "SUPER_ADMIN", "admin", "super_admin"
    )
    is_author = note.author_user_id == getattr(user, "id", None)
    body_or_vis_change = (body.body is not None) or (body.visibility is not None)
    if body_or_vis_change and not (is_admin or is_author):
        raise HTTPException(
            status_code=403,
            detail="Only the author or an admin can edit a note's content",
        )

    edited = False
    if body.body is not None and body.body.strip() != note.body:
        note.body = body.body.strip()
        edited = True
    if body.visibility is not None and body.visibility != note.visibility:
        # ADMIN_ONLY visibility is admin-gated even on edit.
        if body.visibility == "ADMIN_ONLY" and not is_admin:
            raise HTTPException(
                status_code=403,
                detail="ADMIN_ONLY visibility requires admin role",
            )
        note.visibility = body.visibility
        edited = True
    if body.pinned is not None and bool(body.pinned) != bool(note.pinned):
        note.pinned = bool(body.pinned)
        edited = True

    if edited:
        note.edited_at = datetime.now(timezone.utc)
        db.add(BuildingEvent(
            building_id=building_id,
            event_kind="NOTE_EDITED",
            actor_user_id=user.id if hasattr(user, "id") else None,
            actor_kind="OPERATOR",
            payload={"note_id": note_id},
        ))
        db.commit()
        db.refresh(note)

    rows = _load_notes_for_building(db, building_id, viewer=user, limit=50)
    found = next((r for r in rows if r.id == note_id), None)
    return found or NoteResponse.model_validate(note)


@router.delete("/{building_id}/notes/{note_id}", response_model=NoteResponse)
def delete_note(
    building_id: str,
    note_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Soft-delete a note.

    Sets deleted_at + emits a NOTE_DELETED BuildingEvent. The row stays
    in the DB (tombstone) so the timeline retains the audit reference.
    Returns the tombstone NoteResponse (body blanked).

    Author OR admin only.
    """
    note = (
        db.query(BuildingNote)
        .filter(
            BuildingNote.id == note_id,
            BuildingNote.building_id == building_id,
        )
        .first()
    )
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if note.deleted_at:
        # Idempotent — already deleted; project the existing tombstone.
        rows = _load_notes_for_building(db, building_id, viewer=user, limit=50)
        found = next((r for r in rows if r.id == note_id), None)
        return found or NoteResponse.model_validate(note)

    is_admin = getattr(user, "role", "") in (
        "ADMIN", "SUPER_ADMIN", "admin", "super_admin"
    )
    is_author = note.author_user_id == getattr(user, "id", None)
    if not (is_admin or is_author):
        raise HTTPException(
            status_code=403,
            detail="Only the author or an admin can delete a note",
        )

    note.deleted_at = datetime.now(timezone.utc)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="NOTE_DELETED",
        actor_user_id=user.id if hasattr(user, "id") else None,
        actor_kind="OPERATOR",
        payload={"note_id": note_id},
    ))
    db.commit()
    db.refresh(note)
    rows = _load_notes_for_building(db, building_id, viewer=user, limit=50)
    found = next((r for r in rows if r.id == note_id), None)
    return found or NoteResponse.model_validate(note)


# ──────────────────────────────────────────────────────────────────────
# Phase H.6 — AI building summary (Claude-Haiku)
# ──────────────────────────────────────────────────────────────────────
# Rate-limit: a building can refresh its AI summary at most once every
# 5 minutes. Earlier calls return 429 with retry-after telling the
# dashboard when the cooldown ends. Background-fresh calls bypass the
# cooldown by passing ?force=true (admin-only).
_AI_SUMMARY_COOLDOWN_SECONDS = 5 * 60


@router.post("/{building_id}/ai-summary", response_model=AISummaryPayload)
async def refresh_ai_summary(
    building_id: str,
    force: bool = Query(False, description="Bypass cooldown (admin-only)"),
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Generate (or refresh) the building's AI summary.

    Lazy: only fires when an operator clicks "Refresh AI" in the
    console, or when something material has changed (the endpoint can
    be wired into the scoring hook later). Result lands on
    `Building.ai_summary` so the next detail GET returns it without a
    fresh Claude round-trip.

    Rate-limited per building (5-min cooldown). Admins can bypass via
    `?force=true`. Emits AI_SUMMARY_GENERATED on success.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    is_admin = getattr(user, "role", "") in (
        "ADMIN", "SUPER_ADMIN", "admin", "super_admin"
    )
    if force and not is_admin:
        raise HTTPException(
            status_code=403,
            detail="Only admins can bypass the AI summary cooldown",
        )

    # Cooldown check (skipped on force).
    if not force and b.ai_summary_at is not None:
        elapsed = (datetime.now(timezone.utc) - b.ai_summary_at).total_seconds()
        remaining = _AI_SUMMARY_COOLDOWN_SECONDS - elapsed
        if remaining > 0:
            raise HTTPException(
                status_code=429,
                detail=f"AI summary cooled down; retry in {int(remaining)}s",
                headers={"Retry-After": str(int(remaining))},
            )

    # Defer the import so the buildings module loads even when the
    # anthropic SDK isn't installed in a slimmer test environment.
    from app.services.building_ai_summary import (
        SummaryUnavailable,
        generate_building_summary,
        is_configured as ai_is_configured,
    )

    if not ai_is_configured():
        raise HTTPException(
            status_code=503,
            detail="AI summary unavailable: ANTHROPIC_API_KEY not configured",
        )

    try:
        payload = await generate_building_summary(db, b)
    except SummaryUnavailable as e:
        raise HTTPException(status_code=503, detail=f"AI summary unavailable: {e}")

    # Persist + emit event.
    b.ai_summary = payload
    b.ai_summary_at = datetime.now(timezone.utc)
    db.add(BuildingEvent(
        building_id=building_id,
        event_kind="AI_SUMMARY_GENERATED",
        actor_user_id=user.id if hasattr(user, "id") else None,
        actor_kind="AI",
        payload={"model": payload.get("model"), "forced": bool(force)},
    ))
    db.commit()

    return AISummaryPayload(**payload)


# ──────────────────────────────────────────────────────────────────────
# Phase H.5 — Consolidated dossier export (PDF + GeoJSON)
# ──────────────────────────────────────────────────────────────────────
@router.get("/{building_id}/dossier.pdf")
def export_dossier_pdf(
    building_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Generate + stream a single-building PDF dossier.

    Combines intelligence scores + responder roster + operator notes +
    constituent reports + event timeline into one print-friendly
    artefact. Heavy-but-bounded — typical building (≤50 reports) is
    ~30 KB; a hot building (200+ reports) caps at ~250 KB.

    Analyst-gated. PDF generation runs synchronously (reportlab is
    in-process, no worker pool needed).
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    # Lazy-import so a missing reportlab wheel doesn't crash boot
    # (the dossier service handles its own lazy imports inside).
    from app.services.building_dossier import build_dossier_pdf
    pdf_bytes = build_dossier_pdf(db, b)

    # Filename: building-{short-id}-dossier-{date}.pdf — short-id
    # keeps URLs readable for OSM-typed ids; for UUID-typed ids we use
    # the first 8 chars.
    short = b.id.replace("osm:way:", "osm").replace(":", "_")
    if len(short) > 24:
        short = short[:24]
    fname = f"building-{short}-dossier-{datetime.now(timezone.utc).date()}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            # Allow the dashboard to fetch + offer-as-download without
            # the browser preview pane intercepting the click.
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{building_id}/dossier.geojson")
def export_dossier_geojson(
    building_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Generate + stream a single-building GeoJSON FeatureCollection.

    Each constituent report becomes a Feature with the building's
    intelligence scores + lifecycle baked into properties so the
    document round-trips into QGIS / ArcGIS without information
    loss for downstream humanitarian-ops reporting.
    """
    b = db.query(Building).filter(Building.id == building_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Building not found")

    from app.services.building_dossier import build_dossier_geojson
    fc = build_dossier_geojson(db, b)

    short = b.id.replace("osm:way:", "osm").replace(":", "_")
    if len(short) > 24:
        short = short[:24]
    fname = f"building-{short}-{datetime.now(timezone.utc).date()}.geojson"
    # JSONResponse's class-level media_type = application/json wins over
    # constructor arg; use a bare Response so application/geo+json
    # actually lands on the wire (matches the .geojson file extension +
    # behaves correctly in GIS tooling sniffing for the MIME type).
    return Response(
        content=json.dumps(fc),
        media_type="application/geo+json",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Content-Type-Options": "nosniff",
        },
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
