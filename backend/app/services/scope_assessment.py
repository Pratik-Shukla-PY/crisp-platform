"""AI Analyze at OPERATION + GLOBAL scope — the Command Center decision layer.

Aggregate-then-synthesize (scale-safe to a 500k-report crisis): deterministic SQL
roll-ups of the already-computed child confidence scores (incident -> building ->
operation -> global) give the score/band/distribution/coverage; then ONE
claude-sonnet-4-6 call writes the situation summary, key risks, escalation
likelihood, recommended actions, priority score and resource recommendations. There
is exactly ONE Claude call per Analyze regardless of crisis size; the dossier is
bounded (top-N), and the recommended actions map to EXECUTABLE cascades so the
operator can act on a slice in one click. Mirrors the building_ai_summary pattern
(graceful 503 when ANTHROPIC_API_KEY is absent; tolerant JSON parse).
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, case, distinct
from sqlalchemy.orm import Session

from app.models.report import (
    Report, Building, Incident, CrisisEvent, BuildingResponder,
    ReportStatusEnum, SeverityEnum,
)
from app.services.building_ai_summary import (
    is_configured, _parse_json, _coerce_str_list, SummaryUnavailable,
)

logger = logging.getLogger(__name__)

_MODEL = os.getenv("ANTHROPIC_MODEL_SCOPE_ASSESS", "claude-sonnet-4-6")
_TIMEOUT_SECONDS = 30
_MAX_TOKENS = 1600
_TOP_N = 15

S = ReportStatusEnum
_CLOSED = [S.RESOLVED, S.FALSE_ALARM]
# Cascade actions/queues a recommended action may map to (validated post-parse).
_ALLOWED_ACTIONS = {"dispatch", "resolve", "reject"}
_ALLOWED_QUEUES = {"critical", "unattended_critical", "needs_response", "needs_review"}


def _band_for(score):
    if score is None:
        return "UNVERIFIED"
    if score >= 80:
        return "VERIFIED"
    if score >= 60:
        return "LIKELY"
    if score >= 40:
        return "MIXED"
    return "WEAK"


def _active_conds():
    return [Report.deletion_requested_at.is_(None),
            Report.status.notin_(_CLOSED), Report.reviewer_verdict != "REJECTED"]


def _op_building_ids_subq(db, op_id):
    return (db.query(distinct(Report.building_id))
            .filter(Report.crisis_event_id == op_id, Report.building_id.isnot(None))
            .subquery())


def aggregate_operation(db: Session, op_id: str) -> dict:
    """Deterministic roll-up for one operation (no Claude). Scale-safe grouped
    queries; building confidence is averaged over the op's assessed buildings."""
    base = [Report.crisis_event_id == op_id, Report.deletion_requested_at.is_(None)]
    total = int(db.query(func.count(Report.id)).filter(*base).scalar() or 0)
    critical = int(db.query(func.count(Report.id)).filter(
        *base, Report.severity == SeverityEnum.CRITICAL, Report.status.notin_(_CLOSED),
        Report.reviewer_verdict != "REJECTED").scalar() or 0)
    unattended = int(db.query(func.count(Report.id)).filter(
        *base, Report.severity == SeverityEnum.CRITICAL, Report.status == S.PENDING,
        Report.help_dispatched_at.is_(None)).scalar() or 0)
    incidents = int(db.query(func.count(Incident.id)).filter(
        Incident.crisis_event_id == op_id).scalar() or 0)
    responders = int(db.query(func.count(BuildingResponder.id)).filter(
        BuildingResponder.crisis_event_id == op_id,
        BuildingResponder.cleared_at.is_(None)).scalar() or 0)

    bsub = _op_building_ids_subq(db, op_id)
    n_buildings = int(db.query(func.count()).select_from(bsub).scalar() or 0)
    assessed = int(db.query(func.count(Building.id)).filter(
        Building.id.in_(db.query(bsub)), Building.building_confidence_score.isnot(None)).scalar() or 0)
    mean = db.query(func.avg(Building.building_confidence_score)).filter(
        Building.id.in_(db.query(bsub)), Building.building_confidence_score.isnot(None)).scalar()
    score = int(round(mean)) if mean is not None else None

    top = (db.query(Building)
           .filter(Building.id.in_(db.query(bsub)))
           .order_by(Building.humanitarian_priority.desc().nullslast())
           .limit(_TOP_N).all())
    return {
        "scope_type": "operation", "scope_id": op_id,
        "score": score, "band": _band_for(score),
        "distribution": _band_distribution(db, db.query(bsub)),
        "coverage": {"assessed": assessed, "total": n_buildings, "cached": assessed},
        "counts": {"reports": total, "incidents": incidents, "critical": critical,
                   "unattended_critical": unattended, "buildings": n_buildings,
                   "responders": responders},
        "top_buildings": [_bld_brief(b) for b in top],
    }


