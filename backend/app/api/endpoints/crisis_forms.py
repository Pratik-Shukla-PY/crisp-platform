"""Dynamic Crisis Forms — geo-scoped Stage 2/3 question packs.

Public:
  GET  /api/v1/crisis-forms/active?lat=&lng=        cacheable — which pack (if any)
                                                    applies at this point right now
Admin (require_admin):
  GET/POST/PATCH/DELETE  /api/v1/admin/crisis-forms/events[/{id}]
  GET/POST/PATCH         /api/v1/admin/crisis-forms/packs[/{id}]
  GET/POST               /api/v1/admin/crisis-forms/packs/{id}/versions
  POST                   /api/v1/admin/crisis-forms/packs/{id}/publish
  POST                   /api/v1/admin/crisis-forms/packs/{id}/rollback
  POST                   /api/v1/admin/crisis-forms/packs/validate   (lint, no save)

Asymmetric auth mirrors admin.py: clients hit /active without a JWT (cheap,
cacheable, leaks nothing personal); operators mutate behind require_admin.
The default report flow is untouched — /active simply returns {active:false}
for any point outside an active, in-window zone, and clients fall back to the
hardcoded Stage 2/3.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import and_, case, or_, nullslast, func as sa_func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.core.deps import require_admin, require_analyst, require_viewer
from app.models.report import (
    CrisisEvent, CrisisFormPack, CrisisFormPackVersion,
    Report, ReportStatusEnum, SeverityEnum, ReviewerVerdictEnum,
    BuildingResponder, Building, OperationClaimLog,
)
from app.api.endpoints.analytics import (
    _SLA_THRESHOLD_HOURS, _ESCALATING_RISK_THRESHOLD, _CLOSED_BUILDING_STATES,
    _compute_operation_health,
)
from app.services.crisis_form_schema import validate_pack_schema
from app.services.nearby_aggregator import haversine_km
from app.schemas.crisis_form import (
    CrisisEventCreate, CrisisEventUpdate, CrisisEventResponse,
    CrisisFormPackCreate, CrisisFormPackUpdate, CrisisFormPackResponse,
    CrisisFormPackVersionCreate, CrisisFormPackVersionResponse,
    PublishRequest, SchemaLintRequest, SchemaLintResponse,
    ActiveCrisisFormResponse, OperationSummaryResponse,
    OperationLaunchRequest, OperationLaunchResponse,
    OperationLaunchWithFormRequest, OperationFormTemplate,
)
import re as _re
from app.schemas.building import ResponderCreate, ResponderResponse, ResponderUpdate

logger = logging.getLogger(__name__)

public_router = APIRouter()       # /crisis-forms
admin_router = APIRouter()        # /admin/crisis-forms
operations_router = APIRouter()   # /operations (operator-facing rollup)


_OPEN_REPORT_STATUSES_EXCLUDED = [
    ReportStatusEnum.RESOLVED, ReportStatusEnum.REJECTED, ReportStatusEnum.FALSE_ALARM,
]


def resolve_active_event(db: Session, lat: float, lng: float, now: datetime):
    """Return (CrisisEvent, CrisisFormPack, CrisisFormPackVersion) for the
    crisis whose circle contains (lat, lng) right now, or None.

    Single source of truth for "which active crisis applies at this point" —
    used both by the public `/active` endpoint (so clients render the right
    Stage 2/3 pack) and by report intake (so the server can derive/verify
    `report.crisis_event_id`). Keeping both callers on the same matcher means a
    client's `/active` answer and the server's intake-time derivation can never
    disagree.

    Matching rule: among `is_active` events, SMALLEST-RADIUS-first — the most
    specific/precise zone wins when circles overlap (a tighter operation is the
    better home for a point inside both); ties (equal radius) broken by newest
    activation. Skip events with no pack, not yet started, or already ended; the
    event's circle must contain the point (haversine ≤ radius_km); the pack must
    be un-archived with a *published* active version. First qualifying match wins.
    A radius-less event (NULL) sorts last and is un-matchable anyway (0 km).
    """
    events = (db.query(CrisisEvent)
              .filter(CrisisEvent.is_active == True)  # noqa: E712
              .order_by(nullslast(CrisisEvent.radius_km.asc()),
                        CrisisEvent.created_at.desc())
              .all())
    for ev in events:
        if not ev.form_pack_id:
            continue
        if ev.started_at and ev.started_at > now:
            continue
        if ev.ended_at and ev.ended_at < now:
            continue
        try:
            dist = haversine_km(lat, lng, ev.center_lat, ev.center_lng)
        except (TypeError, ValueError):
            continue
        if dist <= (ev.radius_km or 0):
            pack = (db.query(CrisisFormPack)
                    .filter(CrisisFormPack.id == ev.form_pack_id,
                            CrisisFormPack.is_archived == False)  # noqa: E712
                    .first())
            if not pack or not pack.active_version:
                continue
            ver = (db.query(CrisisFormPackVersion)
                   .filter(CrisisFormPackVersion.pack_id == pack.id,
                           CrisisFormPackVersion.version == pack.active_version,
                           CrisisFormPackVersion.status == "published")
                   .first())
            if not ver:
                continue
            return (ev, pack, ver)
    return None


# ── Public: which crisis form applies at this point, right now? ─────────────
@public_router.get(
    "/active",
    response_model=ActiveCrisisFormResponse,
    summary="Active crisis form pack for a lat/lng (public, cacheable)",
)
def active_crisis_form(
    response: Response,
    request: Request,
    lat: float = Query(...),
    lng: float = Query(...),
    db: Session = Depends(get_db),
):
    """Returns the published pack of the SMALLEST-RADIUS ACTIVE, in-window
    CrisisEvent whose circle contains (lat,lng); else {active:false}. The most
    specific overlapping zone wins. Clients call this after the Stage-1 location
    fix (and re-call it when the reporter edits the location) and render the pack
    for Stage 2/3 — or fall back to the default flow when inactive. 60 s cache +
    ETag (zones change rarely)."""
    now = datetime.now(timezone.utc)
    match = resolve_active_event(db, lat, lng, now)

    response.headers["Cache-Control"] = "public, max-age=60"
    if not match:
        body = ActiveCrisisFormResponse(active=False)
        response.headers["ETag"] = '"none"'
        return body
    ev, pack, ver = match
    etag = '"' + hashlib.md5(f"{ev.id}:{pack.id}:{ver.version}".encode()).hexdigest() + '"'
    if request.headers.get("if-none-match") == etag:
        response.status_code = status.HTTP_304_NOT_MODIFIED
        response.headers["ETag"] = etag
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=dict(response.headers))
    response.headers["ETag"] = etag
    return ActiveCrisisFormResponse(
        active=True, event_id=ev.id, event_name=ev.name, crisis_type=ev.crisis_type,
        pack_id=pack.id, pack_version=ver.version, schema_json=ver.schema_json,
    )


# ── Operator: operations list (CrisisEvents + per-event report rollup) ──────
@operations_router.get("", response_model=List[OperationSummaryResponse],
                       summary="List operations with per-event report rollups")
@operations_router.get("/", response_model=List[OperationSummaryResponse], include_in_schema=False)
def list_operations(db: Session = Depends(get_db), _user=Depends(require_viewer)):
    """Every CrisisEvent (operation) + its live report rollup
    (Critical · New-24h · Total · last activity) in ONE grouped query — no N+1,
    regardless of operation count (must-have #12) — active operations first.
    Appends a synthetic row (id=None, is_cluster=True) counting
    un-operationalised open-critical reports: the rail's "Launch operation here"
    affordance. Operator-facing (require_viewer); editing stays on the admin
    /admin/crisis-forms/events routes."""
    now = datetime.now(timezone.utc)
    new_cut = now - timedelta(hours=24)
    prev_cut = now - timedelta(hours=48)   # [48h, 24h) window — trend delta vs new_24h
    # Report rollup per op — ONE grouped query. The report-only Phase-3 health
    # inputs (unattended_critical, sla_breaches, needs_review) fold in as SUM(CASE)
    # columns; escalation + responders need their own joins (below) — joining them
    # into this rollup would fan rows out and double-count the SUMs.
    rows = (
        db.query(
            CrisisEvent.id, CrisisEvent.name, CrisisEvent.crisis_type,
            CrisisEvent.status, CrisisEvent.is_active,
            CrisisEvent.center_lat, CrisisEvent.center_lng,
            # P2 card geography/identity/dates (functionally dependent on the PK,
            # so they need no GROUP BY entry under Postgres). form_name comes from
            # the 1:1 pack outerjoin below — MAX() keeps GROUP BY on the event id.
            CrisisEvent.radius_km, CrisisEvent.place_name,
            CrisisEvent.started_at, CrisisEvent.ended_at, CrisisEvent.form_pack_id,
            sa_func.max(CrisisFormPack.title).label("form_name"),
            sa_func.count(Report.id).label("total"),
            sa_func.coalesce(sa_func.sum(
                case((Report.severity == SeverityEnum.CRITICAL, 1), else_=0)), 0).label("critical"),
            # verified = reviewer accepted (mirrors analytics counts.verified).
            sa_func.coalesce(sa_func.sum(
                case((Report.reviewer_verdict == ReviewerVerdictEnum.ACCEPTED.value, 1), else_=0)), 0).label("verified"),
            sa_func.coalesce(sa_func.sum(
                case((Report.server_created_at >= new_cut, 1), else_=0)), 0).label("new_24h"),
            sa_func.coalesce(sa_func.sum(case((and_(
                Report.server_created_at >= prev_cut,
                Report.server_created_at < new_cut), 1), else_=0)), 0).label("new_prev_24h"),
            sa_func.max(Report.server_created_at).label("last_activity"),
            # unattended critical = CRITICAL, open, not yet dispatched (report-level "attended" signal).
            sa_func.coalesce(sa_func.sum(case((and_(
                Report.severity == SeverityEnum.CRITICAL,
                Report.status.notin_(_OPEN_REPORT_STATUSES_EXCLUDED),
                Report.help_dispatched_at.is_(None)), 1), else_=0)), 0).label("unattended_critical"),
            # SLA breaches — mirrors analytics sla_at_risk (per-severity thresholds).
            sa_func.coalesce(sa_func.sum(case((and_(
                Report.status == ReportStatusEnum.PENDING,
                or_(*[and_(Report.severity == sev, Report.server_created_at < now - timedelta(hours=h))
                      for sev, h in _SLA_THRESHOLD_HOURS.items()])), 1), else_=0)), 0).label("sla_breaches"),
            # review backlog.
            sa_func.coalesce(sa_func.sum(case((and_(
                Report.reviewer_verdict == ReviewerVerdictEnum.NOT_REVIEWED.value,
                Report.help_dispatched_at.is_(None),
                Report.status != ReportStatusEnum.RESPONDING), 1), else_=0)), 0).label("needs_review"),
        )
        .outerjoin(Report, and_(
            Report.crisis_event_id == CrisisEvent.id,
            Report.deletion_requested_at.is_(None),
        ))
        # 1:1 pack join for the card's form name — does NOT fan out the Report
        # SUMs (≤1 pack per event), so the conditional aggregates stay correct.
        .outerjoin(CrisisFormPack, CrisisFormPack.id == CrisisEvent.form_pack_id)
        .group_by(CrisisEvent.id)
        .order_by(CrisisEvent.is_active.desc(), CrisisEvent.created_at.desc())
        .all()
    )
    # Escalating hotspots per op (Report⨝Building grouped — constant query count).
    esc_by_op = {
        row[0]: int(row[1] or 0)
        for row in (db.query(Report.crisis_event_id,
                        sa_func.count(sa_func.distinct(Report.building_id)))
            .join(Building, Building.id == Report.building_id)
            .filter(Report.crisis_event_id.isnot(None),
                    Report.deletion_requested_at.is_(None),
                    Report.status.notin_(_OPEN_REPORT_STATUSES_EXCLUDED),
                    Building.escalation_risk >= _ESCALATING_RISK_THRESHOLD,
                    Building.state.notin_(_CLOSED_BUILDING_STATES))
            .group_by(Report.crisis_event_id).all())
    }
    # Active responders per op (Phase 3a: cleared_at IS NULL, crisis_event_id set).
    resp_by_op = {
        row[0]: int(row[1] or 0)
        for row in (db.query(BuildingResponder.crisis_event_id,
                        sa_func.count(BuildingResponder.id))
            .filter(BuildingResponder.cleared_at.is_(None),
                    BuildingResponder.crisis_event_id.isnot(None))
            .group_by(BuildingResponder.crisis_event_id).all())
    }
    ops = []
    for r in rows:
        _unatt = int(r.unattended_critical or 0)
        _sla = int(r.sla_breaches or 0)
        _nr = int(r.needs_review or 0)
        health, reason = _compute_operation_health(
            now=now, sla_breaches=_sla, unattended_critical=_unatt,
            escalating=esc_by_op.get(r.id, 0), needs_review=_nr, last_activity=r.last_activity)
        ops.append(OperationSummaryResponse(
            id=r.id, name=r.name, crisis_type=r.crisis_type, status=r.status,
            is_active=bool(r.is_active), center_lat=r.center_lat, center_lng=r.center_lng,
            radius_km=r.radius_km, place_name=r.place_name,
            started_at=r.started_at, ended_at=r.ended_at,
            form_pack_id=r.form_pack_id, form_name=r.form_name,
            critical=int(r.critical or 0), new_24h=int(r.new_24h or 0),
            new_prev_24h=int(r.new_prev_24h or 0), total=int(r.total or 0),
            verified=int(r.verified or 0),
            last_activity=r.last_activity, is_cluster=False,
            health=health, health_reason=reason,
            responders_active=resp_by_op.get(r.id, 0),
            unattended_critical=_unatt, sla_breaches=_sla,
        ))
    # Un-operationalised critical clusters: open-critical reports tied to NO
    # operation — surfaced as a single CTA row ("Launch operation here").
    orphan_critical = int(
        db.query(sa_func.count(Report.id))
          .filter(
              Report.deletion_requested_at.is_(None),
              Report.crisis_event_id.is_(None),
              Report.severity == SeverityEnum.CRITICAL,
              Report.status.notin_(_OPEN_REPORT_STATUSES_EXCLUDED),
          ).scalar() or 0
    )
    if orphan_critical:
        ops.append(OperationSummaryResponse(
            id=None, name="Unassigned critical reports", is_cluster=True,
            critical=orphan_critical, total=orphan_critical,
        ))
    return ops


# ── Operator: local weather + hazard alerts for an operation (P4) ───────────
@operations_router.get("/{event_id}/weather",
                       summary="Local weather (Open-Meteo) + hazard alerts (GDACS) for an operation")
async def operation_weather(event_id: str, db: Session = Depends(get_db),
                            _user=Depends(require_viewer)):
    """Backend-proxied local conditions for the operation's region — current
    weather + 3-day forecast (Open-Meteo) and nearby disaster alerts (GDACS),
    cached 45 min. Returns 200 {available:false} (never 5xx) when both providers
    are unreachable so the dashboard never hard-fails. The ONLY data sent upstream
    is the operation's centre coords + radius — never any report/reporter data."""
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Operation not found")
    from app.services.operation_context import (
        fetch_operation_context, cache_get, cache_put,
    )
    cached = cache_get(event_id)
    if cached is not None:
        return cached
    ctx = await fetch_operation_context(ev.center_lat, ev.center_lng, ev.radius_km or 30.0)
    cache_put(event_id, ctx)
    return ctx


# ── Operator: operation-level responders (Phase 3, Option B) ────────────────
# Reuses the BuildingResponder table with target_type=OPERATION + crisis_event_id
# (building_id NULL) — no separate Team/Org entity. Same assigned → dispatched →
# arrived → cleared lifecycle as building responders; cleared_at IS NULL = active.
@operations_router.get("/{event_id}/responders", response_model=List[ResponderResponse],
                       summary="List responders assigned to an operation")
def list_operation_responders(event_id: str, db: Session = Depends(get_db),
                              _user=Depends(require_viewer)):
    return (db.query(BuildingResponder)
            .filter(BuildingResponder.crisis_event_id == event_id)
            .order_by(BuildingResponder.assigned_at.desc())
            .all())


@operations_router.post("/{event_id}/responders", response_model=ResponderResponse,
                        status_code=status.HTTP_201_CREATED,
                        summary="Assign a responder to an operation")
def assign_operation_responder(event_id: str, body: ResponderCreate,
                               db: Session = Depends(get_db), user=Depends(require_analyst)):
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Operation not found")
    r = BuildingResponder(
        building_id=None,
        crisis_event_id=event_id,
        target_type="OPERATION",
        org_type=(body.org_type or "OTHER"),
        assigned_by_user_id=getattr(user, "id", None),
        responder_name=body.responder_name,
        responder_org=body.responder_org,
        responder_contact=body.responder_contact,
        eta_minutes=body.eta_minutes,
        notes=body.notes,
    )
    db.add(r); db.commit(); db.refresh(r)
    logger.info(f"[Operation] responder assigned op={event_id[:8]} name={body.responder_name!r}")
    return r


@operations_router.patch("/{event_id}/responders/{responder_id}", response_model=ResponderResponse,
                         summary="Advance an operation responder's lifecycle")
def update_operation_responder(event_id: str, responder_id: str, body: ResponderUpdate,
                               db: Session = Depends(get_db), _user=Depends(require_analyst)):
    r = (db.query(BuildingResponder)
         .filter(BuildingResponder.id == responder_id,
                 BuildingResponder.crisis_event_id == event_id)
         .first())
    if not r:
        raise HTTPException(status_code=404, detail="Responder not found")
    now = datetime.now(timezone.utc)
    if body.action == "dispatched":
        r.dispatched_at = now
    elif body.action == "arrived":
        r.arrived_at = now
    elif body.action == "cleared":
        r.cleared_at = now
    if body.eta_minutes is not None:
        r.eta_minutes = body.eta_minutes
    if getattr(body, "notes", None) is not None:
        r.notes = body.notes
    db.commit(); db.refresh(r)
    return r


# ── Operator: auto-claim write-path (Phase 3) — launch / unclaim ────────────
@operations_router.post("/launch", response_model=OperationLaunchResponse,
                        status_code=status.HTTP_201_CREATED,
                        summary="Launch an operation from the un-operationalised critical cluster")
def launch_operation(payload: OperationLaunchRequest, db: Session = Depends(get_db),
                     user=Depends(require_analyst)):
    """Operationalize the un-operationalised critical cluster: create a CrisisEvent
    from the open-critical reports that belong to NO operation (centroid + bounding
    radius) and bulk-claim them (set crisis_event_id). Reversible via /unclaim. If
    the cluster centroid sits inside a SMALLER existing active operation, claim INTO
    that op instead of creating a duplicate (locked dedup rule)."""
    if payload.form_pack_id and not db.query(CrisisFormPack).filter(
            CrisisFormPack.id == payload.form_pack_id).first():
        raise HTTPException(status_code=400, detail="form_pack_id does not exist")
    # Lock the orphan-critical rows so two concurrent launches can't both grab them.
    # No eager load: FOR UPDATE can't apply to the nullable side of an outer join,
    # and the cluster is small (a handful of criticals) → lazy location reads are fine.
    orphans = (db.query(Report)
               .filter(Report.deletion_requested_at.is_(None),
                       Report.crisis_event_id.is_(None),
                       Report.severity == SeverityEnum.CRITICAL,
                       Report.status.notin_(_OPEN_REPORT_STATUSES_EXCLUDED))
               .with_for_update(skip_locked=True)
               .all())
    if not orphans:
        raise HTTPException(status_code=409,
                            detail="No un-operationalised critical reports to claim")
    pts = [(r.location.latitude, r.location.longitude) for r in orphans
           if r.location and r.location.latitude is not None and r.location.longitude is not None]
    if pts:
        center_lat = sum(p[0] for p in pts) / len(pts)
        center_lng = sum(p[1] for p in pts) / len(pts)
        radius_km = min(30.0, max(
            (haversine_km(center_lat, center_lng, p[0], p[1]) for p in pts), default=0.0) + 5.0)
        if radius_km <= 0:
            radius_km = 30.0
    else:
        center_lat = center_lng = 0.0
        radius_km = 30.0
    # Dedup: claim INTO a SMALLER existing active op whose circle contains the centroid.
    target = None
    if pts:
        for existing in (db.query(CrisisEvent)
                         .filter(CrisisEvent.is_active.is_(True),
                                 CrisisEvent.center_lat.isnot(None)).all()):
            try:
                d = haversine_km(center_lat, center_lng, existing.center_lat, existing.center_lng)
            except (TypeError, ValueError):
                continue
            if d <= (existing.radius_km or 0) and (existing.radius_km or 0) < radius_km:
                target = existing
                break
    merged = target is not None
    if target is None:
        target = CrisisEvent(
            name=payload.name, crisis_type=payload.crisis_type,
            status="LIVE", is_active=True,
            center_lat=center_lat, center_lng=center_lng, radius_km=radius_km,
            form_pack_id=payload.form_pack_id, created_by=getattr(user, "id", None))
        db.add(target); db.flush()
    ids = [r.id for r in orphans]
    # Re-check crisis_event_id IS NULL inside the UPDATE WHERE — a concurrent launch
    # that already claimed a report updates 0 rows for it (no double-claim).
    claimed = (db.query(Report)
               .filter(Report.id.in_(ids), Report.crisis_event_id.is_(None))
               .update({Report.crisis_event_id: target.id}, synchronize_session=False))
    db.add(OperationClaimLog(
        operation_id=target.id, event_kind="CLAIMED",
        report_ids=ids, report_count=len(ids),
        actor_user_id=getattr(user, "id", None)))
    db.commit()
    # Denormalise the centroid's place name for a freshly-launched op (best-effort;
    # a merged-into existing op already has one).
    if not merged and (target.center_lat or target.center_lng):
        pn = _resolve_place_name(target.center_lat, target.center_lng, db)
        if pn:
            target.place_name = pn
            db.commit()
    logger.info(f"[Operation] launch op={target.id[:8]} claimed={claimed} merged={merged}")
    return OperationLaunchResponse(
        operation_id=target.id, operation_name=target.name,
        claimed_count=int(claimed or 0), skipped_count=len(ids) - int(claimed or 0),
        merged_into_existing=merged)


def _slugify(text: str) -> str:
    s = _re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s[:48] or "operation-form"


@operations_router.get("/form-templates", response_model=List[OperationFormTemplate],
                       summary="List published form templates (analyst-scoped) for the launch wizard")
def list_form_templates(db: Session = Depends(get_db), _user=Depends(require_analyst)):
    """Published packs the wizard's Step 1 can start from. Analyst-scoped so the
    admin pack-management routes stay require_admin — returns only each pack's active
    published schema, nothing operator-private."""
    packs = (db.query(CrisisFormPack)
             .filter(CrisisFormPack.is_archived == False,            # noqa: E712
                     CrisisFormPack.active_version.isnot(None))
             .order_by(CrisisFormPack.created_at.desc()).all())
    out = []
    for p in packs:
        ver = (db.query(CrisisFormPackVersion)
               .filter(CrisisFormPackVersion.pack_id == p.id,
                       CrisisFormPackVersion.version == p.active_version)
               .first())
        out.append(OperationFormTemplate(
            id=p.id, key=p.key, title=p.title, crisis_type=p.crisis_type,
            schema_json=(ver.schema_json if ver else None)))
    return out


@operations_router.post("/launch-with-form", response_model=OperationLaunchResponse,
                        status_code=status.HTTP_201_CREATED,
                        summary="Atomically create a form pack + a LIVE operation (wizard publish)")
def launch_with_form(payload: OperationLaunchWithFormRequest, db: Session = Depends(get_db),
                     user=Depends(require_analyst)):
    """The wizard's Step-4 publish. Creates pack → published version → LIVE CrisisEvent
    (optionally claiming the orphan-critical cluster) in ONE transaction; any failure
    rolls the whole thing back so nothing half-built ever persists (no-draft-persistence).
    Each operation gets its own pack — operation-scoped forms never couple to another op."""
    title = (payload.form_title or payload.name or "Operation form").strip()
    # Unique pack key derived from the title (operation forms are pack-scoped per op).
    base = _slugify(title)
    key, n = base, 1
    while db.query(CrisisFormPack).filter(CrisisFormPack.key == key).first():
        n += 1
        key = f"{base}-{n}"
    # The server owns key/title inside the schema so the linter always has them.
    schema = dict(payload.schema_json or {})
    schema["key"], schema["title"] = key, title
    errs = validate_pack_schema(schema)
    if errs:
        raise HTTPException(status_code=400, detail={"schema_errors": errs})

    try:
        pack = CrisisFormPack(key=key, title=title, crisis_type=payload.crisis_type,
                              created_by=getattr(user, "id", None))
        db.add(pack); db.flush()
        ver = CrisisFormPackVersion(
            pack_id=pack.id, version=1, schema_json=schema, status="published",
            published_at=datetime.now(timezone.utc), created_by=getattr(user, "id", None))
        db.add(ver); db.flush()
        pack.active_version = 1
        pack.is_archived = False

        ev = CrisisEvent(
            name=payload.name, crisis_type=payload.crisis_type,
            status="LIVE", is_active=True,
            center_lat=payload.center_lat, center_lng=payload.center_lng,
            radius_km=payload.radius_km, started_at=payload.started_at,
            ended_at=payload.ended_at, place_name=payload.place_name,
            form_pack_id=pack.id, created_by=getattr(user, "id", None))
        db.add(ev); db.flush()

        claimed, ids = 0, []
        if payload.from_cluster:
            orphans = (db.query(Report)
                       .filter(Report.deletion_requested_at.is_(None),
                               Report.crisis_event_id.is_(None),
                               Report.severity == SeverityEnum.CRITICAL,
                               Report.status.notin_(_OPEN_REPORT_STATUSES_EXCLUDED))
                       .with_for_update(skip_locked=True).all())
            ids = [r.id for r in orphans]
            if ids:
                claimed = (db.query(Report)
                           .filter(Report.id.in_(ids), Report.crisis_event_id.is_(None))
                           .update({Report.crisis_event_id: ev.id}, synchronize_session=False))
                db.add(OperationClaimLog(
                    operation_id=ev.id, event_kind="CLAIMED",
                    report_ids=ids, report_count=len(ids),
                    actor_user_id=getattr(user, "id", None)))
        db.commit()
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback()
        logger.exception("[Operation] launch-with-form failed; rolled back (no rows persisted)")
        raise HTTPException(status_code=500, detail="Could not launch the operation")

    db.refresh(ev)
    if not ev.place_name and (ev.center_lat or ev.center_lng):
        pn = _resolve_place_name(ev.center_lat, ev.center_lng, db)
        if pn:
            ev.place_name = pn
            db.commit()
    logger.info(f"[Operation] launch-with-form op={ev.id[:8]} pack={key!r} claimed={claimed}")
    return OperationLaunchResponse(
        operation_id=ev.id, operation_name=ev.name,
        claimed_count=int(claimed or 0), skipped_count=len(ids) - int(claimed or 0),
        merged_into_existing=False)


@operations_router.post("/{event_id}/unclaim", response_model=OperationLaunchResponse,
                        summary="Undo the most recent cluster claim on an operation")
def unclaim_operation(event_id: str, db: Session = Depends(get_db),
                      user=Depends(require_analyst)):
    """Reverse the most recent CLAIMED action on this operation — un-set
    crisis_event_id on exactly the reports that were claimed."""
    last = (db.query(OperationClaimLog)
            .filter(OperationClaimLog.operation_id == event_id,
                    OperationClaimLog.event_kind == "CLAIMED")
            .order_by(OperationClaimLog.happened_at.desc())
            .first())
    if not last:
        raise HTTPException(status_code=404, detail="No claim to undo for this operation")
    ids = last.report_ids or []
    unclaimed = 0
    if ids:
        unclaimed = (db.query(Report)
                     .filter(Report.id.in_(ids), Report.crisis_event_id == event_id)
                     .update({Report.crisis_event_id: None}, synchronize_session=False))
    db.add(OperationClaimLog(
        operation_id=event_id, event_kind="UNCLAIMED",
        report_ids=ids, report_count=int(unclaimed or 0),
        actor_user_id=getattr(user, "id", None)))
    db.commit()
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    return OperationLaunchResponse(
        operation_id=event_id, operation_name=(ev.name if ev else ""),
        unclaimed_count=int(unclaimed or 0))


# ── Admin: Crisis Events CRUD ───────────────────────────────────────────────
@admin_router.get("/events", response_model=List[CrisisEventResponse], summary="List crisis events (admin)")
def list_events(db: Session = Depends(get_db), _user=Depends(require_admin)):
    return db.query(CrisisEvent).order_by(CrisisEvent.created_at.desc()).all()


def _resolve_place_name(lat, lng, db) -> Optional[str]:
    """Best-effort "City, Country" for an operation centre via the reverse-geocode
    cascade (GeocodeCache → Mapbox → Nominatim). NEVER raises and never fails an
    admin write — returns None so the card falls back to coordinates. Skipped under
    pytest (the suite makes no external network calls). Called AFTER the event row
    is committed so the geocoder's own cache writes can't disturb the create txn."""
    import os
    if os.environ.get("PYTEST_CURRENT_TEST") or lat is None or lng is None:
        return None
    try:
        import asyncio
        from messaging_bot.sms.geocoder import reverse_geocode_coords
        res = asyncio.run(reverse_geocode_coords(float(lat), float(lng), language="en", db=db))
        name = (res or {}).get("location_name")
        return name or None
    except Exception as _e:  # geocoder down / event-loop issue → coordinates fallback
        logger.info(f"[CrisisEvent] place_name geocode skipped: {_e}")
        return None


@admin_router.post("/events", response_model=CrisisEventResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a crisis event")
def create_event(payload: CrisisEventCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    if payload.form_pack_id:
        if not db.query(CrisisFormPack).filter(CrisisFormPack.id == payload.form_pack_id).first():
            raise HTTPException(status_code=400, detail="form_pack_id does not exist")
    ev = CrisisEvent(**payload.model_dump(), created_by=user.id)
    # Two-state invariant: is_active is a strict function of status (LIVE ⟺ active).
    # Never trust a client-supplied is_active — derive it (ENDED ⇒ stops matching).
    ev.is_active = (ev.status == "LIVE")
    db.add(ev); db.commit(); db.refresh(ev)
    if not ev.place_name:              # denormalise the centre's place name (best-effort)
        pn = _resolve_place_name(ev.center_lat, ev.center_lng, db)
        if pn:
            ev.place_name = pn
            db.commit(); db.refresh(ev)
    logger.info(f"[CrisisEvent] created id={ev.id[:8]} name={ev.name!r} active={ev.is_active} r={ev.radius_km}km")
    return ev


@admin_router.patch("/events/{event_id}", response_model=CrisisEventResponse, summary="Update a crisis event")
def update_event(event_id: str, payload: CrisisEventUpdate, db: Session = Depends(get_db), _user=Depends(require_admin)):
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Crisis event not found")
    data = payload.model_dump(exclude_unset=True)
    if data.get("form_pack_id"):
        if not db.query(CrisisFormPack).filter(CrisisFormPack.id == data["form_pack_id"]).first():
            raise HTTPException(status_code=400, detail="form_pack_id does not exist")
    for k, v in data.items():
        setattr(ev, k, v)
    # Two-state invariant: when status changes, is_active follows it (LIVE ⟺ active).
    # This is the "End operation" action — PATCH {status:"ENDED"} flips is_active off
    # so the op drops out of resolve_active_event and moves to the ENDED group.
    if "status" in data:
        ev.is_active = (ev.status == "LIVE")
    # Re-derive place_name when the centre MOVED and the caller didn't set one.
    if ("center_lat" in data or "center_lng" in data) and "place_name" not in data:
        ev.place_name = _resolve_place_name(ev.center_lat, ev.center_lng, db) or ev.place_name
    db.commit(); db.refresh(ev)
    logger.info(f"[CrisisEvent] updated id={ev.id[:8]} changes={list(data.keys())}")
    return ev


@admin_router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a crisis event")
def delete_event(event_id: str, db: Session = Depends(get_db), _user=Depends(require_admin)):
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Crisis event not found")
    db.delete(ev); db.commit()
    logger.info(f"[CrisisEvent] deleted id={ev.id[:8]}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Admin: Packs ────────────────────────────────────────────────────────────
@admin_router.get("/packs", response_model=List[CrisisFormPackResponse], summary="List crisis form packs (admin)")
def list_packs(db: Session = Depends(get_db), _user=Depends(require_admin)):
    return db.query(CrisisFormPack).order_by(CrisisFormPack.created_at.desc()).all()


@admin_router.post("/packs", response_model=CrisisFormPackResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a pack")
def create_pack(payload: CrisisFormPackCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    if db.query(CrisisFormPack).filter(CrisisFormPack.key == payload.key).first():
        raise HTTPException(status_code=409, detail="pack key already exists")
    pack = CrisisFormPack(**payload.model_dump(), created_by=user.id)
    db.add(pack); db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] created id={pack.id[:8]} key={pack.key!r}")
    return pack


@admin_router.patch("/packs/{pack_id}", response_model=CrisisFormPackResponse, summary="Update a pack")
def update_pack(pack_id: str, payload: CrisisFormPackUpdate, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(pack, k, v)
    db.commit(); db.refresh(pack)
    return pack


@admin_router.get("/packs/{pack_id}/versions", response_model=List[CrisisFormPackVersionResponse],
                  summary="List a pack's versions")
def list_versions(pack_id: str, db: Session = Depends(get_db), _user=Depends(require_admin)):
    return (db.query(CrisisFormPackVersion)
            .filter(CrisisFormPackVersion.pack_id == pack_id)
            .order_by(CrisisFormPackVersion.version.desc()).all())


@admin_router.post("/packs/{pack_id}/versions", response_model=CrisisFormPackVersionResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a draft version (lints the schema)")
def create_version(pack_id: str, payload: CrisisFormPackVersionCreate,
                   db: Session = Depends(get_db), user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    errs = validate_pack_schema(payload.schema_json)
    if errs:
        raise HTTPException(status_code=400, detail={"schema_errors": errs})
    last = (db.query(CrisisFormPackVersion)
            .filter(CrisisFormPackVersion.pack_id == pack_id)
            .order_by(CrisisFormPackVersion.version.desc()).first())
    next_ver = (last.version + 1) if last else 1
    ver = CrisisFormPackVersion(pack_id=pack_id, version=next_ver,
                                schema_json=payload.schema_json, status="draft", created_by=user.id)
    db.add(ver); db.commit(); db.refresh(ver)
    logger.info(f"[CrisisPack] {pack.key} draft v{next_ver} created")
    return ver


@admin_router.post("/packs/{pack_id}/publish", response_model=CrisisFormPackResponse,
                   summary="Publish a version (demotes the prior published one)")
def publish_version(pack_id: str, payload: PublishRequest, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    ver = (db.query(CrisisFormPackVersion)
           .filter(CrisisFormPackVersion.pack_id == pack_id, CrisisFormPackVersion.version == payload.version)
           .first())
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    # demote the currently-published version (if any, and different)
    for other in db.query(CrisisFormPackVersion).filter(
            CrisisFormPackVersion.pack_id == pack_id,
            CrisisFormPackVersion.status == "published").all():
        if other.version != ver.version:
            other.status = "archived"
    ver.status = "published"
    ver.published_at = datetime.now(timezone.utc)
    pack.active_version = ver.version
    pack.is_archived = False
    db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] {pack.key} published v{ver.version} (now active)")
    return pack


@admin_router.post("/packs/{pack_id}/rollback", response_model=CrisisFormPackResponse,
                   summary="Roll back active pack to an earlier published version")
def rollback_version(pack_id: str, payload: PublishRequest, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    ver = (db.query(CrisisFormPackVersion)
           .filter(CrisisFormPackVersion.pack_id == pack_id, CrisisFormPackVersion.version == payload.version)
           .first())
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    if ver.status != "published":
        # mark it published again (rollback re-activates a prior published version)
        ver.status = "published"
        if not ver.published_at:
            ver.published_at = datetime.now(timezone.utc)
    pack.active_version = ver.version
    db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] {pack.key} rolled back to v{ver.version}")
    return pack


@admin_router.post("/packs/validate", response_model=SchemaLintResponse,
                   summary="Lint a schema_json without saving (builder preview)")
def lint_schema(payload: SchemaLintRequest, _user=Depends(require_admin)):
    errs = validate_pack_schema(payload.schema_json)
    return SchemaLintResponse(valid=not errs, errors=errs)
