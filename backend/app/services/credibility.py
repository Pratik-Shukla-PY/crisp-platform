"""Incident Credibility Score - the single, system-only source of truth.

The dashboard's Incident Assessment shows ONE 0-100 Confidence Score for an
incident: "how confident is the SYSTEM that this report is real and actionable?"
It is the sum of independent automated checks, each contributing points up to a
fixed maximum, so the number is fully explainable and auditable (the dashboard's
"AI-Assisted Report Assessment" modal renders the per-check breakdown verbatim).

PURE MACHINE - the score is the system's automated assessment ONLY. Human actions
(an analyst's accept/reject verdict, a manual review) deliberately do NOT affect
it; the verdict is shown separately as the operational status, never folded in.

Computed at read time (never stored) by ``ReportResponse`` - pure, no DB/I/O, so
list and detail responses share one path with no N+1.

Methodology (points, max 100)
-----------------------------
  AI content analysis            ......  30   (photo / transcript / description / metadata, via Claude)
  Satellite imagery correlation  ......  25   (recent imagery vs the reported location + damage)
  Location & metadata            ......  15   (GPS fix / accuracy / geocoding confidence)
  Corroboration & duplicates     ......  15   (independent nearby reports raise confidence)
  Reporter credibility           ......  15   (the reporter's verified track record)

Each check returns ``{key, label, max, ran, awarded, reason}``. The score = sum of
``awarded`` across every check. It is SUPPRESSED (band UNVERIFIED, score=None) until
the operator runs the assessment (the on-demand AI + satellite checks) - the UI then
shows "Not yet assessed" and the single CTA, never a fabricated number.
"""

from typing import Any, Optional

# Reporter-tier -> verified track record (mirrors _get_reporter_credibility).
_TIER_BASE = {
    "T4_LIFEKEEPER": 95, "T3_CHANGEMAKER": 85, "T2_SIGNAL": 70,
    "T1_SCOUT": 55, "NEWCOMER": 50,
}

# Per-check maximum contributions (sum = 100). Tunable.
_MAX_AI = 30
_MAX_SAT = 25
_MAX_LOC = 15
_MAX_CORRO = 15
_MAX_REP = 15

# Band thresholds (applied to the additive 0-100 score).
_BAND_VERIFIED = 80
_BAND_LIKELY = 60
_BAND_MIXED = 40


