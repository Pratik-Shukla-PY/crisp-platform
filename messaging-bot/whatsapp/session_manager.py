"""
WhatsApp Session Manager - Maintains per-user session buffers to aggregate
multiple WhatsApp messages into a single structured CRISP report.

Each user (phone number) gets a session that collects inputs over time.
After all required fields are gathered, the session submits a report
to the CRISP backend API.
"""
import os
import hashlib
import logging
import asyncio
from uuid import uuid4
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, Dict

import httpx

from messaging_bot.crisis_forms_client import resolve_active_event_id

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")
SESSION_TTL_SECONDS = 300  # 5 minutes - auto-submit after this

# Severity and type mappings from button IDs
SEVERITY_MAP = {
    "sev_severe": "SEVERE", "sev_moderate": "MODERATE", "sev_minor": "MINOR",
    "1": "SEVERE", "2": "MODERATE", "3": "MINOR",
    "severe": "SEVERE", "moderate": "MODERATE", "minor": "MINOR",
}
TYPE_MAP = {
    "type_road": "ROAD", "type_hospital": "HOSPITAL", "type_house": "HOUSE",
    "type_power": "POWER", "type_water": "WATER", "type_school": "SCHOOL",
    "type_telecom": "TELECOM", "type_govt": "GOVERNMENT", "type_other": "OTHER",
    "road": "ROAD", "hospital": "HOSPITAL", "house": "HOUSE",
    "power": "POWER", "water": "WATER", "school": "SCHOOL",
    "telecom": "TELECOM", "government": "GOVERNMENT", "other": "OTHER",
}
# Phase-4 (channel parity): map WhatsApp's crisis/damage buttons to CANONICAL
# UNDP enum values. crisis_hurricane -> CYCLONE (UNDP's single Hurricane/Cyclone
# category); crisis_landslide / crisis_pandemic -> OTHER - both are NOT on the
# UNDP spec and the backend Pydantic taxonomy validator 422-REJECTS them on write,
# which silently dropped the crisis_type on those WhatsApp reports. dmg_none ->
# MINIMAL (canonical; NO_DAMAGE is a deprecated alias). Mirrors the Telegram map.
CRISIS_MAP = {
    "crisis_earthquake": "EARTHQUAKE", "crisis_flood": "FLOOD", "crisis_conflict": "CONFLICT",
    "crisis_hurricane": "CYCLONE", "crisis_wildfire": "WILDFIRE", "crisis_landslide": "OTHER",
    "crisis_pandemic": "OTHER", "crisis_other": "OTHER",
}
DAMAGE_MAP = {
    "dmg_none": "MINIMAL", "dmg_partial": "PARTIAL", "dmg_complete": "COMPLETE",
}


@dataclass
class SessionBuffer:
    """Per-user session that accumulates WhatsApp inputs."""
    phone_hash: str          # WA-{sha256[:16]} - anonymized
    phone_raw: str           # raw number (for sending replies only, never stored in DB)
    lang: str = "en"         # Detected/selected language
    state: str = "COLLECTING"  # COLLECTING → AWAITING_SEVERITY → AWAITING_TYPE → AWAITING_LOCATION → SUBMITTING → DONE
    text: str = ""
    image_data_url: str = ""      # data:image/jpeg;base64,...
    audio_data_url: str = ""      # data:audio/ogg;base64,...
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    severity: str = "UNKNOWN"
    infra_type: str = "OTHER"
    crisis_type: str = ""
    damage_class: str = ""
    client_report_id: str = field(default_factory=lambda: str(uuid4()))
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    last_activity: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    message_ids: set = field(default_factory=set)  # deduplication
    submitted_report_id: Optional[str] = None
    # ── Dynamic crisis-form pack (UNDP Appendix-1 questions) ──────────────────
    # When an active pack covers the reporter's location, the bot asks the pack's
    # channel-applicable questions (the 3 UNDP multi-selects) as numbered text and
    # submits form_pack_id/version/form_data. All None/empty when no pack applies →
    # the rapid-intake flow is byte-for-byte unchanged.
    form_pack_id: Optional[str] = None
    form_pack_version: Optional[int] = None
    pack_schema: Optional[dict] = None
    pack_fields: list = field(default_factory=list)
    pack_index: int = 0
    pack_answers: dict = field(default_factory=dict)   # field key -> coerced value (== form_data)
    pack_partial: list = field(default_factory=list)   # in-progress multi_select picks (option values)
    pack_resolved: bool = False
    pack_awaiting_other: Optional[str] = None

    @property
    def has_evidence(self) -> bool:
        """Has at least one meaningful input (image, audio, or text)."""
        return bool(self.image_data_url or self.audio_data_url or self.text)

    @property
    def has_location(self) -> bool:
        return self.latitude is not None and self.longitude is not None

    @property
    def pack_active(self) -> bool:
        return bool(self.pack_fields)

    @property
    def pack_complete(self) -> bool:
        if not self.pack_fields:
            return True
        return self.pack_index >= len(self.pack_fields) and not self.pack_awaiting_other

    @property
    def is_complete(self) -> bool:
        """All required fields gathered - ready to submit. In a pack region the
        UNDP questions must also be answered before the auto-submit fires."""
        return (
            self.has_evidence
            and self.severity != "UNKNOWN"
            and self.infra_type != "OTHER"  # Must explicitly choose
            and self.has_location
            and self.pack_complete
        )

    @property
    def media_count(self) -> int:
        count = 0
        if self.image_data_url:
            count += 1
        if self.audio_data_url:
            count += 1
        return count

    def touch(self):
        self.last_activity = datetime.now(timezone.utc).timestamp()


