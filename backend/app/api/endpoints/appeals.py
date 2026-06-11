"""
Admin moderation + appeal framework endpoints.

Phase 4 (May 2026, docs/NEARBY_REPORTS_PIPELINE.md §6.4 + §7.5).
CRISP hosts the core moderation/appeal framework; UNDP and other
deployment partners optionally integrate their workflows via outbound
webhooks + admin-role mappings.

Endpoints:

  POST /api/v1/admin/appeals
       Open an appeal on behalf of a device. Body: {device_id,
       claim_text}. Snapshots the device's current spam_score +
       spam_signals so post-decision rollbacks don't lose context.

  GET  /api/v1/admin/appeals?status=open
       List appeals by status. Sorted newest-first.

  GET  /api/v1/admin/appeals/{appeal_id}
       Read one appeal + its event timeline.

  POST /api/v1/admin/appeals/{appeal_id}/decide
       Decision: 'reinstated' | 'upheld' | 'banned'. Reinstated
       resets the device's spam_score to 0 and clears spam_signals.

All endpoints are require_admin gated. Decision events are
audit-logged in appeal_events with the admin's id.

Webhook integration is out-of-scope for this commit — the schema
supports `webhook_sent` events; the actual outbound delivery is
left to a Phase-5 background worker.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.deps import require_admin
from app.db.session import get_db
from app.models.report import Appeal, AppealEvent, Device
from app.schemas.report import _utc_iso  # Z-suffixed UTC wire format


router = APIRouter()


# ── Pydantic I/O ────────────────────────────────────────────────────

class OpenAppealIn(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=36)
    claim_text: Optional[str] = Field(None, max_length=4000)
    user_id: Optional[str] = Field(None, max_length=36)


class DecideAppealIn(BaseModel):
    decision: str = Field(..., pattern="^(reinstated|upheld|banned)$")
    notes: Optional[str] = Field(None, max_length=4000)


class AppealOut(BaseModel):
    id: str
    device_id: Optional[str]
    user_id: Optional[str]
    status: str
    claim_text: Optional[str]
    original_signals: list
    original_spam_score: Optional[float]
    opened_at: datetime
    decided_at: Optional[datetime]
    decided_by_admin_id: Optional[str]
    decision_notes: Optional[str]


# ── Helpers ────────────────────────────────────────────────────────

def _emit(db: Session, appeal_id: str, *, event_kind: str,
          actor_admin_id: Optional[str] = None,
          payload: Optional[dict] = None) -> None:
    """Append an event to the appeal's timeline."""
    db.add(AppealEvent(
        appeal_id=appeal_id,
        event_kind=event_kind,
        actor_admin_id=actor_admin_id,
        payload=payload or {},
    ))


# ── Endpoints ──────────────────────────────────────────────────────

@router.post("", response_model=AppealOut, status_code=201)
def open_appeal(
    body: OpenAppealIn = Body(...),
    db: Session = Depends(get_db),
    admin_user = Depends(require_admin),
):
    """Open an appeal. Snapshot the device's current trust state so
    a later decision can restore prior state if reinstated."""
    dev = db.query(Device).filter(Device.id == body.device_id).first()
    if dev is None:
        raise HTTPException(status_code=404, detail="device not found")

    # Block creating a duplicate open appeal for the same device.
    existing = (
        db.query(Appeal)
          .filter(Appeal.device_id == body.device_id)
          .filter(Appeal.status.in_(["open", "under_review"]))
          .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail={"code": "appeal_already_open", "id": existing.id},
        )

    appeal = Appeal(
        device_id=body.device_id,
        user_id=body.user_id,
        status="open",
        claim_text=body.claim_text,
        original_signals=list(dev.spam_signals or []),
        original_spam_score=float(dev.spam_score or 0.0),
    )
    db.add(appeal)
    db.flush()
    _emit(db, appeal.id, event_kind="opened",
          actor_admin_id=getattr(admin_user, "id", None),
          payload={"device_id": body.device_id})
    db.commit()
    db.refresh(appeal)
    return appeal


