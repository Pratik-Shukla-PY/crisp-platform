"""
Telegram Session Manager — Reuses the same pattern as WhatsApp.
Per-user session buffers to aggregate multiple Telegram messages into
a single structured CRISP report.
"""
import os
import hashlib
import logging
from uuid import uuid4
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, Dict

import httpx

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")

SEVERITY_MAP = {
    "sev_severe": "SEVERE", "sev_moderate": "MODERATE", "sev_minor": "MINOR",
    "1": "SEVERE", "2": "MODERATE", "3": "MINOR",
    "severe": "SEVERE", "moderate": "MODERATE", "minor": "MINOR",
}
TYPE_MAP = {
    "type_road": "ROAD", "type_hospital": "HOSPITAL", "type_house": "HOUSE",
    "type_power": "POWER", "type_water": "WATER", "type_other": "OTHER",
    "road": "ROAD", "hospital": "HOSPITAL", "house": "HOUSE",
    "power": "POWER", "water": "WATER", "other": "OTHER",
}


@dataclass
class TelegramSession:
    """Per-user session that accumulates Telegram inputs."""
    user_hash: str           # TG-{sha256[:16]}
    chat_id: int             # for sending replies
    lang: str = ""           # detected from Telegram user locale
    state: str = "START"     # START → STEP_LOCATION → STEP_PHOTO → STEP_SEVERITY → STEP_TYPE → STEP_VOICE → DONE
    text: str = ""
    image_data_url: str = ""
    audio_data_url: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: str = ""           # reverse-geocoded place name
    severity: str = "UNKNOWN"
    infra_type: str = "OTHER"
    client_report_id: str = field(default_factory=lambda: str(uuid4()))
    report_id: Optional[str] = None  # set after early creation
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    last_activity: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    message_ids: set = field(default_factory=set)
    submitted_report_id: Optional[str] = None

    @property
    def has_evidence(self) -> bool:
        return bool(self.image_data_url or self.audio_data_url or self.text)

    @property
    def has_location(self) -> bool:
        return self.latitude is not None and self.longitude is not None

    @property
    def is_complete(self) -> bool:
        return (
            self.severity != "UNKNOWN"
            and self.infra_type != ""
            and self.has_location
        )

    @property
    def media_count(self) -> int:
        return sum([bool(self.image_data_url), bool(self.audio_data_url)])

    def touch(self):
        self.last_activity = datetime.now(timezone.utc).timestamp()


_sessions: Dict[str, TelegramSession] = {}


def hash_user(user_id: int) -> str:
    """Hash Telegram user ID for privacy."""
    return "TG-" + hashlib.sha256(str(user_id).encode()).hexdigest()[:16]


def get_or_create_session(user_id: int, chat_id: int) -> TelegramSession:
    uh = hash_user(user_id)
    if uh not in _sessions or _sessions[uh].state == "DONE":
        _sessions[uh] = TelegramSession(user_hash=uh, chat_id=chat_id)
        logger.info(f"New Telegram session: {uh}")
    return _sessions[uh]


def get_session(user_id: int) -> Optional[TelegramSession]:
    return _sessions.get(hash_user(user_id))


def clear_session(user_id):
    """Clear session by user_id (int) or user_hash (str)."""
    if isinstance(user_id, str) and user_id.startswith("TG-"):
        uh = user_id
    elif isinstance(user_id, int):
        uh = hash_user(user_id)
    else:
        # Try as int (could be chat_id used as fallback)
        uh = hash_user(int(user_id))
    if uh in _sessions:
        _sessions[uh].state = "DONE"


def is_duplicate_message(session: TelegramSession, message_id: int) -> bool:
    if message_id in session.message_ids:
        return True
    session.message_ids.add(message_id)
    return False