def aggregate_global(db: Session) -> dict:
    """Deterministic global roll-up (no Claude). Building confidence averaged over
    ALL assessed buildings; top operations by open-critical volume."""
    base = [Report.deletion_requested_at.is_(None)]
    total = int(db.query(func.count(Report.id)).filter(*base).scalar() or 0)
    critical = int(db.query(func.count(Report.id)).filter(
        *base, Report.severity == SeverityEnum.CRITICAL, Report.status.notin_(_CLOSED),
        Report.reviewer_verdict != "REJECTED").scalar() or 0)
    unattended = int(db.query(func.count(Report.id)).filter(
        *base, Report.severity == SeverityEnum.CRITICAL, Report.status == S.PENDING,
        Report.help_dispatched_at.is_(None)).scalar() or 0)
    incidents = int(db.query(func.count(Incident.id)).scalar() or 0)
    n_ops = int(db.query(func.count(CrisisEvent.id)).filter(
        CrisisEvent.is_active.is_(True)).scalar() or 0)
    n_buildings = int(db.query(func.count(Building.id)).scalar() or 0)
    assessed = int(db.query(func.count(Building.id)).filter(
        Building.building_confidence_score.isnot(None)).scalar() or 0)
    mean = db.query(func.avg(Building.building_confidence_score)).filter(
        Building.building_confidence_score.isnot(None)).scalar()
    score = int(round(mean)) if mean is not None else None

    # Top operations by open-critical volume (one grouped query + name join).
    crit_by_op = dict(db.query(Report.crisis_event_id, func.count(Report.id))
                      .filter(*base, Report.crisis_event_id.isnot(None),
                              Report.severity == SeverityEnum.CRITICAL,
                              Report.status.notin_(_CLOSED),
                              Report.reviewer_verdict != "REJECTED")
                      .group_by(Report.crisis_event_id)
                      .order_by(func.count(Report.id).desc()).limit(_TOP_N).all())
    ops = (db.query(CrisisEvent)
           .filter(CrisisEvent.id.in_(list(crit_by_op.keys()) or ["_none_"])).all()) if crit_by_op else []
    top_ops = sorted(
        [{"id": o.id, "name": o.name, "place": o.place_name,
          "crisis_type": o.crisis_type, "critical": int(crit_by_op.get(o.id, 0))} for o in ops],
        key=lambda x: -x["critical"])
    return {
        "scope_type": "global", "scope_id": None,
        "score": score, "band": _band_for(score),
        "distribution": _band_distribution(db, db.query(Building.id)),
        "coverage": {"assessed": assessed, "total": n_buildings, "cached": assessed},
        "counts": {"reports": total, "incidents": incidents, "critical": critical,
                   "unattended_critical": unattended, "operations": n_ops,
                   "buildings": n_buildings},
        "top_operations": top_ops,
    }


def _band_distribution(db, id_query) -> dict:
    """Count assessed buildings (in the given id set) by confidence band — one query
    with a CASE bucket, so it never materialises every building row."""
    sc = Building.building_confidence_score
    band = case(
        (sc >= 80, "VERIFIED"), (sc >= 60, "LIKELY"),
        (sc >= 40, "MIXED"), (sc.isnot(None), "WEAK"),
        else_="UNVERIFIED")
    rows = (db.query(band.label("b"), func.count(Building.id))
            .filter(Building.id.in_(id_query))
            .group_by(band).all())
    out = {"VERIFIED": 0, "LIKELY": 0, "MIXED": 0, "WEAK": 0, "UNVERIFIED": 0}
    for b, n in rows:
        out[b] = int(n)
    return out


def _bld_brief(b: Building) -> dict:
    return {"id": b.id, "name": b.osm_name or "(unnamed building)", "state": b.state,
            "confidence": b.building_confidence_score, "priority": b.humanitarian_priority,
            "severity": b.severity_max, "reports": b.report_count}


