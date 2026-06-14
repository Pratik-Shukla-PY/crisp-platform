"""
CRISP Satellite Truth Scorer - powered by Claude Haiku (vision-capable)
──────────────────────────────────────────────────────────────
Sends two images + full report context to Claude (multi-modal):
  Image 1 - satellite top-down view of the reported GPS coordinates
  Image 2 - ground-level photo submitted by the citizen reporter
  Text    - description, audio transcription, claimed infra type / severity,
             temporal gap between satellite acquisition and report timestamp,

Uses prompt caching: the scoring rubric (~800 tokens) is sent as a cached
system prompt, saving ~90% on repeated verification calls.

Triggered by admin clicking "Verify via Satellite" on the dashboard.
Result stored in satellite_verifications table.
             satellite cloud cover, source metadata

Returns a structured JSON dict with:
  scores        - 4 component scores (0-25 each) summing to 0-100
  verdict       - STRONGLY_CORROBORATED | LIKELY_AUTHENTIC |
                  PARTIALLY_VERIFIED | LOW_CONFIDENCE | UNVERIFIED
  reasoning     - 2-3 sentence narrative
  key_findings  - bullet list of the most important observations
  caveats       - limitations that affect score reliability
  satellite_data - metadata echoed back for storage
"""
import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import anthropic

logger = logging.getLogger(__name__)

ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"  # fast, vision-capable, cost-efficient

# ── Scoring prompt ────────────────────────────────────────────────────────────
_PROMPT = """You are a satellite-assisted disaster verification analyst for the UN CRISP
(Community Rapid Infrastructure Sensing Platform). Your role is to independently verify
citizen incident reports by cross-referencing ground-level photos with satellite imagery.

You will receive:
  - A satellite image (top-down, ESA Sentinel-2 or Mapbox Maxar)
  - A ground-level photo submitted by the citizen reporter
  - Full report context: claimed infrastructure type, severity, description,
    audio transcription, GPS coordinates, and temporal metadata
  - (When present) COMMUNITY-CURATED GROUND TRUTH: structured answers the reporter
    gave to crisis-specific questions inside an admin-defined crisis event (e.g.
    "flames visible? yes", "water depth: knee-high"). These are deliberate,
    constrained answers - weigh them as corroborating evidence across components
    2, 3 and 4. They strengthen (or, if they contradict the photo/satellite,
    weaken) the assessment; they are NOT a substitute for visual confirmation.

Score the report across 4 components (25 pts each → total 100):

━━━ COMPONENT 1 - LOCATION AUTHENTICITY (0–25) ━━━
Does the satellite confirm the claimed infrastructure TYPE exists at these exact coordinates?
  25 - Satellite clearly shows the exact claimed infrastructure (hospital, road, power lines…)
  18 - Similar infrastructure visible but not an exact match
   8 - Ambiguous; hard to confirm from satellite resolution
   0 - Coordinates show empty land / water / dense vegetation - nothing matching the claim

━━━ COMPONENT 2 - DAMAGE CORROBORATION (0–25) ━━━
Does satellite evidence support claimed damage? Critically account for temporal gap.
  25 - Post-incident satellite clearly shows damage, collapse, fire scar, or flooding
  20 - Satellite within 24 h shows anomaly (dark patch, structural gap, water ingress)
  15 - Pre-incident satellite; damage type is physically plausible for this infrastructure
  10 - Satellite >2 weeks old - insufficient temporal data to verify
   5 - Pre-incident satellite shows no pre-existing vulnerability
   0 - Post-incident satellite shows NO damage, directly contradicting the report

━━━ COMPONENT 3 - DESCRIPTION COHERENCE (0–25) ━━━
Do the text description, audio transcription, and submitted photo mutually corroborate?
  25 - All three sources fully consistent and mutually reinforcing
  18 - Minor inconsistencies; same core incident described across sources
   8 - Notable contradictions between sources but same general area/event
   0 - Description or transcription directly contradicts what is visible in the photo

━━━ COMPONENT 4 - DATA QUALITY & CONFIDENCE (0–25) ━━━
How reliable is the input data? Sum sub-scores:
  Satellite recency:
    Same day as report = 12 pts | 1–7 days before = 9 pts
    8–30 days before   =  5 pts | >30 days / unknown = 2 pts
  Cloud cover on satellite:
    < 20 % = 8 pts | 20–50 % = 5 pts | > 50 % = 2 pts | Unknown = 4 pts
  User data completeness:
    Has GPS + photo + audio = 5 pts
    Has GPS + photo         = 3 pts
    Text / audio only       = 1 pt
  Community-curated ground truth (crisis-pack answers present):
    Present = +3 pts | Absent = 0 pts
  (Hard cap COMPONENT 4 at 25 - curated answers can lift a thin report toward
   the cap but never above it.)

Return ONLY valid JSON - no markdown fences, no prose outside the object:
{
  "scores": {
    "location_authenticity": <int 0-25>,
    "damage_corroboration":  <int 0-25>,
    "description_coherence": <int 0-25>,
    "data_quality":          <int 0-25>,
    "total":                 <int 0-100>
  },
  "verdict": "<STRONGLY_CORROBORATED|LIKELY_AUTHENTIC|PARTIALLY_VERIFIED|LOW_CONFIDENCE|UNVERIFIED>",
  "satellite_scene_description": "<1-2 sentences: what is visible in the satellite image>",
  "photo_analysis":              "<1-2 sentences: what is visible in the user photo>",
  "key_findings": [
    "<most important finding 1>",
    "<most important finding 2>",
    "<most important finding 3>"
  ],
  "caveats": [
    "<limitation 1>",
    "<limitation 2 if any>"
  ],
  "reasoning": "<2-3 sentence narrative explaining the overall score and verdict>"
}"""


