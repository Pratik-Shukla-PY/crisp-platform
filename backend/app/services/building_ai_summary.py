"""AI building summary — Phase H.6.

Claude-Haiku generates an operator-facing brief for a Building based on
its joined view of constituent reports + responder activity + operator
notes + recent timeline. The output is cached on `Building.ai_summary`
+ `Building.ai_summary_at` so subsequent console reads don't re-pay
the Claude round-trip.

Output JSON shape (matches the existing AISummaryPayload schema):

  {
    "summary": str,                     # 2-3 sentence brief
    "key_findings": [str, ...],         # 3-6 bullets
    "conflicting_signals": [str, ...],  # may be empty
    "responder_recommendation": str,
    "model": str,
    "generated_at": ISO 8601 UTC
  }

When ANTHROPIC_API_KEY is missing or the call times out / fails to
parse the service raises a SummaryUnavailable exception with the
reason. The endpoint surfaces that as a 503 — the cache stays
unmodified so the next call retries cleanly.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models.report import (
    Building,
    BuildingEvent,
    BuildingNote,
    BuildingResponder,
    Report,
)

logger = logging.getLogger(__name__)

# Match the existing classify-suggest pattern: small + cheap model.
_ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL_BUILDING_SUMMARY", "claude-haiku-4-5-20251001")
_TIMEOUT_SECONDS = 25  # PDF / GeoJSON exports are synchronous too; same budget
_MAX_TOKENS = 800


class SummaryUnavailable(Exception):
    """Raised when an AI summary cannot be produced (no key, timeout,
    parse failure, out-of-shape response). Endpoint maps to 503."""


def is_configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


async def generate_building_summary(db: Session, b: Building) -> dict:
    """Produce a fresh AI summary for the building.

    Synchronous DB queries; async Claude call. Returns the cache-shaped
    dict on success, raises SummaryUnavailable on any failure path.
    Caller is responsible for persisting + emitting BuildingEvent.
    """
    if not is_configured():
        raise SummaryUnavailable("ANTHROPIC_API_KEY not configured")

    # Snapshot the building's joined view. Bounded queries — at most
    # ~50 reports, ~20 events, ~10 notes for a typical building.
    reports = (
        db.query(Report)
        .filter(
            Report.building_id == b.id,
            Report.deletion_requested_at.is_(None),
        )
        .order_by(desc(Report.server_created_at))
        .limit(50)
        .all()
    )
    responders = (
        db.query(BuildingResponder)
        .filter(BuildingResponder.building_id == b.id)
        .order_by(desc(BuildingResponder.assigned_at))
        .limit(15)
        .all()
    )
    notes = (
        db.query(BuildingNote)
        .filter(
            BuildingNote.building_id == b.id,
            BuildingNote.deleted_at.is_(None),
        )
        .order_by(desc(BuildingNote.pinned), desc(BuildingNote.created_at))
        .limit(10)
        .all()
    )
    events = (
        db.query(BuildingEvent)
        .filter(BuildingEvent.building_id == b.id)
        .order_by(desc(BuildingEvent.occurred_at))
        .limit(20)
        .all()
    )

    prompt = _compose_prompt(b, reports, responders, notes, events)

    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    except ImportError as e:
        raise SummaryUnavailable(f"anthropic SDK not installed: {e}")

    try:
        response = await asyncio.wait_for(
            client.messages.create(
                model=_ANTHROPIC_MODEL,
                max_tokens=_MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
                system=_SYSTEM_PROMPT,
            ),
            timeout=_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise SummaryUnavailable("Claude call timed out")
    except Exception as e:
        # SDK auth errors / network / rate-limit all funnel here.
        raise SummaryUnavailable(f"Claude call failed: {type(e).__name__}: {e}")

    raw = "".join(b.text for b in response.content if hasattr(b, "text"))
    parsed = _parse_json(raw)
    if not parsed:
        raise SummaryUnavailable(f"Could not parse JSON from Claude response (got {len(raw)}b)")

    # Coerce shape — be tolerant about missing keys, strict about types.
    summary = (parsed.get("summary") or "").strip()
    if not summary:
        raise SummaryUnavailable("Claude response missing 'summary' field")

    return {
        "summary": summary[:2000],
        "key_findings": _coerce_str_list(parsed.get("key_findings"), max_items=8, max_len=200),
        "conflicting_signals": _coerce_str_list(parsed.get("conflicting_signals"), max_items=6, max_len=200),
        "responder_recommendation": (parsed.get("responder_recommendation") or "").strip()[:600],
        "model": _ANTHROPIC_MODEL,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── Prompt construction ──────────────────────────────────────────────
_SYSTEM_PROMPT = """You are a humanitarian operations analyst writing
operator-facing briefs for a crisis-response dashboard. Your job: take
the joined view of one building (constituent crisis reports, responder
activity, operator notes, recent events) and produce a tight,
evidence-grounded JSON summary.

