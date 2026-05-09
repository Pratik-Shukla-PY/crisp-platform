"""
CRISP — AI classify-suggest service.

Used by the v4 PWA capture flow on Page 2: when the user takes a photo on a
fast network, the client POSTs the photo (+ optional GPS) here, and we ask
Claude Haiku for a 3-tuple of suggested classifications:
  • infrastructure_type  (one of UNDP super-types)
  • crisis_type          (one of UNDP crisis types)
  • damage_classification (MINIMAL | PARTIAL | COMPLETE)

The client receives the suggestions within ~1.5 s on a typical fast link
and animates the 3 chip rows to those defaults; the user only taps the
ones they disagree with. On slow / offline tiers, the client never
calls this endpoint and the user picks all three manually — same UX as
v3 today, no blocking wait.

Design notes:
  - Vision-capable model required (Haiku 4.5 has it; same model the truth
    scorer uses for satellite × user-photo comparison).
  - Output is STRICTLY a JSON object with three string fields. Anything
    outside the enum sets is rejected client-side and the client falls
    back to its heuristic defaults.
  - We do NOT block the response on Anthropic if the API is degraded —
    the endpoint enforces a 3-second deadline (well below the 1.5 s
    client timeout) and on timeout returns a 200 with a "fallback"
    flag so the client knows to use heuristics.
  - Cost discipline: input image is downsized client-side to ~640 px
    long-side before upload (we still re-cap server-side to 1024 px to
    bound payload size).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from typing import Optional

logger = logging.getLogger(__name__)

# Same model truth_scorer uses — pinned alias keeps us in sync.
_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

# Hard caps. The server-side re-encode is a defensive belt: if a malicious
# / misbehaving client sends a 50 MB image we still keep the bill bounded.
_MAX_BYTES = 8 * 1024 * 1024  # 8 MB after base64-decode

# Server-side response budget. Anthropic SDK takes >>3 s on rare cold-
# starts; we'd rather time out and tell the client to fall back than
# leave a request hanging while the user waits.
_TIMEOUT_SECONDS = 3.0

# Strict UNDP enum sets — we reject anything outside these to keep the
# downstream chip pre-fill deterministic. Mirrored from the Pydantic
# enums in app.models.report for the must-haves.
_INFRASTRUCTURE_VALUES = {
    "RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY",
    "TRANSPORT_COMMUNICATION", "COMMUNITY", "PUBLIC_SPACES", "OTHER",
}
_CRISIS_VALUES = {
    "EARTHQUAKE", "FLOOD", "TSUNAMI", "HURRICANE", "WILDFIRE",
    "EXPLOSION", "CHEMICAL_INCIDENT", "CONFLICT", "CIVIL_UNREST", "OTHER",
}
_DAMAGE_VALUES = {"MINIMAL", "PARTIAL", "COMPLETE"}

_PROMPT = """You are a damage-assessment assistant for the UN CRISP platform.

You will see a single ground-level photo from a citizen reporter, plus
optional GPS coordinates. Your job is to suggest the most likely answer
for THREE classification fields. The reporter will see your suggestions
pre-selected on three chip rows and only tap the ones they disagree with.

Be DECISIVE. Pick the single most likely value for each field even if
the photo is ambiguous — the reporter overrides any wrong default in
one tap. A confident wrong default is much better than no default,
because it means the user's task drops from "pick 3 chips" to "either
tap continue OR tap to correct."

Return ONLY a valid JSON object with these exact keys, no markdown
fences, no prose:

{
  "infrastructure_type": "<one of: RESIDENTIAL, COMMERCIAL, GOVERNMENT, UTILITY, TRANSPORT_COMMUNICATION, COMMUNITY, PUBLIC_SPACES, OTHER>",
  "crisis_type":         "<one of: EARTHQUAKE, FLOOD, TSUNAMI, HURRICANE, WILDFIRE, EXPLOSION, CHEMICAL_INCIDENT, CONFLICT, CIVIL_UNREST, OTHER>",
  "damage_classification": "<one of: MINIMAL, PARTIAL, COMPLETE>",
  "confidence": <float 0.0-1.0>,
  "reasoning_short": "<≤80 chars: 1 sentence justifying the trio>"
}

Definitions:
  • RESIDENTIAL          — houses, apartments, single-family dwellings
  • COMMERCIAL           — markets, malls, shops, hotels, banks, restaurants
  • GOVERNMENT           — admin buildings, courthouses, police, fire stations
  • UTILITY              — water pumps, power plants, waste treatment
  • TRANSPORT_COMMUNICATION — roads, cell towers, bridges, train/bus stations
  • COMMUNITY            — schools, hospitals, halls, public toilets
  • PUBLIC_SPACES        — stadiums, playgrounds, religious buildings, parks
  • OTHER                — anything that doesn't fit cleanly above

  • MINIMAL — structurally sound, only cosmetic damage or none
  • PARTIAL — repairable, usable with caution
  • COMPLETE — structurally unsafe or destroyed
