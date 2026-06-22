"""Incident endpoints — Building-centric Incident-Feed redesign Phase 2D/2E.

An Incident is the first-class operational EVENT (Building → Incident → Report).
This module exposes the read APIs the dashboard's Incident Detail needs + the
analyst authority operations over incident assembly:

  GET    /incidents                 list (scoped: building/operation/status), worst-first, paginated
  GET    /incidents/{id}            one incident + its member reports (evidence)
  POST   /incidents/{id}/merge      merge another incident INTO this one
  POST   /incidents/move-report     move a report to a different incident
  POST   /incidents/split-report    detach a report into its own new incident
  PATCH  /incidents/{id}            analyst override of status / severity / title

Duplicate detection only ASSISTS incident assembly (intake HIGH-join + the
candidate-pair suggestions); the analyst is the AUTHORITY here. Roll-ups
(report_count, severity, lead) are recomputed from member reports after every
mutation, reusing reports._recompute_incident_rollup. Mutations are ANALYST+.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import case
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.core.deps import require_viewer, require_analyst
from app.models.report import (
    Incident, Report, IncidentStatusEnum, SeverityEnum,
)
from app.schemas.report import _utc_iso
from app.api.endpoints.reports import (
    _recompute_incident_rollup, _new_incident_from_report,
)

router = APIRouter()

# Worst-first ordering: severity rank desc, then most-recently-updated.
_SEV_ORDER = case(
    {"CRITICAL": 4, "SEVERE": 3, "MODERATE": 2, "MINOR": 1},
    value=Incident.severity, else_=0,
)


# ── request bodies ──────────────────────────────────────────────────────────
class IncidentMergeRequest(BaseModel):
    source_incident_id: str


class IncidentMoveRequest(BaseModel):
    report_id: str
    target_incident_id: str


class IncidentSplitRequest(BaseModel):
    report_id: str


class IncidentPatchRequest(BaseModel):
    status: Optional[str] = None
    severity: Optional[str] = None
    title: Optional[str] = None


# ── serializers (plain dicts; no response_model churn) ──────────────────────
def _incident_dict(inc: Incident) -> dict:
    return {
        "id": inc.id,
        "building_id": inc.building_id,
        "crisis_event_id": inc.crisis_event_id,
        "incident_type": inc.incident_type,
        "severity": inc.severity,
        "severity_overridden": bool(inc.severity_overridden),
        "status": inc.status,
        "title": inc.title,
        "lead_report_id": inc.lead_report_id,
        "report_count": inc.report_count,
        "created_at": _utc_iso(inc.created_at),
        "updated_at": _utc_iso(inc.updated_at),
    }


def _member_dict(r: Report, lead_id: Optional[str]) -> dict:
    desc = (r.description or "")
    return {
        "id": r.id,
        "severity": (r.severity.value if hasattr(r.severity, "value") else r.severity),
        "status": (r.status.value if hasattr(r.status, "value") else r.status),
        "reviewer_verdict": r.reviewer_verdict,
        "crisis_type": r.crisis_type,
        "infrastructure_type": (r.infrastructure_type.value if hasattr(r.infrastructure_type, "value") else r.infrastructure_type),
        "source": (r.source.value if hasattr(r.source, "value") else r.source),
        "server_created_at": _utc_iso(r.server_created_at),
        "description": (desc[:160] + "…") if len(desc) > 160 else desc,
        "is_lead": (r.id == lead_id),
    }


def _members(db: Session, incident_id: str) -> list:
    rows = (
        db.query(Report)
        .filter(Report.incident_id == incident_id, Report.deletion_requested_at.is_(None))
        .order_by(Report.server_created_at.asc())
        .all()
    )
    return rows


# ── reads ───────────────────────────────────────────────────────────────────
@router.get("")
def list_incidents(
    response: Response,
    building_id: Optional[str] = None,
    crisis_event_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user=Depends(require_viewer),
):
    """List incidents, worst-first (severity, then recency). Scope by building,
    operation (crisis_event_id), and/or status. X-Total-Count for pagination (#12)."""
    q = db.query(Incident)
    if building_id:
        q = q.filter(Incident.building_id == building_id)
    if crisis_event_id:
        q = q.filter(Incident.crisis_event_id == crisis_event_id)
    if status:
        q = q.filter(Incident.status == status)
    total = q.count()
    rows = (
        q.order_by(_SEV_ORDER.desc(), Incident.updated_at.desc())
        .limit(limit).offset(offset).all()
    )
    response.headers["X-Total-Count"] = str(total)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count"
    return [_incident_dict(i) for i in rows]


@router.get("/{incident_id}")
def get_incident(incident_id: str, db: Session = Depends(get_db), user=Depends(require_viewer)):
    """One incident + its member reports (the evidence stack for the detail view)."""
    inc = db.get(Incident, incident_id)
    if inc is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    members = _members(db, incident_id)
    d = _incident_dict(inc)
    d["reports"] = [_member_dict(r, inc.lead_report_id) for r in members]
    return d


# ── analyst authority operations ────────────────────────────────────────────
@router.post("/{incident_id}/merge")
def merge_incidents(
    incident_id: str,
    body: IncidentMergeRequest,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Merge `source_incident_id` INTO `incident_id`: reassign all of the source's
    reports to the target, recompute the target, and delete the (now-empty) source.
    The analyst has decided the two are the same real-world event."""
    if body.source_incident_id == incident_id:
        raise HTTPException(status_code=400, detail="Cannot merge an incident into itself")
    target = db.get(Incident, incident_id)
    source = db.get(Incident, body.source_incident_id)
    if target is None or source is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    db.query(Report).filter(Report.incident_id == source.id).update(
        {Report.incident_id: target.id}, synchronize_session=False
    )
    db.flush()
    _recompute_incident_rollup(target, db)
    db.delete(source)
    db.commit()
    return {"merged": True, "incident": _incident_dict(target),
            "source_incident_id": body.source_incident_id}


@router.post("/move-report")
def move_report(
    body: IncidentMoveRequest,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Move a single report from its current incident to `target_incident_id`.
    Recomputes both incidents; deletes the source incident if it becomes empty."""
    report = db.get(Report, body.report_id)
    target = db.get(Incident, body.target_incident_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    if target is None:
        raise HTTPException(status_code=404, detail="Target incident not found")
    old_id = report.incident_id
    if old_id == target.id:
        return {"moved": False, "incident": _incident_dict(target)}

    report.incident_id = target.id
    db.flush()
    _recompute_incident_rollup(target, db)
    if old_id:
        old = db.get(Incident, old_id)
        if old is not None:
            _recompute_incident_rollup(old, db)
            if old.report_count == 0:
                db.delete(old)
    db.commit()
    return {"moved": True, "incident": _incident_dict(target),
            "from_incident_id": old_id, "report_id": body.report_id}


@router.post("/split-report")
def split_report(
    body: IncidentSplitRequest,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Detach a report into its OWN new incident (it's a distinct event, not a
    member of its current incident). No-op if the report is already a singleton."""
    report = db.get(Report, body.report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    old_id = report.incident_id
    old = db.get(Incident, old_id) if old_id else None
    if old is not None and old.report_count <= 1:
        # Already its own incident - nothing to split.
        return {"split": False, "incident": _incident_dict(old)}

    new_inc = _new_incident_from_report(report, db, getattr(user, "id", None))
    report.incident_id = new_inc.id
    db.flush()
    if old is not None:
        _recompute_incident_rollup(old, db)
    db.commit()
    return {"split": True, "incident": _incident_dict(new_inc),
            "from_incident_id": old_id, "report_id": body.report_id}


@router.patch("/{incident_id}")
def patch_incident(
    incident_id: str,
    body: IncidentPatchRequest,
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Analyst override of an incident's status / severity / title. Setting severity
    here PINS it (severity_overridden=True) so member-report roll-ups won't clobber
    the analyst's call."""
    inc = db.get(Incident, incident_id)
    if inc is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    if body.status is not None:
        if body.status not in {s.value for s in IncidentStatusEnum}:
            raise HTTPException(status_code=422, detail=f"Invalid status: {body.status}")
        inc.status = body.status
    if body.severity is not None:
        if body.severity not in {s.value for s in SeverityEnum}:
            raise HTTPException(status_code=422, detail=f"Invalid severity: {body.severity}")
        inc.severity = body.severity
        inc.severity_overridden = True
    if body.title is not None:
        inc.title = body.title[:200]
    db.commit()
    return _incident_dict(inc)