async def generate_scope_assessment(db: Session, scope_type: str,
                                    scope_id: Optional[str] = None) -> dict:
    """Aggregate the scope, then ONE Claude synthesis call. Raises SummaryUnavailable
    on any AI failure (the caller maps it to 503); the deterministic roll-up is always
    valid even if the narrative can't be produced."""
    agg = (aggregate_operation(db, scope_id) if scope_type == "operation"
           else aggregate_global(db))
    if not is_configured():
        raise SummaryUnavailable("ANTHROPIC_API_KEY not configured")
    prompt = _compose_prompt(scope_type, agg)
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    except ImportError as e:
        raise SummaryUnavailable(f"anthropic SDK not installed: {e}")
    try:
        resp = await asyncio.wait_for(client.messages.create(
            model=_MODEL, max_tokens=_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}], system=_SYSTEM_PROMPT),
            timeout=_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        raise SummaryUnavailable("Claude call timed out")
    except Exception as e:
        raise SummaryUnavailable(f"Claude call failed: {type(e).__name__}: {e}")

    raw = "".join(p.text for p in resp.content if hasattr(p, "text"))
    parsed = _parse_json(raw) or {}
    summary = (parsed.get("situation_summary") or "").strip()
    if not summary:
        raise SummaryUnavailable("Claude response missing 'situation_summary'")

    return _shape(agg, parsed, summary)


def _shape(agg: dict, parsed: dict, summary: str) -> dict:
    esc = parsed.get("escalation_likelihood")
    if isinstance(esc, str):
        esc = {"level": esc.strip().upper()[:20], "rationale": ""}
    elif isinstance(esc, dict):
        esc = {"level": str(esc.get("level", "")).upper()[:20],
               "rationale": str(esc.get("rationale", ""))[:400]}
    else:
        esc = {"level": "UNKNOWN", "rationale": ""}
    prio = parsed.get("priority_score")
    try:
        prio = max(0, min(100, int(round(float(prio)))))
    except (TypeError, ValueError):
        prio = agg["score"] if agg["score"] is not None else None
    return {
        **{k: agg[k] for k in ("scope_type", "scope_id", "score", "band",
                               "distribution", "coverage", "counts")},
        "situation_summary": summary[:2000],
        "key_risks": _coerce_str_list(parsed.get("key_risks"), max_items=6, max_len=240),
        "escalation_likelihood": esc,
        "recommended_actions": _shape_actions(parsed.get("recommended_actions"),
                                              agg["scope_type"], agg["scope_id"]),
        "priority_score": prio,
        "resource_recommendations": _coerce_str_list(
            parsed.get("resource_recommendations"), max_items=6, max_len=240),
        "model": _MODEL,
        "assessed_at": datetime.now(timezone.utc).isoformat(),
    }


def _shape_actions(val, scope_type, scope_id) -> list:
    """Each recommended action becomes an EXECUTABLE cascade {label, action, scope,
    filters}. Invalid/unknown actions are dropped (never fabricate a bad cascade)."""
    out = []
    if not isinstance(val, list):
        return out
    for item in val[:6]:
        if not isinstance(item, dict):
            continue
        action = str(item.get("action", "")).strip().lower().replace("-", "_")
        if action not in _ALLOWED_ACTIONS:
            continue
        label = str(item.get("label") or item.get("rationale") or action).strip()[:140]
        if not label:
            continue
        filters = {}
        queue = str(item.get("queue", "")).strip().lower().replace("-", "_")
        if queue in _ALLOWED_QUEUES:
            filters["queue"] = queue
        if scope_type == "operation":
            scope = {"scope_type": "operation", "scope_id": scope_id}
        else:
            scope = {"scope_type": "global"}
            if not filters:
                filters["queue"] = "critical"   # global cascades MUST be scoped
        out.append({"label": label, "action": action, "scope": scope, "filters": filters})
    return out


_NARRATIVE_KEYS = ("situation_summary", "key_risks", "escalation_likelihood",
                   "recommended_actions", "priority_score", "resource_recommendations",
                   "model")


def persist(db: Session, user, payload: dict):
    """Append the assessment to its history (the latest row is the cached card)."""
    from app.models.report import ScopeAssessment
    row = ScopeAssessment(
        scope_type=payload["scope_type"], scope_id=payload.get("scope_id"),
        score=payload.get("score"), band=payload.get("band"),
        distribution=payload.get("distribution"), coverage=payload.get("coverage"),
        situation_summary=payload.get("situation_summary"),
        key_risks=payload.get("key_risks"),
        escalation_likelihood=payload.get("escalation_likelihood"),
        recommended_actions=payload.get("recommended_actions"),
        priority_score=payload.get("priority_score"),
        resource_recommendations=payload.get("resource_recommendations"),
        model=payload.get("model"), actor_user_id=getattr(user, "id", None))
    db.add(row)
    db.commit()
    return row


