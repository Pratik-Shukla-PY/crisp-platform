"""Building RISK score — ONE consolidated, transparent, act-first metric for a building.

Fuses how-BAD (severity / damage) with how-SURE (the aggregated per-incident credibility)
plus corroboration, evidence and recency into a single 0-100 score, expressed as additive
weighted FACTORS — the SAME shape as `compute_incident_credibility` (each factor is
`{key,label,max,ran,awarded,reason}`), so the breakdown decomposes every contribution and
nothing is a black box. The constituent incidents are the key inputs (their confidence →
factor 2, their severity → factor 1 + the weighting). HIGH score = URGENT (the band colours
invert vs the incident Confidence Score, where high = good). No extra Claude calls — it
operates on already-assessed incident data the building-assess endpoint gathered.

  Factor weights (sum 100):
    Severity & damage          30   worst severity + max damage (the "how bad")
    Incident assessments       25   severity-weighted mean of incident confidence (how sure)
    Corroboration & volume     20   independent incidents + reports + source channels
    Evidence verification      15   satellite coverage + photo evidence across the building
    Recency & escalation       10   freshness (time-decay) + last-24h report velocity
"""
from __future__ import annotations

from datetime import datetime, timezone
from math import exp
from typing import Optional

_MAX_SEV = 30
_MAX_INC = 25
_MAX_CORRO = 20
_MAX_EVID = 15
_MAX_RECENCY = 10

_SEVERITY_RANK = {"CRITICAL": 5, "SEVERE": 4, "MODERATE": 3, "MINOR": 2, "UNKNOWN": 1}
_DAMAGE_RANK = {"COMPLETE": 3, "PARTIAL": 2, "MINIMAL": 1}
_SEV_ORDER = ["CRITICAL", "SEVERE", "MODERATE", "MINOR", "UNKNOWN"]

# Risk bands — HIGH = urgent (inverted vs the incident confidence bands).
_BAND_CRITICAL = 80
_BAND_HIGH = 60
_BAND_MODERATE = 40
_BAND_LOW = 20


def risk_band(score: Optional[int]) -> str:
    if score is None:
        return "UNASSESSED"
    if score >= _BAND_CRITICAL:
        return "CRITICAL"
    if score >= _BAND_HIGH:
        return "HIGH"
    if score >= _BAND_MODERATE:
        return "MODERATE"
    if score >= _BAND_LOW:
        return "LOW"
    return "MINIMAL"


def risk_recommendation(band: str, worst_severity: str, assessed: bool) -> str:
    """Plain-rules next action (<=40 chars). Credibility-aware: never 'dispatch' on an
    unassessed building, never hide a severe-but-unconfirmed one."""
    severe = worst_severity in ("CRITICAL", "SEVERE")
    if not assessed:
        return "Verify before acting" if severe else "Monitor"
    if band in ("CRITICAL", "HIGH") and severe:
        return "Dispatch responders"
    if band in ("CRITICAL", "HIGH"):
        return "Coordinate response"
    if band == "MODERATE":
        return "Verify before acting"
    return "Monitor"


def _factor(key: str, label: str, max_pts: int, ran: bool, awarded: float, reason: str) -> dict:
    return {"key": key, "label": label, "max": max_pts, "ran": bool(ran),
            "awarded": int(round(awarded)) if ran else 0, "reason": reason}


