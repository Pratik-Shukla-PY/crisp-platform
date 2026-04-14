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
    "type_power": "POWER", "type_water": "WATER", "type_school": "SCHOOL",
    "type_telecom": "TELECOM", "type_govt": "GOVERNMENT", "type_other": "OTHER",
    "road": "ROAD", "hospital": "HOSPITAL", "house": "HOUSE",
    "power": "POWER", "water": "WATER", "school": "SCHOOL",
    "telecom": "TELECOM", "government": "GOVERNMENT", "other": "OTHER",
}
CRISIS_MAP = {
    "crisis_earthquake": "EARTHQUAKE", "crisis_flood": "FLOOD", "crisis_conflict": "CONFLICT",
    "crisis_hurricane": "HURRICANE", "crisis_wildfire": "WILDFIRE", "crisis_landslide": "LANDSLIDE",
    "crisis_pandemic": "PANDEMIC", "crisis_other": "OTHER",
}
DAMAGE_MAP = {
    "dmg_none": "NO_DAMAGE", "dmg_partial": "PARTIAL", "dmg_complete": "COMPLETE",
}


@dataclass
class TelegramSession:
    """Per-user session that accumulates Telegram inputs."""
    user_hash: str           # TG-{sha256[:16]}
    chat_id: int             # for sending replies
    lang: str = ""           # detected from Telegram user locale
    state: str = "START"     # START → LANG_SELECT → STEP_PHOTO → STEP_DESCRIPTION → STEP_TYPE → STEP_SEVERITY → STEP_LOCATION → DONE
    text: str = ""
    image_data_url: str = ""
    audio_data_url: str = ""
    video_data_url: str = ""     # deferred: uploaded after everything else
    image_uploaded: bool = False  # track if image was already sent to backend
    audio_uploaded: bool = False  # track if audio was already sent to backend
    type_answered: bool = False   # track if user answered type (even if they picked OTHER)
    severity_answered: bool = False  # track if user answered severity
    pending_uploads: list = field(default_factory=list)  # asyncio.Task fire-and-forget uploads
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: str = ""           # reverse-geocoded place name
    severity: str = "UNKNOWN"
    infra_type: str = "OTHER"
    crisis_type: str = ""          # EARTHQUAKE / FLOOD / CONFLICT / etc.
    damage_class: str = ""         # NO_DAMAGE / PARTIAL / COMPLETE
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