def get_payload(db: Session, scope_type: str, scope_id: Optional[str] = None) -> dict:
    """Cached card: FRESH deterministic roll-up (live metrics) + the LAST Claude
    narrative (no new Claude call). `assessed=False` until the operator runs Analyze."""
    from app.models.report import ScopeAssessment
    agg = aggregate_operation(db, scope_id) if scope_type == "operation" else aggregate_global(db)
    base = {k: agg[k] for k in ("scope_type", "scope_id", "score", "band",
                                "distribution", "coverage", "counts")}
    q = db.query(ScopeAssessment).filter(ScopeAssessment.scope_type == scope_type)
    q = (q.filter(ScopeAssessment.scope_id == scope_id) if scope_id
         else q.filter(ScopeAssessment.scope_id.is_(None)))
    row = q.order_by(ScopeAssessment.created_at.desc()).first()
    if row:
        base.update({
            "assessed": True,
            "situation_summary": row.situation_summary, "key_risks": row.key_risks,
            "escalation_likelihood": row.escalation_likelihood,
            "recommended_actions": row.recommended_actions,
            "priority_score": row.priority_score,
            "resource_recommendations": row.resource_recommendations,
            "model": row.model,
            "assessed_at": row.created_at.isoformat() if row.created_at else None,
        })
    else:
        base.update({"assessed": False, "situation_summary": None, "key_risks": [],
                     "escalation_likelihood": None, "recommended_actions": [],
                     "priority_score": None, "resource_recommendations": [],
                     "model": None, "assessed_at": None})
    return base


_SYSTEM_PROMPT = """You are a humanitarian operations analyst writing an action-
oriented assessment for a crisis-response command center. You are given a
deterministic roll-up for ONE scope (an operation, or the whole global response).
Produce VALID JSON only (no markdown, no prose around it) with these keys:
  situation_summary       - 2-4 sentences: what is happening + how severe, citing
                            the actual counts. No filler, no "as an AI".
  key_risks               - 3-6 short strings (the concrete risks).
  escalation_likelihood   - {"level": one of LOW|MODERATE|HIGH, "rationale": short}.
  recommended_actions     - 1-4 objects, each an EXECUTABLE next step:
                              {"label": short imperative, "action": one of
                               dispatch|resolve|reject, "queue": one of
                               critical|unattended_critical|needs_response|needs_review}
                            Use 'dispatch' on unattended_critical/needs_response to
                            send help; 'resolve' only when a slice is clearly handled;
                            'reject' only for confirmed noise. The operator executes
                            these as ONE set-based cascade over that slice.
  priority_score          - integer 0-100 (how urgently this scope needs attention).
  resource_recommendations- 2-6 short strings (responder types / quantities / supplies).
Ground everything in the provided numbers. If coverage is low (few buildings
assessed), say the confidence is provisional. Never invent data."""


def _compose_prompt(scope_type: str, agg: dict) -> str:
    c = agg["counts"]
    cov = agg["coverage"]
    L = [f"# Scope: {scope_type.upper()}"]
    if scope_type == "operation":
        L.append(f"operation_id: {agg['scope_id']}")
    L.append("")
    L.append("# Roll-up (deterministic, ground truth)")
    L.append(f"confidence_score: {agg['score']} (band {agg['band']})")
    L.append(f"coverage: {cov['assessed']} of {cov['total']} buildings assessed")
    L.append(f"band_distribution: {agg['distribution']}")
    for k, v in c.items():
        L.append(f"{k}: {v}")
    L.append("")
    if scope_type == "operation":
        L.append(f"# Top buildings by humanitarian priority (up to {len(agg['top_buildings'])})")
        for b in agg["top_buildings"]:
            L.append(f"- {b['name']} | state={b['state']} | severity={b['severity']} "
                     f"| confidence={b['confidence']} | priority={b['priority']} | reports={b['reports']}")
    else:
        L.append(f"# Top operations by open-critical volume (up to {len(agg['top_operations'])})")
        for o in agg["top_operations"]:
            L.append(f"- {o['name']} ({o.get('place') or '?'}) | type={o['crisis_type']} "
                     f"| open_critical={o['critical']}")
    L.append("")
    L.append("Produce the JSON assessment now. Output JSON only.")
    return "\n".join(L)