@router.get("", response_model=list[AppealOut])
def list_appeals(
    status: Optional[str] = Query(
        None,
        pattern="^(open|under_review|reinstated|upheld|banned)$",
    ),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    """List appeals, optionally filtered by status. Newest first."""
    q = db.query(Appeal)
    if status:
        q = q.filter(Appeal.status == status)
    rows = q.order_by(Appeal.opened_at.desc()).limit(limit).all()
    return rows


@router.get("/{appeal_id}")
def get_appeal(
    appeal_id: str,
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    """Read one appeal + its full event timeline."""
    appeal = db.query(Appeal).filter(Appeal.id == appeal_id).first()
    if appeal is None:
        raise HTTPException(status_code=404, detail="appeal not found")
    events = (
        db.query(AppealEvent)
          .filter(AppealEvent.appeal_id == appeal_id)
          .order_by(AppealEvent.occurred_at.desc())
          .all()
    )
    return {
        "appeal": AppealOut.model_validate(appeal, from_attributes=True),
        "events": [
            {
                "id": e.id,
                "event_kind": e.event_kind,
                "actor_admin_id": e.actor_admin_id,
                "payload": e.payload,
                "occurred_at": _utc_iso(e.occurred_at),
            }
            for e in events
        ],
    }


@router.post("/{appeal_id}/decide", response_model=AppealOut)
def decide_appeal(
    appeal_id: str,
    body: DecideAppealIn = Body(...),
    db: Session = Depends(get_db),
    admin_user = Depends(require_admin),
):
    """Decide an open appeal. 'reinstated' clears the device's
    spam_score + spam_signals; 'upheld' / 'banned' leave them
    intact (and per docs §7.5, 'banned' should require 2-admin
    co-sign — that policy is enforced UI-side in this commit;
    the API accepts the decision either way for the framework
    sketch)."""
    appeal = db.query(Appeal).filter(Appeal.id == appeal_id).first()
    if appeal is None:
        raise HTTPException(status_code=404, detail="appeal not found")
    if appeal.status not in ("open", "under_review"):
        raise HTTPException(
            status_code=409,
            detail={"code": "appeal_not_open", "current_status": appeal.status},
        )

    prior_status = appeal.status
    appeal.status = body.decision
    appeal.decided_at = datetime.now(timezone.utc)
    appeal.decided_by_admin_id = getattr(admin_user, "id", None)
    appeal.decision_notes = body.notes

    # Side-effect: reinstated decisions clear the device's trust state.
    if body.decision == "reinstated" and appeal.device_id:
        dev = db.query(Device).filter(Device.id == appeal.device_id).first()
        if dev is not None:
            dev.spam_score = 0.0
            dev.spam_signals = []

    _emit(db, appeal.id, event_kind="status_change",
          actor_admin_id=getattr(admin_user, "id", None),
          payload={"from": prior_status, "to": body.decision,
                   "notes": body.notes or ""})

    # Phase 5 (docs §6.4) — outbound webhook to deployment partners.
    # CRISP hosts the framework; UNDP / partners integrate via these
    # webhooks. Best-effort delivery — failure does not block the
    # decision. The `webhook_sent` event is also logged so admins
    # can see what was dispatched.
    try:
        from app.services.fraud_batch import emit_webhook
        emit_webhook({
            "type": "appeal.decided",
            "appeal_id": appeal.id,
            "device_id": appeal.device_id,
            "from_status": prior_status,
            "to_status": body.decision,
            "actor_admin_id": getattr(admin_user, "id", None),
            "decided_at": datetime.now(timezone.utc).isoformat(),
        })
        _emit(db, appeal.id, event_kind="webhook_sent",
              payload={"to_status": body.decision})
    except Exception:                              # pragma: no cover
        # Webhook delivery failures must NEVER fail the decision API.
        pass

    db.commit()
    db.refresh(appeal)
    return appeal