def compute_building_risk(*, incidents: Optional[list] = None, report_count: int = 0,
                          damage_class_max: Optional[str] = None, source_count: int = 0,
                          reports_24h: int = 0, now: Optional[datetime] = None) -> dict:
    """`incidents` = list of dicts per constituent incident with: severity, score (incident
    confidence 0-100 or None), satellite_score (0-100 or None), media_count, age_hours.
    Returns {score, band, assessed, factors[5], coverage, recommendation, reasons}."""
    now = now or datetime.now(timezone.utc)
    incidents = incidents or []
    n_inc = len(incidents)
    factors = []

    def _sev(i):
        return (i.get("severity") or "UNKNOWN")

    # ── Factor 1: Severity & damage (always computable from metadata) ───────────
    sev_rank = max((_SEVERITY_RANK.get(_sev(i), 1) for i in incidents), default=1)
    worst_sev = next((s for s in _SEV_ORDER if any(_sev(i) == s for i in incidents)), "UNKNOWN")
    dmg_rank = _DAMAGE_RANK.get((damage_class_max or "").upper(), 0)
    sev_award = _MAX_SEV * (0.7 * sev_rank / 5 + 0.3 * dmg_rank / 3)
    factors.append(_factor("severity", "Severity & damage", _MAX_SEV, True, sev_award,
        f"Worst severity {worst_sev}"
        + (f", max damage {str(damage_class_max).replace('_', ' ')}" if dmg_rank else "")
        + f" across {n_inc} incident(s)."))

    # ── Factor 2: Incident assessments (severity-weighted mean credibility) ──────
    scored = [(i["score"], max(1, _SEVERITY_RANK.get(_sev(i), 1)))
              for i in incidents if i.get("score") is not None]
    n_assessed = len(scored)
    if scored:
        wsum = sum(s * w for s, w in scored)
        wtot = sum(w for _, w in scored)
        wmean = (wsum / wtot) if wtot else 0
        factors.append(_factor("incidents", "Incident assessments", _MAX_INC, True,
            _MAX_INC * wmean / 100,
            f"Severity-weighted mean incident confidence {int(round(wmean))}/100 "
            f"across {n_assessed} assessed incident(s)."))
    else:
        factors.append(_factor("incidents", "Incident assessments", _MAX_INC, False, 0,
            "Not yet assessed — run the assessment to fold the per-incident confidence scores in."))

    # ── Factor 3: Corroboration & volume ────────────────────────────────────────
    vol = (0.5 * min(n_inc, 5) / 5 + 0.3 * min(report_count, 10) / 10
           + 0.2 * min(source_count, 4) / 4)
    factors.append(_factor("corroboration", "Corroboration & volume", _MAX_CORRO, True,
        _MAX_CORRO * vol,
        f"{n_inc} incident(s) · {report_count} report(s) · {source_count} independent "
        f"source channel(s) corroborate this building."))

    # ── Factor 4: Evidence verification (satellite + photo coverage) ────────────
    sats = [i.get("satellite_score") for i in incidents if i.get("satellite_score") is not None]
    sat_cov = (len(sats) / n_inc) if n_inc else 0
    sat_mean = (sum(sats) / len(sats)) if sats else 0
    media_cov = (sum(1 for i in incidents if (i.get("media_count") or 0) > 0) / n_inc) if n_inc else 0
    evid = 0.6 * (sat_mean / 100) * sat_cov + 0.4 * media_cov
    factors.append(_factor("evidence", "Evidence verification", _MAX_EVID,
        bool(sats) or media_cov > 0, _MAX_EVID * evid,
        (f"{len(sats)} of {n_inc} incident(s) satellite-verified (mean {int(round(sat_mean))}/100); "
         if sats else "No satellite verdicts yet; ")
        + f"{int(round(media_cov * 100))}% carry photo evidence."))

    # ── Factor 5: Recency & escalation ──────────────────────────────────────────
    ages = [i.get("age_hours") for i in incidents if isinstance(i.get("age_hours"), (int, float))]
    newest = min(ages) if ages else None
    fresh = exp(-max(0.0, newest) / 48.0) if newest is not None else 0
    burst = min(1.0, (reports_24h or 0) / 6.0)
    factors.append(_factor("recency", "Recency & escalation", _MAX_RECENCY, bool(ages),
        _MAX_RECENCY * (0.7 * fresh + 0.3 * burst),
        (f"Latest report {int(round(newest))}h ago; " if newest is not None else "No timestamps; ")
        + f"{reports_24h or 0} report(s) in the last 24h."))

    score = int(max(0, min(100, sum(f["awarded"] for f in factors))))
    band = risk_band(score)
    assessed = n_assessed > 0
    reasons = [f"{f['label']} +{f['awarded']}" for f in factors if f["ran"] and f["awarded"] > 0][:3]
    return {
        "score": score, "band": band, "assessed": assessed, "max_score": 100,
        "factors": factors, "coverage": {"assessed": n_assessed, "total": n_inc},
        "recommendation": risk_recommendation(band, worst_sev, assessed),
        "reasons": reasons,
    }