Rules:
  - Output VALID JSON only. No markdown fences, no prose around it.
  - Keys: summary, key_findings, conflicting_signals,
    responder_recommendation. All required.
  - `summary` — 2-3 short sentences. State current situation, severity
    posture, what's been done. Cite specifics (counts, times,
    responder presence) — not vibes.
  - `key_findings` — 3-6 short bullet strings. Each is a single
    factual observation an operator can act on.
  - `conflicting_signals` — array of strings (may be empty). Note when
    different reports disagree on severity / damage class / crisis
    type, or when a responder reported "on-site" but a fresh report
    contradicts it.
  - `responder_recommendation` — one short paragraph. What kind of
    responder type / count is needed next, or "stand down" if signals
    suggest resolution.
  - Operator-friendly tone. No filler, no apologies, no "as an AI".
  - Never invent data. If reports are sparse, say so."""


def _compose_prompt(
    b: Building,
    reports: List[Report],
    responders: List[BuildingResponder],
    notes: List[BuildingNote],
    events: List[BuildingEvent],
) -> str:
    """Pack the building's joined view into a single user message."""
    lines: List[str] = []
    lines.append("# Building snapshot")
    lines.append(f"id: {b.id}")
    lines.append(f"name: {b.osm_name or '(no OSM name)'}")
    lines.append(f"state: {b.state}")
    lines.append(f"first_report_at: {b.first_report_at}")
    lines.append(f"latest_report_at: {b.latest_report_at}")
    if b.state_changed_at:
        lines.append(f"state_changed_at: {b.state_changed_at}")
    lines.append("")
    lines.append("# Intelligence scores (0-100)")
    lines.append(f"severity: {b.severity_score}")
    lines.append(f"confidence: {b.confidence_score}")
    lines.append(f"activity: {b.activity_score}")
    lines.append(f"escalation_risk: {b.escalation_risk}")
    lines.append(f"humanitarian_priority: {b.humanitarian_priority}")
    lines.append("")
    lines.append("# Roll-ups")
    lines.append(f"report_count: {b.report_count}")
    lines.append(f"verified_report_count: {b.verified_report_count}")
    lines.append(f"responding_report_count: {b.responding_report_count}")
    lines.append(f"resolved_report_count: {b.resolved_report_count}")
    lines.append(f"debris_clearing_needed_count: {b.debris_clearing_needed_count}")
    lines.append(f"severity_max: {b.severity_max}")
    lines.append(f"damage_class_max: {b.damage_class_max}")
    lines.append(f"crisis_types_top3: {b.crisis_types_top3 or []}")

    lines.append("")
    lines.append(f"# Recent reports (up to {len(reports)}, newest-first)")
    for r in reports[:30]:
        bits = [
            f"id={r.id[:8]}",
            f"source={r.source}",
            f"severity={r.severity}",
            f"damage={r.damage_classification}",
            f"crisis={r.crisis_type}",
            f"received={r.server_created_at}",
        ]
        if r.help_dispatched_at:
            bits.append(f"dispatched={r.help_dispatched_at}")
        if r.help_arrived_at:
            bits.append(f"on_site={r.help_arrived_at}")
        if r.reviewer_verdict:
            bits.append(f"verdict={r.reviewer_verdict}")
        if r.debris_clearing_needed:
            bits.append("debris=yes")
        lines.append("- " + " | ".join(bits))
        if r.description:
            # Cap each description preview to 300 chars to keep total
            # token cost bounded under bursts.
            preview = r.description.strip().replace("\n", " ")[:300]
            lines.append(f"  desc: {preview}")

    lines.append("")
    lines.append(f"# Responder roster (up to {len(responders)})")
    if responders:
        for r in responders:
            phase = (
                "CLEARED" if r.cleared_at
                else "ON_SITE" if r.arrived_at
                else "DISPATCHED" if r.dispatched_at
                else "ASSIGNED"
            )
            bits = [
                f"name={r.responder_name}",
                f"phase={phase}",
                f"assigned={r.assigned_at}",
            ]
            if r.responder_org:    bits.append(f"org={r.responder_org}")
            if r.eta_minutes:      bits.append(f"eta={r.eta_minutes}m")
            if r.dispatched_at:    bits.append(f"dispatched={r.dispatched_at}")
            if r.arrived_at:       bits.append(f"on_site={r.arrived_at}")
            if r.cleared_at:       bits.append(f"cleared={r.cleared_at}")
            lines.append("- " + " | ".join(bits))
            if r.notes:
                lines.append(f"  note: {r.notes.strip()[:200]}")
    else:
        lines.append("(no responders)")

    lines.append("")
    lines.append(f"# Operator notes (newest-first, pinned first, up to {len(notes)})")
    if notes:
        for n in notes:
            tag = "[PINNED] " if n.pinned else ""
            if n.visibility == "ADMIN_ONLY":
                tag += "[ADMIN] "
            lines.append(f"- {tag}{n.created_at}")
            lines.append(f"  {n.body.strip()[:600]}")
    else:
        lines.append("(no operator notes)")

    lines.append("")
    lines.append(f"# Recent events (last {len(events)})")
    if events:
        for e in events:
            payload_brief = ""
            if e.payload:
                kv = []
                for k, v in (e.payload or {}).items():
                    kv.append(f"{k}={str(v)[:40]}")
                payload_brief = " " + " ".join(kv)
            lines.append(f"- {e.occurred_at} {e.event_kind}{payload_brief}")
    else:
        lines.append("(no events)")

    lines.append("")
    lines.append(
        "Produce the JSON summary now. Output JSON only — no explanation, "
        "no markdown code fence, no prefix."
    )
    return "\n".join(lines)


# ─── Helpers ──────────────────────────────────────────────────────────
def _parse_json(raw: str) -> Optional[dict]:
    """Tolerant JSON extractor — strips ```json fences, looks for the
    first top-level { … }. Defensive: Claude occasionally returns the
    JSON wrapped in markdown even when told not to."""
    if not raw:
        return None
    # Strip ```json … ``` fences.
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S)
    if m:
        raw = m.group(1)
    else:
        # Find the first { and its matching close.
        idx = raw.find("{")
        if idx == -1:
            return None
        raw = raw[idx:]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Try a tail-trim — sometimes there's a trailing prose paragraph.
        last = raw.rfind("}")
        if last > 0:
            try:
                return json.loads(raw[: last + 1])
            except json.JSONDecodeError:
                return None
        return None


def _coerce_str_list(val, max_items: int, max_len: int) -> List[str]:
    if not isinstance(val, list):
        return []
    out: List[str] = []
    for v in val[:max_items]:
        if isinstance(v, str):
            s = v.strip()
            if s:
                out.append(s[:max_len])
    return out