# ── Language detection — EXACT SAME logic as mobile app (COUNTRY_LANG_DATA + REGION_LANG_MAP) ──
# 190+ countries → language code (mirrors mobile-app/src/app.js COUNTRY_LANG_DATA)
_COUNTRY_LANG = {
    # Asia & Pacific
    'IN': 'hi', 'BD': 'bn', 'PK': 'ur', 'LK': 'si', 'NP': 'ne',
    'MM': 'my', 'MY': 'ms', 'TH': 'th', 'VN': 'vi', 'ID': 'id',
    'PH': 'tl', 'KH': 'km', 'LA': 'lo', 'CN': 'zh', 'TW': 'zh', 'HK': 'zh',
    'JP': 'ja', 'KR': 'ko', 'MN': 'mn', 'KZ': 'kk', 'UZ': 'uz', 'KG': 'ky',
    'TJ': 'tg', 'TM': 'tk', 'AZ': 'az', 'GE': 'ka', 'AM': 'hy',
    'SG': 'en', 'BN': 'ms', 'TL': 'pt', 'NZ': 'en', 'AU': 'en',
    # Middle East
    'SA': 'ar', 'AE': 'ar', 'IQ': 'ar', 'SY': 'ar', 'JO': 'ar', 'LB': 'ar',
    'KW': 'ar', 'QA': 'ar', 'BH': 'ar', 'OM': 'ar', 'YE': 'ar', 'PS': 'ar',
    'TR': 'tr', 'IR': 'fa', 'IL': 'he', 'AF': 'ps', 'CY': 'el',
    # Africa
    'EG': 'ar', 'MA': 'ar', 'DZ': 'ar', 'TN': 'ar', 'LY': 'ar', 'SD': 'ar', 'MR': 'ar',
    'SO': 'so', 'DJ': 'fr', 'ET': 'am', 'ER': 'ti',
    'KE': 'sw', 'TZ': 'sw', 'UG': 'sw', 'RW': 'rw', 'BI': 'fr',
    'CD': 'fr', 'CG': 'fr', 'CF': 'fr', 'CM': 'fr', 'TD': 'fr', 'NE': 'fr',
    'ML': 'fr', 'BF': 'fr', 'SN': 'fr', 'GN': 'fr', 'CI': 'fr', 'TG': 'fr',
    'BJ': 'fr', 'GA': 'fr', 'GQ': 'es',
    'NG': 'en', 'GH': 'en', 'ZA': 'zu', 'ZW': 'en', 'ZM': 'en', 'MW': 'en',
    'MZ': 'pt', 'AO': 'pt', 'CV': 'pt', 'GW': 'pt', 'ST': 'pt', 'MG': 'fr',
    'NA': 'en', 'BW': 'en', 'SS': 'en',
    # Europe
    'FR': 'fr', 'DE': 'de', 'AT': 'de', 'CH': 'de', 'LU': 'fr', 'BE': 'nl', 'NL': 'nl',
    'ES': 'es', 'PT': 'pt', 'IT': 'it', 'GB': 'en', 'IE': 'en', 'US': 'en', 'CA': 'en',
    'RU': 'ru', 'UA': 'uk', 'BY': 'be', 'PL': 'pl', 'CZ': 'cs', 'SK': 'sk',
    'HU': 'hu', 'RO': 'ro', 'MD': 'ro', 'BG': 'bg', 'RS': 'sr', 'HR': 'hr',
    'BA': 'bs', 'SI': 'sl', 'MK': 'mk', 'AL': 'sq', 'GR': 'el',
    'SE': 'sv', 'NO': 'no', 'DK': 'da', 'FI': 'fi', 'IS': 'is',
    'EE': 'et', 'LV': 'lv', 'LT': 'lt', 'MT': 'mt',
    # Americas
    'MX': 'es', 'GT': 'es', 'HN': 'es', 'SV': 'es', 'NI': 'es', 'CR': 'es', 'PA': 'es',
    'CU': 'es', 'DO': 'es', 'PR': 'es', 'CO': 'es', 'VE': 'es', 'EC': 'es',
    'PE': 'es', 'BO': 'es', 'PY': 'es', 'UY': 'es', 'AR': 'es', 'CL': 'es',
    'BR': 'pt', 'HT': 'fr', 'JM': 'en', 'TT': 'en', 'GY': 'en', 'SR': 'nl', 'BZ': 'en',
}

# Sub-national regions (India) — mirrors mobile-app/src/app.js REGION_LANG_MAP
_REGION_LANG_MAP = [
    {'match': ['karnataka', 'bangalore', 'bengaluru', 'mysore', 'hubli'], 'code': 'kn'},
    {'match': ['tamil nadu', 'tamilnadu'], 'code': 'ta'},
    {'match': ['kerala'], 'code': 'ml'},
    {'match': ['telangana', 'andhra'], 'code': 'te'},
    {'match': ['maharashtra'], 'code': 'mr'},
    {'match': ['gujarat'], 'code': 'gu'},
    {'match': ['punjab', 'chandigarh', 'haryana'], 'code': 'pa'},
    {'match': ['west bengal', 'kolkata'], 'code': 'bn'},
    {'match': ['odisha'], 'code': 'or'},
    {'match': ['assam', 'meghalaya', 'manipur', 'nagaland', 'mizoram', 'tripura', 'arunachal', 'sikkim'], 'code': 'as'},
    {'match': ['rajasthan', 'uttar pradesh', 'madhya pradesh', 'bihar', 'jharkhand', 'chhattisgarh', 'uttarakhand', 'himachal', 'delhi', 'india'], 'code': 'hi'},
]


