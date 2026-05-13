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
    # 8 UNDP Appendix-1
    # super-types exposed as the canonical chip set. Legacy chip callbacks
    # (type_road / type_hospital / etc.) are still accepted so users on
    # offline-queued pre-v3 buttons don't break — the backend's taxonomy
    # hook normalises them on write.
    "type_residential":            "RESIDENTIAL",
    "type_commercial":             "COMMERCIAL",
    "type_government":             "GOVERNMENT",
    "type_utility":                "UTILITY",
    "type_transport_communication": "TRANSPORT_COMMUNICATION",
    "type_community":              "COMMUNITY",
    "type_public_spaces":          "PUBLIC_SPACES",
    "type_other":                  "OTHER",
    # Legacy (pre-v3) aliases — back-compat with older clients.
    "type_road":     "TRANSPORT_COMMUNICATION",
    "type_hospital": "COMMUNITY",
    "type_house":    "RESIDENTIAL",
    "type_power":    "UTILITY",
    "type_water":    "UTILITY",
    "type_school":   "COMMUNITY",
    "type_telecom":  "UTILITY",
    "type_govt":     "GOVERNMENT",
    # Text-body aliases (user typed the word rather than tapping a button).
    "residential": "RESIDENTIAL", "commercial": "COMMERCIAL",
    "government":  "GOVERNMENT",  "utility":    "UTILITY",
    "transport":   "TRANSPORT_COMMUNICATION", "community": "COMMUNITY",
    "public":      "PUBLIC_SPACES", "other": "OTHER",
    "road": "TRANSPORT_COMMUNICATION", "hospital": "COMMUNITY",
    "house": "RESIDENTIAL", "power": "UTILITY", "water": "UTILITY",
    "school": "COMMUNITY", "telecom": "UTILITY",
}
CRISIS_MAP = {
    # UNDP-canonical taxonomy (CLAUDE.md must-have #5):
    #   EARTHQUAKE / FLOOD / TSUNAMI / CYCLONE (HURRICANE alias)
    #   WILDFIRE / EXPLOSION / CHEMICAL_INCIDENT
    #   CONFLICT / CIVIL_UNREST / OTHER
    # — and nothing else. The backend's `_enforce_undp_taxonomy`
    # validator rejects any other value with 422.
    # Natural
    "crisis_earthquake":         "EARTHQUAKE",
    "crisis_flood":              "FLOOD",
    "crisis_tsunami":            "TSUNAMI",
    "crisis_cyclone":            "CYCLONE",
    "crisis_wildfire":           "WILDFIRE",
    # Technological
    "crisis_explosion":          "EXPLOSION",
    "crisis_chemical_incident":  "CHEMICAL_INCIDENT",
    # Human-made
    "crisis_conflict":           "CONFLICT",
    "crisis_civil_unrest":       "CIVIL_UNREST",
    "crisis_other":              "OTHER",
    # Legacy callbacks retained for back-compat with older Telegram
    # clients whose chat history still contains the old chip ids.
    # Tapping a stale chip from before the May-2026 fix falls back
    # to OTHER (UNDP-valid) instead of the previous LANDSLIDE/
    # PANDEMIC values that the backend would 422-reject. Hurricane
    # remains a CYCLONE alias (synonym, not back-compat).
    "crisis_hurricane":          "CYCLONE",
    "crisis_landslide":          "OTHER",
    "crisis_pandemic":           "OTHER",
}
DAMAGE_MAP = {
    "dmg_none": "MINIMAL",      # UNDP Appendix-1: renamed NO_DAMAGE → MINIMAL
    "dmg_partial": "PARTIAL",
    "dmg_complete": "COMPLETE",
}
DEBRIS_MAP = {
    "debris_yes": True,
    "debris_no":  False,
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
    # native-language building name the reporter
    # types in-chat when asked. Sent to the backend as `infrastructure_name`
    # with `infrastructure_name_from_osm=False` so the dashboard knows it
    # needs to be mapped to an OSM footprint by an operator. Optional — the
    # reporter can skip and the field stays empty.
    infra_name: str = ""
    infra_name_answered: bool = False
    # UX fix — when the reporter taps an Overpass suggestion
    # chip, this holds the `osm:way:<id>` / `osm:relation:<id>` string.
    # Emitted on the meta payload as `building_id` so dashboard pins the
    # report to the exact footprint without needing operator mapping.
    building_id: str = ""
    # debris Yes/No answer.
    # `debris_answered` is the flow gate; `debris_needed` the value.
    # Submitted to the backend as `debris_clearing_needed` (already a
    # column on Report + a field on ReportMetaCreate).
    debris_answered: bool = False
    debris_needed: bool = False
    client_report_id: str = field(default_factory=lambda: str(uuid4()))
    report_id: Optional[str] = None  # set after early creation
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    last_activity: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    message_ids: set = field(default_factory=set)
    # UX fix — Telegram callback_query.id dedupe. Every chip tap
    # fires a callback that the bot answers + acts on. Network lag means
    # the user may tap twice before the first reply paints, so the second
    # callback_query arrives with a fresh id but identical `data`. We
    # dedupe on BOTH: the callback's own id (re-delivery by Telegram) AND
    # a short-lived (data, window) key so accidental double-taps are a
    # no-op. Bounded queue → never grows unbounded.
    callback_ids: set = field(default_factory=set)
    callback_recent_data: list = field(default_factory=list)   # [(data, ts)]
    # BUGFIX May 2026 — stale-message dedupe.
    #
    # The 2-second `(data, ts)` window above caught only rapid double-taps
    # (network-lag → user taps twice). It did NOT catch the operator-
    # reported case: user keeps the bot open in two phone tabs, picks
    # crisis type from the FIRST tab, then days later picks the SAME
    # crisis chip from the SECOND tab's stale inline keyboard. Different
    # cq_id, identical `data`, way outside the 2 s window → handler
    # re-fires, state advances twice.
    #
    # Fix: every time the bot sends a prompt with an inline keyboard,
    # remember its message_id here. A callback arriving on any OTHER
    # message_id is treated as stale and silently dropped (after the
    # answer_callback ack so the user's spinner stops). The active
    # message is also edited to clear its keyboard once a press lands,
    # so the user can't physically tap it again.
    active_prompt_msg_id: Optional[int] = None
    submitted_report_id: Optional[str] = None
    # P3.5 — tracks whether the user has consented to data capture. Flipped
    # true only by the explicit "I consent" callback; all data handlers
    # bail early if false. Persisted across the session lifetime so returning
    # users don't re-consent until /start wipes the session.
    consented: bool = False
    # Cross-channel link to the PWA's anonymous device-hash.
    # Set by handlers._decode_start_token when the user lands on the bot
    # via the PWA's Telegram tile (`/start <32-hex>`). When present,
    # `create_report_early` writes this as `meta["device_hash"]` so the
    # Telegram report clusters with the user's PWA reports.
    pwa_device_hash: Optional[str] = None

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
    # P2.8 — opportunistic stale-session cleanup. A full cleanup runs on the
    # bot's purge worker (see cleanup_stale_sessions) but doing a cheap sweep
    # on each fetch keeps the in-memory dict bounded even if the worker is
    # disabled. Sessions older than 2 hours with no report_id are abandoned
    # drafts; sessions older than 24 h in any state are stale.
    now_ts = datetime.now(timezone.utc).timestamp()
    stale_keys = [
        k for k, s in _sessions.items()
        if (s.state == "DONE" and (now_ts - s.created_at) > 24 * 3600) or
           (not s.report_id and (now_ts - s.created_at) > 2 * 3600)
    ]
    for k in stale_keys:
        _sessions.pop(k, None)
    if stale_keys:
        logger.info(f"[TG] Cleared {len(stale_keys)} stale session(s)")

    if uh not in _sessions or _sessions[uh].state == "DONE":
        _sessions[uh] = TelegramSession(user_hash=uh, chat_id=chat_id)
        logger.info(f"New Telegram session: {uh}")
    return _sessions[uh]


def cleanup_stale_sessions() -> int:
    """Called by a background loop (or tests). Drops sessions that exceeded
    the inactivity cutoffs used above. Returns the count removed."""
    now_ts = datetime.now(timezone.utc).timestamp()
    before = len(_sessions)
    keys_to_drop = [
        k for k, s in _sessions.items()
        if (s.state == "DONE" and (now_ts - s.created_at) > 24 * 3600) or
           (not s.report_id and (now_ts - s.created_at) > 2 * 3600)
    ]
    for k in keys_to_drop:
        _sessions.pop(k, None)
    return before - len(_sessions)


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


def is_duplicate_callback(session: TelegramSession, cq_id: str, data: str, window_seconds: float = 2.0) -> bool:
    """Return True when a callback_query should be ignored as a duplicate.

    Catches two distinct patterns:
      1. Telegram re-delivering the same cq_id (rare but happens under
         poor connectivity → the client retries the answer_callback).
      2. User tapping the same button twice within `window_seconds` because
         of network lag — different cq_id but identical `data`. Without
         this the bot would fire the handler twice, re-submit, etc.

    Keeps the per-session state bounded: callback_ids ring holds the last
    64 ids; callback_recent_data purges entries older than the window.
    """
    import time
    now = time.monotonic()

    # Pattern 1 — cq_id already seen.
    if cq_id and cq_id in session.callback_ids:
        return True
    if cq_id:
        session.callback_ids.add(cq_id)
        if len(session.callback_ids) > 64:
            # Drop the oldest-ish half; set doesn't maintain order, but we
            # don't need strict LRU — just a soft cap.
            session.callback_ids = set(list(session.callback_ids)[-32:])

    # Pattern 2 — same data within the window.
    # Purge entries outside the window first.
    session.callback_recent_data = [
        (d, ts) for (d, ts) in session.callback_recent_data if now - ts < window_seconds
    ]
    for (d, ts) in session.callback_recent_data:
        if d == data:
            return True
    session.callback_recent_data.append((data, now))
    return False


def is_duplicate_message(session: TelegramSession, message_id: int) -> bool:
    if message_id in session.message_ids:
        return True
    session.message_ids.add(message_id)
    return False


def is_stale_callback_message(session: TelegramSession, message_id) -> bool:
    """True when the callback came from an older message whose inline
    keyboard has been superseded by a newer prompt.

    `active_prompt_msg_id` is set every time we send a prompt with an
    inline keyboard (`session_manager._track_prompt_msg` is wired up
    from the `_prompt_for_step` helper). If the click arrives on any
    other message_id, the user has tapped a stale button — drop it.

    Treat the case where `active_prompt_msg_id` is None as "not stale"
    so the very first interaction (no prompt sent yet) still works.
    """
    if session.active_prompt_msg_id is None:
        return False
    if message_id is None:
        return False
    return int(message_id) != int(session.active_prompt_msg_id)


def track_prompt_msg(session: TelegramSession, send_result) -> None:
    """Save the message_id of the latest prompt-with-inline-keyboard.

    `send_result` is what `bot_replies._send` returns — the Telegram
    Bot API response object `{ok, result: {message_id, ...}}`. We grab
    the message_id off `result` and stash it on the session so the
    stale-message dedupe in `_handle_callback` can match against it.

    Best-effort: any unexpected response shape (None, malformed JSON,
    network error) leaves `active_prompt_msg_id` unchanged — the bot
    falls back to the existing (data, 2s window) dedupe.
    """
    if not isinstance(send_result, dict):
        return
    if not send_result.get("ok"):
        return
    result = send_result.get("result") or {}
    msg_id = result.get("message_id")
    if isinstance(msg_id, int):
        session.active_prompt_msg_id = msg_id


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

    # prefer the PWA device-hash when the user landed on the
    # bot via a /start <token> deep-link (see handlers._decode_start_token).
    # This unifies the user's Telegram report with their PWA reports
    # under a single device_hash without any schema change.
    effective_device_hash = (
        session.pwa_device_hash if getattr(session, "pwa_device_hash", None)
        else session.user_hash
    )
    meta = {
        "device_hash": effective_device_hash,
        "client_report_id": session.client_report_id,
        "source": "TELEGRAM",
        "severity": session.severity,
        "infrastructure_type": session.infra_type,
        "description": session.text or None,
        "expected_media": 2,  # assume photo + audio (will adjust)
    }
    # propagate the reporter-typed building name
    # on early-create so the dashboard can render it the instant the row
    # lands. `infrastructure_name_from_osm=False` is the distinguisher that
    # triggers the "needs manual mapping" badge.
    if session.infra_name:
        meta["infrastructure_name"] = session.infra_name
        meta["infrastructure_name_from_osm"] = False
    # UNDP "Other, please specify" rule (report.py:185) — when the
    # Telegram user picked OTHER without typing a name (or skipped the
    # infra-name question entirely), backend rejects with 422. Fall
    # back to a description snippet so the early-create lands; the
    # reporter can refine via /classify or the AI extractor can update.
    if (session.infra_type or "").upper() == "OTHER" and not meta.get("infrastructure_name"):
        snippet = (session.text or "").strip()
        meta["infrastructure_name"] = (
            snippet[:40] if snippet
            else "Reporter did not specify"
        )
        meta["infrastructure_name_from_osm"] = False
    # Telegram UX polish — OSM building pick goes into meta too.
    # When present, the dashboard skips the "needs mapping" badge (the
    # footprint IS the mapping). infrastructure_name_from_osm is TRUE
    # so the needs_manual_mapping derivation treats it as resolved.
    if session.building_id:
        meta["building_id"] = session.building_id
        meta["infrastructure_name_from_osm"] = True
    # debris-clearing answer.
    if session.debris_answered:
        meta["debris_clearing_needed"] = bool(session.debris_needed)

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
            # native-language building name the
            # reporter typed in chat. Always tagged as NOT OSM-authoritative
            # so the dashboard flags these rows for manual mapping.
            if session.infra_name:
                payload["infrastructure_name"] = session.infra_name
                payload["infrastructure_name_from_osm"] = False
            # Telegram UX polish — OSM building pick via the
            # suggestion chips. Overrides the free-text from-osm=False
            # branch above because the pick IS the mapping.
            if session.building_id:
                payload["building_id"] = session.building_id
                payload["infrastructure_name_from_osm"] = True
            # debris answer.
            # Only emitted once the reporter has actually answered; pre-
            # answer the column stays NULL on the backend (distinguishable
            # from explicit False).
            if session.debris_answered:
                payload["debris_clearing_needed"] = bool(session.debris_needed)

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