# In-memory session store
_sessions: Dict[str, SessionBuffer] = {}


def hash_phone(phone: str) -> str:
    """SHA-256 hash of phone number, prefixed with WA- for identification."""
    return "WA-" + hashlib.sha256(phone.encode()).hexdigest()[:16]


def get_or_create_session(phone: str) -> SessionBuffer:
    """Get existing session or create new one for this phone number."""
    ph = hash_phone(phone)
    if ph not in _sessions or _sessions[ph].state == "DONE":
        _sessions[ph] = SessionBuffer(phone_hash=ph, phone_raw=phone)
        logger.info(f"New session created: {ph}")
    return _sessions[ph]


def get_session(phone: str) -> Optional[SessionBuffer]:
    """Get existing session without creating."""
    ph = hash_phone(phone)
    return _sessions.get(ph)


def clear_session(phone: str):
    """Remove session after submission."""
    ph = hash_phone(phone)
    if ph in _sessions:
        _sessions[ph].state = "DONE"


def is_duplicate_message(session: SessionBuffer, message_id: str) -> bool:
    """Check if we've already processed this message."""
    if message_id in session.message_ids:
        return True
    session.message_ids.add(message_id)
    return False


async def submit_report(session: SessionBuffer) -> Optional[str]:
    """
    Submit the collected session data to the CRISP backend API.
    Returns the report ID on success, None on failure.
    """
    session.state = "SUBMITTING"

    # 1. Create report meta
    meta = {
        "device_hash": session.phone_hash,
        "client_report_id": session.client_report_id,
        "source": "WHATSAPP",
        "severity": session.severity,
        "infrastructure_type": session.infra_type,
        "description": session.text or None,
        "expected_media": session.media_count,
        "crisis_type": session.crisis_type or None,
        "damage_classification": session.damage_class or None,
    }
    # UNDP "Other, please specify" rule (backend report.py:185) - when
    # the WhatsApp user picked OTHER (or fell through the chip menu
    # without picking), backend rejects with 422. Synthesise a name
    # from the description snippet so the report lands rather than
    # being silently lost.
    if (session.infra_type or "").upper() == "OTHER":
        snippet = (session.text or "").strip()
        meta["infrastructure_name"] = (
            snippet[:40] if snippet
            else "Reporter did not specify"
        )
        meta["infrastructure_name_from_osm"] = False

    if session.has_location:
        meta["location"] = {
            "latitude": session.latitude,
            "longitude": session.longitude,
            "device_latitude": session.latitude,
            "device_longitude": session.longitude,
            "accuracy_meters": 50.0,
        }
        # Operation linkage - WhatsApp shares a precise GPS location, so resolve
        # the active crisis zone there and echo its event id. The backend treats
        # it as a hint and re-derives authoritatively from the location; no active
        # zone → absent → GLOBAL report.
        _eid = await resolve_active_event_id(session.latitude, session.longitude)
        if _eid:
            meta["crisis_event_id"] = _eid
        # Dynamic crisis-form pack (UNDP Appendix-1 questions). When an active pack
        # covers this location the bot asked its channel-applicable questions; attach
        # the answers so the server validates + stores them (form_data). The submit
        # gate (is_complete → pack_complete) guarantees the pack is fully answered
        # before this fires, so a required field can never 422. No pack → unchanged.
        if session.form_pack_id and session.pack_complete and session.pack_answers:
            meta["form_pack_id"] = session.form_pack_id
            meta["form_pack_version"] = session.form_pack_version
            meta["form_data"] = dict(session.pack_answers)

    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url

        async with httpx.AsyncClient(timeout=30) as c:
            # Step 1: Create report meta
            r = await c.post(f"{BACKEND_URL}/api/v1/reports/meta", json=meta)
            if r.status_code not in (200, 201):
                logger.error(f"Report creation failed ({r.status_code}): {r.text[:200]}")
                session.state = "COLLECTING"
                return None

            report = r.json()
            report_id = report["id"]
            logger.info(f"Report created: {report_id} for session {session.phone_hash}")

        # Step 2: Upload image in progressive chunks (same as mobile app)
        if session.image_data_url:
            b64, mime = extract_b64_from_data_url(session.image_data_url)
            await upload_media_chunked(report_id, b64, "IMAGE", mime)

        # Step 3: Upload audio in progressive chunks
        if session.audio_data_url:
            b64, mime = extract_b64_from_data_url(session.audio_data_url)
            await upload_media_chunked(report_id, b64, "AUDIO", mime)

        session.submitted_report_id = report_id
        session.state = "DONE"
        return report_id

    except Exception as e:
        logger.error(f"Report submission error: {e}")
        session.state = "COLLECTING"
        return None
