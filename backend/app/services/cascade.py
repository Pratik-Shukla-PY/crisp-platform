"""Set-based, scoped, reversible cascade engine — the Command Center action layer.

In a crisis with 10,000+ simultaneous incidents an admin never triages row-by-row;
they act on a SLICE (Global / Operation / Building, optionally filtered to a queue)
and it must PERCOLATE to every incident + report in scope. This engine does that in
ONE transaction with a handful of `UPDATE … WHERE … RETURNING` statements — O(1)
queries regardless of crisis size (must-have #12), never a per-row Python loop. It
generalises the proven set-based pattern from `operations/launch`
(`crisis_forms.py` `.update(..., synchronize_session=False)`), applying the report
status state machine (`_REPORT_STATUS_TRANSITIONS`) as part of the WHERE so illegal
rows are simply excluded. Every cascade writes ONE `CascadeActionLog` row (with a
bounded id snapshot) so it is auditable and reversible (Undo).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update, select, func, or_
from sqlalchemy.orm import Session

from app.models.report import (
    Report, Incident, Building, BuildingResponder, CascadeActionLog,
    ReportStatusEnum, SeverityEnum,
)

logger = logging.getLogger(__name__)

# Above this many changed rows we don't snapshot ids on the audit row (Undo falls
# back to a scope-based reverse). Keeps the JSON column bounded at extreme scale.
_SNAPSHOT_CAP = 20000
# Max responders alerted INLINE per cascade — closes the unbounded notify-responders
# fan-out. (A future async worker can drain overflow; the status change is the truth.)
_NOTIFY_CAP = 500
# Postgres bind-param ceiling guard for IN() lists.
_IN_CHUNK = 5000

S = ReportStatusEnum

# action → set-based spec. `report_from` = the legal source statuses (the state
# machine as a WHERE); `*_to` = the target. reject is verdict-based (status untouched,
# mirrors the building cascade). reopen reverses + clears the dispatch timestamps.
_ACTIONS = {
    "dispatch": dict(report_to=S.RESPONDING, report_from=(S.PENDING, S.VERIFIED),
                     incident_to="RESPONDING", incident_from=("OPEN",),
                     bld_to="RESPONDING", needs_reason=False, notify=True),
    "resolve": dict(report_to=S.RESOLVED, report_from=(S.PENDING, S.VERIFIED, S.RESPONDING),
                    incident_to="RESOLVED", incident_from=("OPEN", "RESPONDING"),
                    bld_to="RESOLVED", needs_reason=False, notify=False),
    "false_alarm": dict(report_to=S.FALSE_ALARM, report_from=(S.PENDING, S.VERIFIED, S.RESPONDING),
                        incident_to="FALSE_ALARM", incident_from=("OPEN", "RESPONDING"),
                        bld_to="FALSE_ALARM", needs_reason=True, notify=False),
    "reject": dict(verdict=True, needs_reason=True, notify=False),
    "reopen": dict(report_to=S.PENDING, report_from=(S.RESPONDING, S.RESOLVED, S.FALSE_ALARM),
                   incident_to="OPEN", incident_from=("RESPONDING", "RESOLVED", "FALSE_ALARM"),
                   bld_to="ACTIVE", clear_dispatch=True, needs_reason=False, notify=False),
}


class CascadeError(ValueError):
    """Bad request to the cascade engine (unknown action, missing scope/reason)."""


def _coerce_enum(enum_cls, value, label):
    """Accept an enum member OR its string value; reject anything else (the columns
    are Postgres enums, so a raw bad string would otherwise 500 at execute time)."""
    if isinstance(value, enum_cls):
        return value
    try:
        return enum_cls(str(value))
    except ValueError:
        raise CascadeError(f"invalid {label} filter value '{value}'")


def _active_conds():
    """A report that still counts as open (not closed, not rejected)."""
    return [Report.status.notin_([S.RESOLVED, S.FALSE_ALARM]),
            Report.reviewer_verdict != "REJECTED"]


def _queue_conds(queue: str):
    """The operator 'queue' slice predicates (mirror analytics.py / app.js QUEUES)."""
    q = (queue or "").strip().lower().replace("-", "_")
    if q == "critical":
        return [Report.severity == SeverityEnum.CRITICAL, *_active_conds()]
    if q in ("unattended_critical", "unattended"):
        return [Report.severity == SeverityEnum.CRITICAL,
                Report.status == S.PENDING, Report.help_dispatched_at.is_(None)]
    if q == "needs_response":
        return [Report.reviewer_verdict == "ACCEPTED", Report.help_dispatched_at.is_(None),
                Report.status != S.RESPONDING, *_active_conds()]
    if q == "needs_review":
        return [Report.reviewer_verdict != "ACCEPTED", Report.help_dispatched_at.is_(None),
                Report.status != S.RESPONDING, *_active_conds()]
    raise CascadeError(f"Unknown queue filter '{queue}'")


def _report_where(scope_type, scope_id, filters, valid_from):
    """Build the report slice WHERE for a scope (+ optional filters + the action's
    legal source statuses). Raises CascadeError for an unscoped global cascade."""
    conds = [Report.deletion_requested_at.is_(None)]
    filters = filters or {}
    if scope_type == "building":
        if not scope_id:
            raise CascadeError("building scope requires scope_id")
        conds.append(Report.building_id == scope_id)
    elif scope_type == "operation":
        if not scope_id:
            raise CascadeError("operation scope requires scope_id")
        conds.append(Report.crisis_event_id == scope_id)
    elif scope_type == "global":
        meaningful = any(filters.get(k) for k in
                         ("crisis_event_id", "building_id", "severity", "status", "verdict", "queue"))
        if not meaningful:
            raise CascadeError("a global cascade requires at least one filter "
                               "(queue/severity/status/verdict/crisis_event_id/building_id)")
    else:
        raise CascadeError(f"Unknown scope_type '{scope_type}'")

    if filters.get("crisis_event_id"):
        conds.append(Report.crisis_event_id == filters["crisis_event_id"])
    if filters.get("building_id"):
        conds.append(Report.building_id == filters["building_id"])
    if filters.get("severity"):
        sev = filters["severity"]
        sev = sev if isinstance(sev, (list, tuple)) else [sev]
        conds.append(Report.severity.in_([_coerce_enum(SeverityEnum, s, "severity") for s in sev]))
    if filters.get("status"):
        st = filters["status"]
        st = st if isinstance(st, (list, tuple)) else [st]
        conds.append(Report.status.in_([_coerce_enum(S, s, "status") for s in st]))
    if filters.get("verdict"):
        conds.append(Report.reviewer_verdict == filters["verdict"])
    if filters.get("queue"):
        conds.extend(_queue_conds(filters["queue"]))

    if valid_from is not None:
        conds.append(Report.status.in_(list(valid_from)))
    return conds


def _chunked(seq, n=_IN_CHUNK):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _in_chunked(col, values):
    """`col IN (values)` that stays under the Postgres bind-param ceiling by OR-ing
    chunks for very large id sets."""
    vals = list(values)
    if not vals:
        return None
    if len(vals) <= _IN_CHUNK:
        return col.in_(vals)
    return or_(*[col.in_(c) for c in _chunked(vals)])


def _touched(db: Session, rconds) -> tuple[set, set]:
    """Distinct building_ids + crisis_event_ids that the slice WOULD touch (for the
    dry-run counts; the execute path reads these from RETURNING instead)."""
    rows = db.execute(
        select(Report.building_id, Report.crisis_event_id).where(*rconds).distinct()
    ).fetchall()
    blds = {r[0] for r in rows if r[0]}
    ops = {r[1] for r in rows if r[1]}
    return blds, ops


def _incident_count_conds(scope_type, scope_id, blds, ops, incident_from):
    # Key incidents off the building set the changed reports actually touched (an
    # incident's crisis_event_id can be NULL if its reports were claimed into the op
    # AFTER intake) OR the operation id — robust across both. Chunk huge IN() lists.
    conds = [Incident.status.in_(list(incident_from))]
    if scope_type == "building":
        conds.append(Incident.building_id == scope_id)
        return conds
    ors = []
    if blds:
        ors.append(_in_chunked(Incident.building_id, blds))
    if ops:
        ors.append(_in_chunked(Incident.crisis_event_id, ops))
    if not ors:
        return None
    conds.append(or_(*[o for o in ors if o is not None]))
    return conds


def _building_conds(scope_type, scope_id, blds):
    conds = [Building.state != "ARCHIVED"]
    if scope_type == "building":
        conds.append(Building.id == scope_id)
        return conds
    if not blds:
        return None
    conds.append(_in_chunked(Building.id, blds))
    return conds


def _notify_scope_responders(db, scope_type, scope_id, blds, ops, body) -> int:
    """Best-effort, BOUNDED alert to the scope's assigned responders (never the
    reporters). Capped at _NOTIFY_CAP inline; a send failure never breaks the
    cascade (the status change already committed)."""
    try:
        cond = _responder_scope_cond(scope_type, scope_id, blds, ops)
        if cond is None:
            return 0
        rows = (db.query(BuildingResponder)
                .filter(BuildingResponder.cleared_at.is_(None), cond)
                .limit(_NOTIFY_CAP).all())
        if not rows:
            return 0
        from app.services.sms import send_sms, validate_e164
        from app.core.security import send_email
        sent = 0
        for r in rows:
            contact = (getattr(r, "responder_contact", "") or "").strip()
            if not contact:
                continue
            try:
                if "@" in contact:
                    if send_email(contact, "CRISP: response dispatched", body):
                        sent += 1
                elif any(c.isdigit() for c in contact):
                    send_sms(validate_e164(contact), body)
                    sent += 1
            except Exception:
                logger.exception("[cascade] notify failed for responder %s", getattr(r, "id", "?"))
        return sent
    except Exception:
        logger.exception("[cascade] responder notify pass failed; cascade is fine")
        return 0


def run_cascade(db: Session, user, *, scope_type: str, scope_id: Optional[str] = None,
                action: str, filters: Optional[dict] = None, reason: Optional[str] = None,
                dry_run: bool = False) -> dict:
    """Apply `action` to every report (+ its incidents + buildings) in the scope/slice
    in ONE set-based transaction. dry_run=True returns the blast-radius counts only."""
    action = (action or "").strip().lower().replace("-", "_")
    spec = _ACTIONS.get(action)
    if not spec:
        raise CascadeError(f"Unknown action '{action}'. Allowed: {sorted(_ACTIONS)}")
    reason = (str(reason).strip()[:500] if reason else None)
    if spec["needs_reason"] and not dry_run and not reason:
        raise CascadeError(f"reason is required for the '{action}' action")

    now = datetime.now(timezone.utc)
    uid = getattr(user, "id", None)

    # ── report slice WHERE ─────────────────────────────────────────────────────
    if spec.get("verdict"):   # reject
        rconds = _report_where(scope_type, scope_id, filters, valid_from=None)
        rconds.append(Report.reviewer_verdict != "REJECTED")
        rvalues = {"reviewer_verdict": "REJECTED", "reviewed_at": now}
        if reason:
            rvalues["action_taken"] = reason
    else:
        rconds = _report_where(scope_type, scope_id, filters, valid_from=spec["report_from"])
        rvalues = {"status": spec["report_to"]}
        if spec.get("clear_dispatch"):
            rvalues["help_dispatched_at"] = None
            rvalues["help_arrived_at"] = None

    # ── DRY RUN — counts only, no mutation ─────────────────────────────────────
    if dry_run:
        reports_n = int(db.query(func.count(Report.id)).filter(*rconds).scalar() or 0)
        inc_n = bld_n = resp_n = 0
        if reports_n:
            blds, ops = _touched(db, rconds)
            if spec.get("incident_to"):
                ic = _incident_count_conds(scope_type, scope_id, blds, ops, spec["incident_from"])
                if ic is not None:
                    inc_n = int(db.query(func.count(Incident.id)).filter(*ic).scalar() or 0)
            if spec.get("bld_to"):
                bc = _building_conds(scope_type, scope_id, blds)
                if bc is not None:
                    bld_n = int(db.query(func.count(Building.id)).filter(*bc).scalar() or 0)
            if spec.get("notify"):
                resp_n = min(_NOTIFY_CAP, _count_responders(db, scope_type, scope_id, blds, ops))
        return {"dry_run": True, "action": action,
                "counts": {"reports": reports_n, "incidents": inc_n,
                           "buildings": bld_n, "responders": resp_n}}

    # ── EXECUTE — set-based, one transaction ───────────────────────────────────
    changed = db.execute(
        update(Report).where(*rconds)
        .values(**rvalues)
        .returning(Report.id, Report.building_id, Report.crisis_event_id)
    ).fetchall()
    changed_ids = [r[0] for r in changed]
    blds = {r[1] for r in changed if r[1]}
    ops = {r[2] for r in changed if r[2]}
    reports_changed = len(changed_ids)

    incidents_changed = 0
    if reports_changed and spec.get("incident_to"):
        ic = _incident_count_conds(scope_type, scope_id, blds, ops, spec["incident_from"])
        if ic is not None:
            res = db.execute(update(Incident).where(*ic)
                             .values(status=spec["incident_to"], updated_at=now)
                             .returning(Incident.id)).fetchall()
            incidents_changed = len(res)

    buildings_changed = 0
    if reports_changed and spec.get("bld_to"):
        bc = _building_conds(scope_type, scope_id, blds)
        if bc is not None:
            res = db.execute(update(Building).where(*bc)
                             .values(state=spec["bld_to"], state_changed_at=now,
                                     state_changed_by_user_id=uid)
                             .returning(Building.id)).fetchall()
            buildings_changed = len(res)

    responders_notified = 0
    if reports_changed and spec.get("notify"):
        body = f"CRISP: response dispatched to {reports_changed} report(s). Coordinate per your assignment."
        responders_notified = _notify_scope_responders(db, scope_type, scope_id, blds, ops, body)

    log = CascadeActionLog(
        scope_type=scope_type, scope_id=scope_id, action=action,
        filters=filters or None, reason=reason,
        reports_changed=reports_changed, incidents_changed=incidents_changed,
        buildings_changed=buildings_changed, responders_notified=responders_notified,
        report_ids=(changed_ids if reports_changed <= _SNAPSHOT_CAP else None),
        actor_user_id=uid,
    )
    db.add(log)
    db.commit()
    logger.info("[cascade] %s scope=%s/%s reports=%d incidents=%d buildings=%d notified=%d",
                action, scope_type, scope_id, reports_changed, incidents_changed,
                buildings_changed, responders_notified)
    return {"dry_run": False, "action": action, "log_id": log.id, "reason": reason,
            "counts": {"reports": reports_changed, "incidents": incidents_changed,
                       "buildings": buildings_changed, "responders": responders_notified}}


def _responder_scope_cond(scope_type, scope_id, blds, ops):
    """Which assigned responders to alert: the building's, or (operation/global) the
    touched buildings' + operations' responders."""
    if scope_type == "building":
        return BuildingResponder.building_id == scope_id
    ors = []
    bc = _in_chunked(BuildingResponder.building_id, blds)
    oc = _in_chunked(BuildingResponder.crisis_event_id, ops)
    if bc is not None:
        ors.append(bc)
    if oc is not None:
        ors.append(oc)
    if not ors:
        return None
    return or_(*ors)


def _count_responders(db, scope_type, scope_id, blds, ops) -> int:
    cond = _responder_scope_cond(scope_type, scope_id, blds, ops)
    if cond is None:
        return 0
    return int(db.query(func.count(BuildingResponder.id))
               .filter(BuildingResponder.cleared_at.is_(None), cond).scalar() or 0)


def revert_cascade(db: Session, user, log_id: str) -> dict:
    """Undo a prior cascade precisely, using its report-id snapshot (set-based)."""
    log = db.query(CascadeActionLog).filter(CascadeActionLog.id == log_id).first()
    if not log:
        raise CascadeError("cascade not found")
    if log.reverted_at is not None:
        raise CascadeError("cascade already reverted")
    ids = log.report_ids or []
    if not ids:
        raise CascadeError("this cascade was too large to snapshot for a precise undo")

    now = datetime.now(timezone.utc)
    reverted = 0
    if log.action in ("dispatch", "resolve", "false_alarm"):
        for chunk in _chunked(ids):
            res = db.execute(
                update(Report)
                .where(Report.id.in_(chunk),
                       Report.status.in_([S.RESPONDING, S.RESOLVED, S.FALSE_ALARM]))
                .values(status=S.PENDING, help_dispatched_at=None, help_arrived_at=None)
                .returning(Report.id)).fetchall()
            reverted += len(res)
    elif log.action == "reject":
        for chunk in _chunked(ids):
            res = db.execute(
                update(Report)
                .where(Report.id.in_(chunk), Report.reviewer_verdict == "REJECTED")
                .values(reviewer_verdict="NOT_REVIEWED")
                .returning(Report.id)).fetchall()
            reverted += len(res)
    else:
        raise CascadeError(f"the '{log.action}' action is not auto-revertible")

    log.reverted_at = now
    db.add(CascadeActionLog(
        scope_type=log.scope_type, scope_id=log.scope_id, action="reopen",
        reason=f"revert of {log.id}", reports_changed=reverted,
        report_ids=ids if len(ids) <= _SNAPSHOT_CAP else None,
        actor_user_id=getattr(user, "id", None)))
    db.commit()
    return {"reverted": True, "reverted_of": log.id, "reports_reverted": reverted}