async def resolve_location_name(session: TelegramSession):
    """Reverse-geocode coordinates to get a detailed place name.
    Also detects the local language from the country code and overrides session.lang."""
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
                country_code = (addr.get("country_code") or "").upper()

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

                # Override language based on location — same logic as mobile app
                # Step 1: Check sub-national regions first (e.g. Indian states)
                region_str = " ".join([
                    state, addr.get("state_district", ""),
                    city, neighbourhood, country
                ]).lower()

                detected_lang = ""
                for entry in _REGION_LANG_MAP:
                    if any(k in region_str for k in entry['match']):
                        detected_lang = entry['code']
                        break

                # Step 2: Fall back to country-level mapping
                if not detected_lang:
                    detected_lang = _COUNTRY_LANG.get(country_code, "")

                if detected_lang:
                    old_lang = session.lang
                    session.lang = detected_lang
                    logger.info(f"Language overridden by location: {old_lang} → {detected_lang} (country={country_code}, region={state})")
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
    if not session.report_id or not session.image_data_url or session.image_uploaded:
        return False
    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url
        b64, mime = extract_b64_from_data_url(session.image_data_url)
        ok = await upload_media_chunked(session.report_id, b64, "IMAGE", mime)
        if ok:
            session.image_uploaded = True
        return ok
    except Exception as e:
        logger.error(f"Image upload error: {e}")
        return False


async def upload_video_deferred(session: TelegramSession) -> bool:
    """Upload video as a secondary media item — runs after audio+image are done."""
    if not session.report_id or not session.video_data_url:
        return False
    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url
        b64, mime = extract_b64_from_data_url(session.video_data_url)
        logger.info(f"Deferred video upload: {len(b64):,} base64 chars")
        return await upload_media_chunked(session.report_id, b64, "IMAGE", mime)
    except Exception as e:
        logger.warning(f"Deferred video upload error: {e}")
        return False


async def upload_audio(session: TelegramSession) -> bool:
    """Upload audio in progressive chunks to an already-created report."""
    if not session.report_id or not session.audio_data_url or session.audio_uploaded:
        return False
    try:
        from messaging_bot.chunked_uploader import upload_media_chunked, extract_b64_from_data_url
        b64, mime = extract_b64_from_data_url(session.audio_data_url)
        ok = await upload_media_chunked(session.report_id, b64, "AUDIO", mime)
        if ok:
            session.audio_uploaded = True
        return ok
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
            if session.crisis_type:
                payload["crisis_type"] = session.crisis_type
            if session.damage_class:
                payload["damage_classification"] = session.damage_class

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


async def update_report_location(session: TelegramSession) -> bool:
    """PATCH location onto an already-created report (location is last in flow)."""
    if not session.report_id or not session.has_location:
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            loc_data = {
                "latitude": session.latitude,
                "longitude": session.longitude,
                "device_latitude": session.latitude,
                "device_longitude": session.longitude,
                "accuracy_meters": 50.0,
                "device_location_name": session.location_name or None,
            }
            r = await c.patch(
                f"{BACKEND_URL}/api/v1/reports/{session.report_id}/location",
                json=loc_data,
            )
            if r.status_code == 200:
                logger.info(f"Report {session.report_id} location updated")
                return True
            else:
                logger.warning(f"Location update failed ({r.status_code})")
    except Exception as e:
        logger.warning(f"Location update error: {e}")
    return False


async def submit_report(session: TelegramSession) -> Optional[str]:
    """Final submission — await pending uploads, update metadata, return report_id."""
    if not session.report_id:
        await create_report_early(session)
    if session.report_id:
        # Await any fire-and-forget uploads (max 15s)
        import asyncio
        if session.pending_uploads:
            done, _ = await asyncio.wait(session.pending_uploads, timeout=15)
            session.pending_uploads.clear()
        # Safety net: upload any media not yet uploaded
        if session.image_data_url:
            await upload_image(session)
        if session.audio_data_url:
            await upload_audio(session)
        # Update location if not yet sent
        if session.has_location:
            await update_report_location(session)
        await update_report_metadata(session)
        session.submitted_report_id = session.report_id
        session.state = "DONE"
    return session.report_id