def _format_curated_answers(form_data: Optional[dict]) -> str:
    """Render Report.form_data (curated crisis-pack answers) as human-readable
    'Label: value' lines for the credibility prompt. Returns '' when empty.

    Mirrors the dashboard's humanize logic (B3): snake_case → Title Case keys,
    booleans → Yes/No, lists → comma-joined. Skips null/empty answers so the
    model isn't fed noise.
    """
    if not form_data or not isinstance(form_data, dict):
        return ""
    lines = []
    for key, val in form_data.items():
        if val is None or val == "" or val == []:
            continue
        label = str(key).replace("_", " ").strip().title()
        if isinstance(val, bool):
            shown = "Yes" if val else "No"
        elif isinstance(val, (list, tuple)):
            shown = ", ".join(str(x).replace("_", " ").title() for x in val)
        elif isinstance(val, dict):
            shown = json.dumps(val, ensure_ascii=False)
        else:
            shown = str(val)
        lines.append(f"    {label}: {shown}")
    return "\n".join(lines)


class TruthScorer:
    """Multi-modal Claude scorer for CRISP satellite verification."""

    def __init__(self):
        self._api_key = os.getenv("ANTHROPIC_API_KEY", "")
        self._client: Optional[anthropic.AsyncAnthropic] = None

    def _get_client(self) -> Optional[anthropic.AsyncAnthropic]:
        if not self._api_key:
            return None
        if self._client is None:
            self._client = anthropic.AsyncAnthropic(api_key=self._api_key)
        return self._client

    async def score(
        self,
        report_id: str,
        infrastructure_type: str,
        severity: str,
        description: Optional[str],
        transcription: Optional[str],
        report_dt: datetime,
        user_image_path: Optional[str],
        satellite_data: dict,
        has_audio: bool = False,
        has_gps: bool = True,
        # B4 - Dynamic Crisis Forms context. When the report came through a
        # geo-gated crisis pack, the reporter answered crisis-specific questions
        # (form_data) inside an admin-defined event. These are community-curated
        # ground truth - additional corroborating evidence for the credibility
        # chain. All keyword + default None → existing callers are unaffected.
        form_data: Optional[dict] = None,
        crisis_type: Optional[str] = None,
        form_pack_id: Optional[str] = None,
        form_pack_version: Optional[int] = None,
    ) -> dict:
        """Run multi-modal truth scoring via Claude Haiku. Returns the scoring dict."""
        client = self._get_client()
        if not client:
            return _no_key_result()

        content = []

        # ── Part 1: satellite image ───────────────────────────────────────────
        sat_b64 = satellite_data.get("image_b64", "")
        if sat_b64:
            content.append({
                "type": "image",
                "source": {
                    "type":       "base64",
                    "media_type": satellite_data.get("image_media_type", "image/png"),
                    "data":       sat_b64,
                },
            })
            content.append({
                "type": "text",
                "text": "↑ IMAGE 1 - SATELLITE (top-down view of reported GPS coordinates)",
            })

        # ── Part 2: user photo ────────────────────────────────────────────────
        if user_image_path and os.path.exists(user_image_path):
            try:
                with open(user_image_path, "rb") as fh:
                    raw = fh.read()
                ext = (user_image_path.lower().rsplit(".", 1) + ["jpg"])[-1]
                mt_map = {"png": "image/png", "webp": "image/webp",
                          "jpg": "image/jpeg", "jpeg": "image/jpeg"}
                content.append({
                    "type": "image",
                    "source": {
                        "type":       "base64",
                        "media_type": mt_map.get(ext, "image/jpeg"),
                        "data":       base64.b64encode(raw).decode(),
                    },
                })
                content.append({
                    "type": "text",
                    "text": "↑ IMAGE 2 - USER PHOTO (ground-level, submitted by citizen reporter)",
                })
            except Exception as exc:
                logger.warning(f"Could not load user image {user_image_path}: {exc}")

        # ── Part 3: temporal gap calculation ─────────────────────────────────
        acq_str  = satellite_data.get("acquisition_date") or ""
        days_gap = None
        temporal_note = "Satellite acquisition date: UNKNOWN"
        if acq_str:
            try:
                acq_dt = datetime.fromisoformat(acq_str.replace("Z", "+00:00"))
                if report_dt.tzinfo is None:
                    report_dt = report_dt.replace(tzinfo=timezone.utc)
                gap      = report_dt - acq_dt
                days_gap = gap.days
                if days_gap < 0:
                    temporal_note = (
                        f"Satellite acquired {abs(days_gap)} day(s) AFTER the report "
                        f"(post-incident imagery - damage should be visible if significant)"
                    )
                elif days_gap == 0:
                    temporal_note = "Satellite acquired on the SAME DAY as the report"
                else:
                    temporal_note = (
                        f"Satellite acquired {days_gap} day(s) BEFORE the report "
                        f"(pre-incident imagery - damage may NOT yet be visible)"
                    )
            except Exception:
                pass

        data_completeness = "GPS + photo" + (" + audio" if has_audio else "")

        # B4 - community-curated ground truth (crisis-pack answers) + event type.
        _curated = _format_curated_answers(form_data)
        _pack_tag = (f" [pack {form_pack_id} v{form_pack_version}]"
                     if form_pack_id else "")
        _curated_block = (
            f"\nCOMMUNITY-CURATED GROUND TRUTH{_pack_tag} - structured answers the "
            f"reporter gave to crisis-specific questions"
            f"{f' for a confirmed {crisis_type} event' if crisis_type else ''}. "
            f"Treat these as corroborating evidence (weigh across damage, coherence "
            f"and data-quality), NOT as the claim itself:\n{_curated}\n"
        ) if _curated else ""
        _crisis_line = (f"  Confirmed crisis type:  {crisis_type} (event-bound)\n"
                        if crisis_type else "")

        # ── Part 4: full context text ─────────────────────────────────────────
        content.append({"type": "text", "text": (
            f"REPORT CONTEXT:\n"
            f"  Report ID:              {report_id}\n"
            f"  Claimed infrastructure: {infrastructure_type}\n"
            f"  Claimed severity:       {severity}\n"
            f"{_crisis_line}"
            f"  Report submitted at:    {report_dt.isoformat()}\n"
            f"  User description:       {description or '(none)'}\n"
            f"  Audio transcription:    {transcription or '(none)'}\n"
            f"{_curated_block}"
            f"\n"
            f"SATELLITE METADATA:\n"
            f"  Source:       {satellite_data.get('source', 'Unknown')}\n"
            f"  Temporal:     {temporal_note}\n"
            f"  Cloud cover:  {satellite_data.get('cloud_cover_pct', 'Unknown')}%\n"
            f"  Resolution:   {satellite_data.get('resolution_m', 'Unknown')} m/pixel\n"
            f"  Coordinates:  {satellite_data.get('lat', 0):.5f}, "
            f"{satellite_data.get('lon', 0):.5f}\n"
            f"\n"
            f"USER DATA COMPLETENESS: {data_completeness}\n"
            f"\n"
            f"Return ONLY the JSON object - no markdown, no extra text."
        )})

        # ── Call Claude Haiku (async) ─────────────────────────────────────────
        try:
            response = await client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=1200,
                temperature=0.1,
                system=[{"type": "text", "text": _PROMPT, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": content}],
            )

            raw = response.content[0].text.strip()

            # Strip accidental markdown fences
            if raw.startswith("```"):
                parts = raw.split("```")
                raw = parts[1]
                if raw.startswith("json"):
                    raw = raw[4:]

            result = json.loads(raw.strip())

            # Normalise total to sum of components
            sc = result.get("scores", {})
            sc["total"] = (
                sc.get("location_authenticity", 0)
                + sc.get("damage_corroboration",  0)
                + sc.get("description_coherence", 0)
                + sc.get("data_quality",          0)
            )

            result["satellite_data"] = {
                "source":           satellite_data.get("source"),
                "acquisition_date": satellite_data.get("acquisition_date"),
                "cloud_cover_pct":  satellite_data.get("cloud_cover_pct"),
                "resolution_m":     satellite_data.get("resolution_m"),
                "days_gap":         days_gap,
            }
            result["scored_at"] = datetime.now(timezone.utc).isoformat()

            # B4 - record that community-curated crisis-form answers were part of
            # the evidence chain + surface it as a key finding (the dashboard
            # detail panel renders key_findings → no schema change needed).
            considered = bool(_curated)
            result["form_data_considered"] = considered
            if considered:
                _n = len([k for k, val in (form_data or {}).items()
                          if val not in (None, "", [])])
                _note = (f"Community-curated crisis-form answers ({_n} field"
                         f"{'s' if _n != 1 else ''}) were weighed as corroborating evidence.")
                _kf = result.get("key_findings")
                if isinstance(_kf, list):
                    _kf.append(_note)
                else:
                    result["key_findings"] = [_note]

            logger.info(
                f"Truth score for {report_id}: {sc['total']}/100 - {result.get('verdict')}"
                + (" [+curated]" if considered else "")
            )
            return result

        except json.JSONDecodeError as exc:
            logger.error(f"Claude returned non-JSON: {exc} | raw: {raw[:300]}")
            return _error_result("AI response was not valid JSON")
        except anthropic.APIStatusError as exc:
            logger.error(f"Anthropic API error {exc.status_code}: {exc.message}")
            return _error_result(f"Anthropic API {exc.status_code}: {exc.message}")
        except Exception as exc:
            logger.error(f"Truth scoring failed: {exc}")
            return _error_result(str(exc))


# ── Fallback helpers ──────────────────────────────────────────────────────────

def _base_error():
    return {
        "scores": {
            "location_authenticity": 0,
            "damage_corroboration":  0,
            "description_coherence": 0,
            "data_quality":          0,
            "total":                 0,
        },
        "key_findings": [],
        "caveats":       [],
        "satellite_scene_description": "",
        "photo_analysis":              "",
    }


def _no_key_result() -> dict:
    r = _base_error()
    r.update({
        "error":     "ANTHROPIC_API_KEY not configured",
        "verdict":   "UNVERIFIED",
        "reasoning": "Verification service not configured - add ANTHROPIC_API_KEY to .env",
    })
    return r


def _error_result(msg: str) -> dict:
    r = _base_error()
    r.update({
        "error":     msg,
        "verdict":   "UNVERIFIED",
        "reasoning": f"Verification failed: {msg}",
    })
    return r


# Singleton
truth_scorer = TruthScorer()