async def resolve_location_name(session: TelegramSession):
    """Reverse-geocode coordinates to get a detailed place name.
    Returns format: 'Neighbourhood/Locality, City, State, Country'"""
    if not session.has_location:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "lat": session.latitude, "lon": session.longitude,
                    "format": "json", "zoom": 16, "addressdetails": 1,
                },
                headers={"User-Agent": "CRISP-Bot", "Accept-Language": "en"},
            )
            if r.status_code == 200:
                data = r.json()
                addr = data.get("address", {})
                # Build name from most local → broadest
                neighbourhood = addr.get("neighbourhood") or addr.get("suburb") or addr.get("hamlet") or ""
                city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county") or ""
                state = addr.get("state") or addr.get("state_district") or ""
                country = addr.get("country") or ""

                parts = []
                if neighbourhood:
                    parts.append(neighbourhood)
                if city and city != neighbourhood:
                    parts.append(city)
                if state and state != city:
                    parts.append(state)
                if country:
                    parts.append(country)

                session.location_name = ", ".join(parts) if parts else ""
                if session.location_name:
                    logger.info(f"Location resolved: {session.location_name}")
    except Exception as e:
        logger.warning(f"Reverse geocode failed: {e}")


async def create_report_early(session: TelegramSession) -> Optional[str]:
    """
    Create the report on backend as soon as location is received.
    This makes the report appear on the dashboard immediately.
    Media will be streamed as it arrives in subsequent steps.
    """
    if session.report_id:
        return session.report_id  # already created

    meta = {
        "device_hash": session.user_hash,
        "client_report_id": session.client_report_id,
        "source": "TELEGRAM",
        "severity": session.severity,
        "infrastructure_type": session.infra_type,
        "description": session.text or None,
        "expected_media": 2,  # assume photo + audio (will adjust)
    }

    if session.has_location:
        meta["location"] = {
            "latitude": session.latitude,
            "longitude": session.longitude,
            "device_latitude": session.latitude,
            "device_longitude": session.longitude,
            "accuracy_meters": 50.0,
            "device_location_name": session.location_name or None,
        }

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{BACKEND_URL}/api/v1/reports/meta", json=meta)
            if r.status_code not in (200, 201):
                logger.error(f"Early report creation failed ({r.status_code}): {r.text[:200]}")
                return None

            report = r.json()
            session.report_id = report["id"]
            logger.info(f"Telegram report created early: {session.report_id}")
            return session.report_id

    except Exception as e:
        logger.error(f"Early report creation error: {e}")
        return None


async def upload_image(session: TelegramSession) -> bool:
    """Upload image in progressive chunks to an already-created report."""
    if not session.report_id or not session.image_data_url:
        return False
    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url
        b64, mime = extract_b64_from_data_url(session.image_data_url)
        return await upload_media_chunked(session.report_id, b64, "IMAGE", mime)
    except Exception as e:
        logger.error(f"Image upload error: {e}")
        return False


async def upload_audio(session: TelegramSession) -> bool:
    """Upload audio in progressive chunks to an already-created report."""
    if not session.report_id or not session.audio_data_url:
        return False
    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url
        b64, mime = extract_b64_from_data_url(session.audio_data_url)
        return await upload_media_chunked(session.report_id, b64, "AUDIO", mime)
    except Exception as e:
        logger.error(f"Audio upload error: {e}")
        return False


async def update_report_metadata(session: TelegramSession):
    """Update severity, type, and description on the already-created report."""
    if not session.report_id:
        return
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            # Update severity + type + description in one call
            payload = {}
            if session.severity != "UNKNOWN":
                payload["severity"] = session.severity
            if session.infra_type != "OTHER":
                payload["infrastructure_type"] = session.infra_type
            if session.text:
                payload["description"] = session.text

            if payload:
                r = await c.patch(
                    f"{BACKEND_URL}/api/v1/reports/{session.report_id}/classify",
                    json=payload,
                )
                if r.status_code == 200:
                    logger.info(f"Report {session.report_id} classified: {payload}")
                else:
                    logger.warning(f"Classify failed ({r.status_code}): {r.text[:100]}")
    except Exception as e:
        logger.warning(f"Metadata update error: {e}")


async def delete_report(session: TelegramSession) -> bool:
    """Delete the report (soft-delete with 24h grace period)."""
    if not session.report_id:
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.delete(f"{BACKEND_URL}/api/v1/reports/{session.report_id}")
            if r.status_code == 200:
                logger.info(f"Report {session.report_id} deletion requested by user")
                return True
    except Exception as e:
        logger.warning(f"Delete error: {e}")
    return False


# Legacy compat
async def submit_report(session: TelegramSession) -> Optional[str]:
    """Final submission — update metadata and return report_id."""
    if not session.report_id:
        await create_report_early(session)
    if session.report_id:
        await update_report_metadata(session)
        session.submitted_report_id = session.report_id
        session.state = "DONE"
    return session.report_id