"""


class ClassifySuggestService:
    """Wraps Claude Haiku for the 3-chip pre-fill prediction."""

    def __init__(self):
        self._api_key = os.getenv("ANTHROPIC_API_KEY", "")
        self._client = None

    def _get_client(self):
        if not self._api_key:
            return None
        if self._client is None:
            try:
                import anthropic  # lazy — keeps test env without anthropic happy
                self._client = anthropic.AsyncAnthropic(api_key=self._api_key)
            except ImportError:
                logger.warning("anthropic SDK not installed; classify-suggest disabled")
                return None
        return self._client

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key)

    async def suggest(
        self,
        image_b64: str,
        media_type: str = "image/jpeg",
        lat: Optional[float] = None,
        lng: Optional[float] = None,
    ) -> dict:
        """
        Predict (infra, crisis, damage) from a single photo.

        Returns a dict with the four fields plus a `source` discriminator:
          - source = "ai"        — Claude responded with valid JSON in the enums
          - source = "fallback"  — degraded path: API key missing, timeout,
                                   parse error, or out-of-enum response.
                                   Returns sensible defaults.
        """
        if not image_b64:
            return _fallback("no image")

        # Hard cap on payload size — defensive. base64 expands by ~33 %.
        if len(image_b64) > int(_MAX_BYTES * 1.4):
            return _fallback("image too large")

        client = self._get_client()
        if client is None:
            return _fallback("no api key")

        # Provide GPS context if available — coastal coordinates make
        # FLOOD/TSUNAMI more plausible, urban + dense → EARTHQUAKE
        # patterns, etc. This is "ambient" context, not a hard prior.
        gps_note = ""
        if lat is not None and lng is not None:
            gps_note = f"\n\nGPS context: lat={lat:.4f}, lng={lng:.4f}"

        try:
            content = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": image_b64,
                    },
                },
                {
                    "type": "text",
                    "text": _PROMPT + gps_note,
                },
            ]

            response = await asyncio.wait_for(
                client.messages.create(
                    model=_ANTHROPIC_MODEL,
                    max_tokens=300,
                    messages=[{"role": "user", "content": content}],
                ),
                timeout=_TIMEOUT_SECONDS,
            )
            raw = "".join(b.text for b in response.content if hasattr(b, "text"))
            parsed = _parse_response(raw)
            if not parsed:
                return _fallback("unparseable response")
            # Validate against enum sets — anything outside is treated as
            # a soft failure and we fall back. Better to default-correctly
            # than to set a chip the UI doesn't recognise.
            if parsed["infrastructure_type"] not in _INFRASTRUCTURE_VALUES:
                return _fallback(f"infra out of set: {parsed['infrastructure_type']}")
            if parsed["crisis_type"] not in _CRISIS_VALUES:
                return _fallback(f"crisis out of set: {parsed['crisis_type']}")
            if parsed["damage_classification"] not in _DAMAGE_VALUES:
                return _fallback(f"damage out of set: {parsed['damage_classification']}")
            parsed["source"] = "ai"
            return parsed
        except asyncio.TimeoutError:
            logger.info(f"classify-suggest timed out after {_TIMEOUT_SECONDS}s")
            return _fallback("timeout")
        except Exception as exc:
            logger.warning(f"classify-suggest failed: {type(exc).__name__}: {exc}")
            return _fallback(f"exception: {type(exc).__name__}")


def _parse_response(raw: str) -> Optional[dict]:
    """Extract a JSON object from Claude's response. Tolerates markdown
    fencing if the model accidentally wraps it."""
    if not raw:
        return None
    # Strip optional markdown fences: ```json ... ```
    txt = raw.strip()
    if txt.startswith("```"):
        # Remove first line (```json) and last line (```)
        lines = txt.splitlines()
        txt = "\n".join(lines[1:-1]) if len(lines) >= 3 else txt
        txt = txt.strip()
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        # Last-ditch: find a {...} block.
        m = re.search(r"\{[^{}]*\}", txt, flags=re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def _fallback(reason: str) -> dict:
    """Sensible defaults when the AI path is unavailable. The client
    overrides each chip in one tap if the default is wrong; the user
    is never blocked."""
    return {
        "infrastructure_type": "RESIDENTIAL",
        "crisis_type": "EARTHQUAKE",
        "damage_classification": "PARTIAL",
        "confidence": 0.0,
        "reasoning_short": "default suggestion",
        "source": "fallback",
        "fallback_reason": reason,
    }