def _num(v: Any) -> Optional[float]:
    """Coerce to a 0-100 number, or None if not a usable number."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f < 0:
        return 0.0
    if f > 100:
        return 100.0
    return f


def _band_for(score: int) -> str:
    if score >= _BAND_VERIFIED:
        return "VERIFIED"
    if score >= _BAND_LIKELY:
        return "LIKELY"
    if score >= _BAND_MIXED:
        return "MIXED"
    return "WEAK"


def _factor(key: str, label: str, max_pts: int, ran: bool, awarded: float, reason: str) -> dict:
    return {
        "key": key, "label": label, "max": max_pts, "ran": bool(ran),
        "awarded": int(round(awarded)) if ran else 0, "reason": reason,
    }


def compute_incident_credibility(
    *,
    ai_assessment: Optional[dict] = None,
    satellite_score: Any = None,
    satellite_error: Optional[str] = None,
    satellite_verdict: Optional[str] = None,
    satellite_scored_at: Any = None,
    reporter_tier: Optional[str] = None,
    duplicate_count: int = 0,
    location: Optional[dict] = None,
    location_mismatch: Optional[dict] = None,
) -> dict:
    """Sum the independent automated checks into one system-only Confidence Score.

    Returns a dict the dashboard renders directly + explains in the modal::

        {
          "score": int | None,          # None == UNVERIFIED (not yet assessed)
          "band": "VERIFIED|LIKELY|MIXED|WEAK|UNVERIFIED",
          "assessed": bool,             # has the operator run the assessment?
          "max_score": 100,
          "factors": [ {key,label,max,ran,awarded,reason}, ... ],
          "ran_count": int, "total_checks": int,
          "reasons": [str, ...],        # top contributors, for the headline caption
          "assessed_at": str | None,    # ISO-8601 of the latest automated check (satellite scored_at)
        }
    """
    # Server-authoritative "Last assessed" time (the satellite scoring stamp;
    # AI-only assessments carry no per-blob timestamp, so the dashboard falls
    # back to its own run-time cache there). Coerce datetime -> ISO-8601 Z.
    assessed_at = None
    if satellite_scored_at is not None:
        try:
            iso = satellite_scored_at.isoformat()  # datetime
            assessed_at = iso if iso.endswith("Z") or "+" in iso else iso + "Z"
        except AttributeError:
            assessed_at = str(satellite_scored_at) or None

    ai = ai_assessment if isinstance(ai_assessment, dict) else None
    ai_conf = _num(ai.get("confidence_score")) if ai else None
    sat = _num(satellite_score)
    sat_failed = bool(satellite_error)
    reporter = _TIER_BASE.get(reporter_tier) if reporter_tier else None
    dups = max(0, int(duplicate_count or 0))
    loc = location if isinstance(location, dict) else None

    factors = []

    # 1. AI content analysis (photo / transcript / description / metadata) — 30
    if ai_conf is not None:
        summ = ai.get("summary") or ai.get("reasoning") or "Report content assessed by the AI model."
        factors.append(_factor("ai", "AI content analysis", _MAX_AI, True, _MAX_AI * ai_conf / 100,
                                f"AI confidence {int(ai_conf)}/100 — {str(summ)[:140]}"))
    else:
        factors.append(_factor("ai", "AI content analysis", _MAX_AI, False, 0,
                                "Not run yet — analyses the photo, transcript, description and metadata."))

    # 2. Satellite imagery correlation — 25
    if sat_failed:
        factors.append(_factor("satellite", "Satellite imagery correlation", _MAX_SAT, False, 0,
                                f"Could not run: {satellite_error}"))
    elif sat is not None:
        vtxt = (str(satellite_verdict).replace("_", " ").lower() + " — ") if satellite_verdict else ""
        factors.append(_factor("satellite", "Satellite imagery correlation", _MAX_SAT, True, _MAX_SAT * sat / 100,
                                f"Satellite score {int(sat)}/100 — {vtxt}recent imagery cross-checked against the reported location and damage."))
    else:
        factors.append(_factor("satellite", "Satellite imagery correlation", _MAX_SAT, False, 0,
                                "Not run yet — compares recent satellite imagery with the reported scene."))

    # 3. Location & metadata verification — 15 (computable from the report itself)
    loc_pts, loc_reason = 0.0, "No location attached to the report."
    if loc:
        lat, lng = loc.get("latitude"), loc.get("longitude")
        acc = loc.get("accuracy_meters")
        gconf = loc.get("geocoding_confidence")
        if lat is not None and lng is not None:
            if isinstance(acc, (int, float)) and acc <= 50:
                loc_pts, loc_reason = _MAX_LOC, f"Precise GPS fix (±{int(acc)} m) at the reported coordinates."
            elif isinstance(acc, (int, float)) and acc <= 500:
                loc_pts, loc_reason = _MAX_LOC * 0.75, f"GPS fix present (±{int(acc)} m)."
            else:
                loc_pts, loc_reason = _MAX_LOC * 0.6, "GPS coordinates present on the report."
            if isinstance(gconf, (int, float)) and gconf < 0.5:
                loc_pts = min(loc_pts, _MAX_LOC * 0.5)
                loc_reason = f"Location inferred from text (confidence {int(gconf * 100)}%)."
        elif isinstance(gconf, (int, float)):
            loc_pts = _MAX_LOC * max(0.3, min(1.0, gconf))
            loc_reason = f"Location geocoded from text (confidence {int(gconf * 100)}%)."
    # A significant device-vs-submitted location mismatch is an ANALYST SIGNAL ONLY:
    # it appends a "verify on the map" note to the reason TEXT and NEVER changes
    # loc_pts. A reporter who corrects the pin (e.g. reporting from base camp about
    # damage elsewhere) must not be penalised - the analyst + the AI weigh it.
    if location_mismatch and location_mismatch.get("distance_km"):
        _d = location_mismatch["distance_km"]
        loc_reason = (loc_reason + f" [NOTE: reporter adjusted the pin {_d} km from "
                      "the device GPS - verify the location on the map.]")
    factors.append(_factor("location", "Location & metadata", _MAX_LOC, loc is not None, loc_pts, loc_reason))

    # 4. Corroboration & duplicate detection — 15
    if dups > 0:
        corro_pts = min(_MAX_CORRO, 6 + dups * 3)
        corro_reason = f"{dups} corroborating report(s) confirmed at this location — independent witnesses raise confidence."
    else:
        corro_pts = _MAX_CORRO * 0.4
        corro_reason = "No duplicate or corroborating reports found nearby."
    factors.append(_factor("corroboration", "Corroboration & duplicate detection", _MAX_CORRO, True, corro_pts, corro_reason))

    # 5. Reporter credibility — 15
    if reporter is not None:
        factors.append(_factor("reporter", "Reporter credibility", _MAX_REP, True, _MAX_REP * reporter / 100,
                                f"Reporter trust tier {reporter_tier} (track record {int(reporter)}/100)."))
    else:
        factors.append(_factor("reporter", "Reporter credibility", _MAX_REP, False, 0,
                                "No reporter history yet (anonymous or first report)."))

    # The score appears once the operator has run the on-demand assessment (the AI
    # and/or satellite checks). Before that it is honestly suppressed.
    assessed = (ai_conf is not None) or (sat is not None)
    ran_count = sum(1 for f in factors if f["ran"])
    if not assessed:
        return {
            "score": None, "band": "UNVERIFIED", "assessed": False, "max_score": 100,
            "factors": factors, "ran_count": ran_count, "total_checks": len(factors),
            "reasons": ["Not yet assessed"], "assessed_at": None,
        }

    score = max(0, min(100, sum(f["awarded"] for f in factors)))
    reasons = [f"{f['label']} +{f['awarded']}" for f in factors if f["ran"] and f["awarded"] > 0][:3]
    return {
        "score": score, "band": _band_for(score), "assessed": True, "max_score": 100,
        "factors": factors, "ran_count": ran_count, "total_checks": len(factors),
        "reasons": reasons, "assessed_at": assessed_at,
    }
