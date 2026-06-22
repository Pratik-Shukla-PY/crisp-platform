"""
Telegram Handlers - Zero-friction crisis reporting.

FLOW: Language → Consent → Location → Damage → Infra type → Crisis → Building
      → Debris → Evidence (photo/voice/text) → Done
      (severity is AUTO-DERIVED from the damage answer - no separate prompt)

DESIGN PRINCIPLES:
  1. NO EXTRA BUTTONS: Picking a language immediately starts reporting.
  2. ONE QUESTION AT A TIME: Never send multiple prompts together.
  3. NON-BLOCKING UPLOADS: Photos upload in background (asyncio.create_task).
  4. ACCEPT ANYTHING ANYTIME: Photos, voice, text captured at any step.
  5. AGGRESSIVE EARLY SUBMIT: Report created on first data received.
"""
import asyncio
import logging
import re
from typing import Optional
from .session_manager import (
    get_or_create_session, is_duplicate_message,
    create_report_early, upload_image, upload_extra_images, upload_audio, upload_video_deferred,
    update_report_metadata, update_report_location, delete_report, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP, CRISIS_MAP, DAMAGE_MAP, DEBRIS_MAP, hash_user,
    resolve_location_name, forward_geocode,
    is_duplicate_callback,
    is_stale_callback_message, track_prompt_msg,
)
from .consent_store import (
    has_consented as consent_has,
    grant as consent_grant,
    revoke as consent_revoke,
    get_lang as consent_get_lang,
    set_lang as consent_set_lang,
)
from .media_handler import download_media, download_and_split_video
from .bot_replies import (
    send_welcome, send_step_location, send_step_photo, send_step_photo_first, send_consent_prompt,
    send_step_voice, send_step_severity, send_step_type,
    send_step_crisis_type, send_step_damage_class, send_step_building_name,
    send_step_debris, send_building_suggestions,
    send_step_text, send_step_description, send_confirmation, send_add_more_prompt,
    send_review_card, send_review_fix_menu,
    send_text, answer_callback, edit_reply_markup_clear,
    detect_lang, t,
    send_pack_question, send_pack_other_prompt,
)
from messaging_bot.crisis_forms_client import resolve_active_pack
from messaging_bot.pack_questions import (
    iter_askable_fields, conditional_child, coerce_answer,
    selection_has_other, is_other_option, field_label, option_label, max_count,
)

logger = logging.getLogger(__name__)


# /start <token> decoder.
#
# Telegram bot deep-links can carry a `start` payload (max 64 chars,
# charset [A-Za-z0-9_-]). The CRISP PWA passes its anonymous
# device-hash as the bare 32-hex part of `PWA-<32hex>` so the bot can
# stamp the same hash on the resulting Telegram report → both
# channels' reports cluster under one device_hash. Other recognised
# tags (`crisp_web`, `crisp`) are analytics breadcrumbs only.
_PWA_HASH_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_BENIGN_TOKENS = {"crisp_web", "crisp"}


def _decode_start_token(arg: Optional[str]) -> Optional[str]:
    """Validate a /start <arg> payload and return a usable PWA device-hash.

    Returns the canonical `PWA-<32 lowercase hex>` string when the
    payload is a CRISP device-hash; returns None for benign analytics
    tags or any malformed payload (logged at debug level).
    """
    if not arg:
        return None
    arg = arg.strip()
    if not arg:
        return None
    if arg in _BENIGN_TOKENS:
        return None
    if _PWA_HASH_RE.match(arg):
        return "PWA-" + arg.lower()
    logger.debug("telegram /start payload not recognised: %r", arg[:64])
    return None


def _fire_upload(session, coro):
    """Fire-and-forget an upload coroutine. Tracks task for safety-net await at submit."""
    task = asyncio.create_task(coro)
    session.pending_uploads.append(task)


async def _resolve_pack(session):
    """Resolve the active crisis-form pack at the reporter's GPS location and prepare
    the channel-applicable questions (the 3 UNDP multi-selects). No pack →
    `pack_fields` stays empty and the rapid-intake flow is byte-for-byte unchanged.
    Safe to call again on a corrected pin: a pack change resets pack progress."""
    try:
        pack = await resolve_active_pack(session.latitude, session.longitude)
    except Exception as e:
        logger.warning("[TG] pack resolve failed: %s", e)
        pack = None
    session.pack_resolved = True
    if pack and pack.get("schema_json"):
        if pack.get("pack_id") != session.form_pack_id:
            # new/changed pack → start its questions fresh
            session.pack_index = 0
            session.pack_answers = {}
            session.pack_partial = []
            session.pack_awaiting_other = None
        session.form_pack_id = pack.get("pack_id")
        session.form_pack_version = pack.get("pack_version")
        session.pack_schema = pack.get("schema_json")
        session.pack_fields = iter_askable_fields(pack["schema_json"], "TELEGRAM")
    else:
        # No active pack here → drop any prior pack state (e.g. a corrected pin that
        # left the zone), so nothing is asked or attached.
        session.form_pack_id = None
        session.form_pack_version = None
        session.pack_schema = None
        session.pack_fields = []
        session.pack_index = 0
        session.pack_answers = {}
        session.pack_partial = []
        session.pack_awaiting_other = None


async def _maybe_create_report(session):
    """Create the server report once there is a minimal viable set AND (when a pack
    is active) the pack is complete - so the single /reports/meta POST carries
    form_pack_id/form_data. Fires the deferred media uploads after creation. No-op
    if already created or not yet viable. Idempotent."""
    if session.report_id:
        return
    has_media_or_text = bool(session.image_data_url or session.audio_data_url or session.text)
    if not (has_media_or_text and session.has_location):
        return
    if session.pack_active and not session.pack_complete:
        return   # defer until the UNDP pack questions are answered
    await create_report_early(session)
    if session.report_id:
        # Flush the classify fields captured BEFORE creation (crisis_type, damage,
        # ...). The per-chip /classify PATCHes no-op'd while report_id was None
        # (deferred for the pack), and create_report_early's meta omits crisis_type /
        # damage_classification - so push them now so nothing is lost.
        await update_report_metadata(session)
        if session.image_data_url:
            _fire_upload(session, upload_image(session))
        if session.extra_images:
            _fire_upload(session, upload_extra_images(session))
        if session.audio_data_url:
            _fire_upload(session, upload_audio(session))


_TAP_ONLY_STEPS = {"STEP_DAMAGE_CLASS", "STEP_TYPE", "STEP_CRISIS_TYPE", "STEP_DEBRIS"}

# Phase 4: cap total photos per report to match the PWA's V4_MAX_PHOTOS (3).
_MAX_PHOTOS = 3


def _message_has_capturable(message: dict) -> bool:
    """True if the message carries something _capture_any_media would keep -
    used to decide whether to buffer a pre-consent message for replay (Phase 3)."""
    if any(message.get(k) for k in ("photo", "video", "video_note", "voice", "audio", "location")):
        return True
    txt = (message.get("text") or "").strip()
    return bool(txt) and not txt.startswith("/")


def _message_is_unsupported_media(message: dict) -> bool:
    """True for media types the bot can't ingest as evidence (sticker /
    GIF-animation / contact / poll / dice / a file-Document) - so Phase 3 can
    nudge the reporter instead of silently swallowing what they sent."""
    return any(message.get(k) for k in ("sticker", "animation", "contact", "poll", "dice", "document"))


async def _capture_any_media(session, message: dict):
    """
    Silently capture ANY media/text from the message, regardless of current step.
    Uploads fire-and-forget (never block the next prompt).
    Returns True if something was captured.
    """
    captured = False

    # Photo - Phase 4: accept up to _MAX_PHOTOS (Telegram album OR one-by-one).
    # The FIRST becomes the primary (session.image_data_url); the rest go to
    # session.extra_images and upload as independent ORIGINAL Media rows.
    if message.get("photo"):
        photos = message["photo"]
        file_id = photos[-1].get("file_id")
        total_photos = (1 if session.image_data_url else 0) + len(session.extra_images)
        if file_id and total_photos < _MAX_PHOTOS:
            media = await download_media(file_id)
            if media:
                if not session.image_data_url:
                    session.image_data_url = media["data_url"]
                    if session.report_id:
                        _fire_upload(session, upload_image(session))
                else:
                    session.extra_images.append({"data_url": media["data_url"], "uploaded": False})
                    if session.report_id:
                        _fire_upload(session, upload_extra_images(session))
                captured = True
        elif file_id and total_photos >= _MAX_PHOTOS:
            # Cap reached - acknowledge instead of silently dropping the photo.
            await send_text(session.chat_id, t(session.lang, "photo_cap"))
        if message.get("caption"):
            session.text = (session.text + " " + message["caption"]).strip() if session.text else message["caption"]

    # Video - split into audio (priority) + image (thumbnail) + video (deferred)
    if message.get("video"):
        video = message["video"]
        video_file_id = video.get("file_id")
        thumb_file_id = video.get("thumb", {}).get("file_id") if video.get("thumb") else None

        if video_file_id:
            split = await download_and_split_video(video_file_id, thumb_file_id)

            if split.get("audio") and not session.audio_data_url:
                session.audio_data_url = split["audio"]["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_audio(session))
                captured = True

            if split.get("image") and not session.image_data_url:
                session.image_data_url = split["image"]["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_image(session))
                captured = True

            if split.get("video"):
                session.video_data_url = split["video"]["data_url"]
                captured = True

        if message.get("caption"):
            session.text = (session.text + "\n" + message["caption"]).strip() if session.text else message["caption"]

    # Video note (round video)
    if message.get("video_note"):
        vn = message["video_note"]
        vn_file_id = vn.get("file_id")
        thumb_file_id = vn.get("thumb", {}).get("file_id") if vn.get("thumb") else None

        if vn_file_id:
            split = await download_and_split_video(vn_file_id, thumb_file_id)
            if split.get("audio") and not session.audio_data_url:
                session.audio_data_url = split["audio"]["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_audio(session))
                captured = True
            if split.get("image") and not session.image_data_url:
                session.image_data_url = split["image"]["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_image(session))
                captured = True

    # Voice / Audio
    if (message.get("voice") or message.get("audio")) and not session.audio_data_url:
        voice = message.get("voice") or message.get("audio")
        file_id = voice.get("file_id")
        if file_id:
            media = await download_media(file_id)
            if media:
                session.audio_data_url = media["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_audio(session))
                captured = True

    # Location (can update even if already set - user might correct it)
    if message.get("location"):
        session.latitude = float(message["location"]["latitude"])
        session.longitude = float(message["location"]["longitude"])
        captured = True

    # Text - always accumulate (never reject text from a person in crisis)
    text = message.get("text", "").strip()
    if text and not text.startswith("/") and session.pack_awaiting_other:
        # UNDP "Other, please specify" follow-up → the conditional pack field
        # (pressing_needs_other), NOT the description. Intercepted FIRST so a
        # free-text need is never mis-captured as severity/type or appended to text.
        # The parent question (with its Other detail) is now fully answered → advance.
        session.pack_answers[session.pack_awaiting_other] = text[:200].strip()
        session.pack_awaiting_other = None
        session.pack_index += 1
        captured = True
    elif text and not text.startswith("/"):
        sev = SEVERITY_MAP.get(text.lower()) or SEVERITY_MAP.get(text)
        itype = TYPE_MAP.get(text.lower()) or TYPE_MAP.get(text)
        if sev and session.severity == "UNKNOWN":
            session.severity = sev
            session.severity_answered = True
            captured = True
        elif itype and session.infra_type == "OTHER":
            session.infra_type = itype
            session.type_answered = True
            captured = True
        elif session.state == "STEP_BUILDING_NAME" and not session.infra_name_answered:
            # native-language building name. Cap at
            # 120 chars to match backend `infrastructure_name` column width.
            # Never overwritten by subsequent messages - once answered, subsequent
            # text falls through to the description slot below.
            session.infra_name = text[:120].strip()
            session.infra_name_answered = True
            captured = True
        else:
            session.text = (session.text + "\n" + text).strip() if session.text else text
            captured = True

    # Push metadata to backend immediately
    if captured and session.report_id:
        await update_report_metadata(session)

    return captured


def _next_missing_step(session) -> str:
    """Flow: Photo → Description → Type → Crisis → Damage → Severity → Location → READY

    Photo is INTENTIONALLY soft on Telegram (unlike the PWA + RN apps which
    hard-require a photo). Text/voice-first users - e.g. reporters on feature
    phones via SMS/IVR-class channels - must still be able to file a report
    even if they can't attach a photo.
    """
    # question sequence reordered to match the
    # PWA's 8-stage capture flow:
    #
    #   1 Evidence (photo / voice / text)     → STEP_PHOTO
    #   2 Where (location) + damage level     → STEP_LOCATION, STEP_DAMAGE_CLASS
    #   3 Infrastructure type                 → STEP_TYPE
    #   4 Crisis type + native-language name  → STEP_CRISIS_TYPE, STEP_BUILDING_NAME
    #   5 Severity (pressing needs are TG-optional; skipped)
    #                                          → STEP_SEVERITY
    #   6 Audio + text description            → STEP_DESCRIPTION
    #   → READY
    #
    # Rationale: the conversational flow already defers evidence to whenever
    # the user sends it (see `_capture_any_media`), so PHOTO stays first as
    # a prompt rather than a gate. Location now precedes classification so
    # the reporter's working memory of WHERE matches the PWA's stage-where
    # kickoff. Description is asked LAST because most Telegram users
    # include a caption with their first media - by the time we reach
    # STEP_DESCRIPTION `session.text` is almost always populated, and we
    # skip to READY.
    # UX fix - match the PWA/RN 8-stage capture-flow sequence
    # exactly so evaluators comparing channels see the same order:
    #
    #   1 home           ← handled by /start + consent
    #   2 where+damage   → STEP_LOCATION, STEP_DAMAGE_CLASS
    #   3 infra          → STEP_TYPE
    #   4 crisis + name  → STEP_CRISIS_TYPE, STEP_BUILDING_NAME
    #   5 extras         → STEP_DEBRIS, STEP_SEVERITY  (service + needs
    #                     skipped on Telegram for brevity - low-friction)
    #   6+7 evidence     → STEP_PHOTO (accepts photo OR voice OR text)
    #   8 submit         → READY
    #
    # Evidence (photo/voice/text) comes LAST so the reporter's working
    # memory of the scene drives the structured metadata first, while
    # the descriptive capture closes the flow. This is the reverse of
    # the old Telegram ordering but mirrors the field-app sequence.
    if not session.has_location:
        return "STEP_LOCATION"
    if not session.damage_class:
        return "STEP_DAMAGE_CLASS"
    if not session.type_answered:
        return "STEP_TYPE"
    if not session.crisis_type:
        return "STEP_CRISIS_TYPE"
    if not session.infra_name_answered:
        return "STEP_BUILDING_NAME"
    if not session.debris_answered:
        return "STEP_DEBRIS"
    # Dynamic crisis-form pack (UNDP Appendix-1 questions) - asked just before
    # review when an active pack covers the reporter's location. pack_fields is
    # empty when no pack applies → skipped entirely (rapid-intake unchanged).
    if session.pack_active and not session.pack_complete:
        return "STEP_PACK"
    # Phase 0: removed the dead STEP_SEVERITY step. Severity is AUTO-DERIVED
    # from the damage chip in the dmg_ callback (MINIMAL→MINOR / PARTIAL→
    # MODERATE / COMPLETE→SEVERE), so severity_answered is already True by the
    # time the flow reached here - the prompt was never shown and its chips
    # duplicated the damage chips. The PWA likewise omits a severity question.
    # Evidence - accepts any of photo, voice, or text. The STEP_PHOTO
    # prompt explicitly invites all three so users aren't forced into
    # a media type they can't produce (feature phones can type; voice-
    # only speakers can record).
    if not session.image_data_url and not session.audio_data_url and not session.text:
        return "STEP_PHOTO"
    return "READY"


async def _prompt_for_step(session, chat_id: int, step: str):
    """Send the appropriate prompt for the given step.

    Captures the sent message's `message_id` onto the session via
    `track_prompt_msg` so the stale-message dedupe in `_handle_callback`
    can reject button presses from older messages. This is the
    operator-reported "open the bot in two tabs and tap from the stale
    one" defence. Each `send_*` helper returns the Telegram Bot API
    response; `track_prompt_msg` is a best-effort write - bad responses
    leave `active_prompt_msg_id` alone and the dedupe falls back to the
    existing 2-second-window `is_duplicate_callback`.
    """
    lang = session.lang
    result = None
    if step == "STEP_PHOTO":
        result = await send_step_photo_first(chat_id, lang)
    elif step == "STEP_DESCRIPTION":
        result = await send_step_description(chat_id, lang)
    elif step == "STEP_TYPE":
        result = await send_step_type(chat_id, lang)
    elif step == "STEP_CRISIS_TYPE":
        result = await send_step_crisis_type(chat_id, lang)
    elif step == "STEP_DAMAGE_CLASS":
        result = await send_step_damage_class(chat_id, lang)
    elif step == "STEP_SEVERITY":
        result = await send_step_severity(chat_id, lang)
    elif step == "STEP_BUILDING_NAME":
        # UX fix - if we have GPS, try to offer nearby OSM
        # buildings as tap-to-pick chips first. Reporter taps one → done.
        # Timeout/empty-result falls through to the free-text prompt.
        picked = False
        if session.has_location:
            try:
                from .building_lookup import nearby_buildings
                suggestions = await nearby_buildings(session.latitude, session.longitude, limit=5)
                if suggestions:
                    result = await send_building_suggestions(chat_id, lang, suggestions)
                    picked = True
            except Exception:
                picked = False
        if not picked:
            result = await send_step_building_name(chat_id, lang)
    elif step == "STEP_DEBRIS":
        result = await send_step_debris(chat_id, lang)
    elif step == "STEP_LOCATION":
        result = await send_step_location(chat_id, lang)
    elif step == "STEP_PACK":
        # If we're waiting on an "Other, please specify" free-text, prompt that;
        # otherwise render the current multi-select question's inline keyboard.
        if session.pack_awaiting_other:
            result = await send_pack_other_prompt(chat_id, lang)
        elif session.pack_index < len(session.pack_fields):
            result = await send_pack_question(
                chat_id, lang, session.pack_fields[session.pack_index],
                session.pack_index, session.pack_partial)
    if result is not None:
        track_prompt_msg(session, result)


async def handle_update(update: dict):
    if "callback_query" in update:
        await _handle_callback(update["callback_query"])
        return

    message = update.get("message")
    if not message:
        return

    user = message.get("from", {})
    user_id = user.get("id")
    chat_id = message.get("chat", {}).get("id")
    msg_id = message.get("message_id", 0)
    if not user_id or not chat_id:
        return

    session = get_or_create_session(user_id, chat_id)
    if msg_id and is_duplicate_message(session, msg_id):
        return
    session.touch()

    detected = detect_lang(user)
    if not session.lang:
        session.lang = detected
    text = message.get("text", "").strip()

    # /start always resets - show language picker.
    # also accept an optional payload (`/start <token>`).
    # Telegram delivers t.me/<bot>?start=foo as the message text
    # "/start foo". When the payload is a 32-hex PWA device-hash we
    # stamp it on the session so the eventual Report row carries the
    # same device_hash as the PWA's reports (cross-channel link).
    if text.startswith("/start"):
        parts = text.split(maxsplit=1)
        start_arg = parts[1].strip() if len(parts) == 2 else None
        decoded_pwa_hash = _decode_start_token(start_arg)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        # BUGFIX May 2026 (operator-reported) - pre-fix this was an
        # unconditional `s.lang = detected`, which reverted any
        # previously-picked language back to the Telegram-locale
        # default on every `/start`. The user's pick is persisted to
        # `consent_store.lang` (via `consent_set_lang` from the
        # lang-picker callback below + `consent_grant` at consent
        # time) - read it back here to restore their choice across
        # session resets.
        s.lang = consent_get_lang(user_id) or detected
        if decoded_pwa_hash:
            s.pwa_device_hash = decoded_pwa_hash
            logger.info(
                "telegram /start linked to PWA device-hash (chat_id=%s)",
                chat_id,
            )
        # Phase 1: no forced 9-chip language picker on first contact - language
        # is auto-detected (above) and switchable from the consent card's
        # "Change language" affordance. A returning consented reporter (consent
        # hydrated from the store) jumps straight into the flow.
        if not s.consented and consent_has(user_id):
            s.consented = True
        if s.consented:
            s.state = _next_missing_step(s)
            await _prompt_for_step(s, chat_id, s.state)
        else:
            s.state = "AWAIT_CONSENT"
            track_prompt_msg(s, await send_consent_prompt(chat_id, s.lang))
        return

    # /delete - right to erasure (must-have #10). Drop the in-progress report,
    # REVOKE the persisted consent so the reporter must re-consent before
    # filing anything new, then reset the session. (Previously /delete behaved
    # exactly like /cancel and left the consent row on disk - the consent_store
    # revoke() was documented as wired here but never actually called.)
    # consent_get_lang now returns None (row gone) → fall back to detected.
    if text.startswith("/delete"):
        if session.report_id:
            await delete_report(session)
        consent_revoke(user_id)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        s.state = "LANG_SELECT"
        await send_text(chat_id, "🗑 " + t(s.lang, "deleted_ack"))
        track_prompt_msg(s, await send_welcome(chat_id, s.lang))
        return

    # /cancel - abort the current report but KEEP consent, so cancelling
    # doesn't force the consent card again on the next report.
    if text.startswith("/cancel"):
        if session.report_id:
            await delete_report(session)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        # Same restore-from-store pattern as /start above.
        s.lang = consent_get_lang(user_id) or detected
        s.state = "LANG_SELECT"
        track_prompt_msg(s, await send_welcome(chat_id, s.lang))
        return

    # Phase 1: a first/idle-session message no longer forces the 9-chip
    # language picker - language is auto-detected above. Route straight to the
    # localized consent card (new reporter) or the next missing step (returning
    # reporter, consent hydrated from the store).
    if session.state in ("START", "DONE", "LANG_SELECT"):
        if not session.consented and consent_has(user_id):
            session.consented = True
        if session.consented:
            session.state = _next_missing_step(session)
            await _prompt_for_step(session, chat_id, session.state)
        else:
            session.state = "AWAIT_CONSENT"
            track_prompt_msg(session, await send_consent_prompt(chat_id, session.lang))
        return

    # P3.5 - Consent-gate: if waiting on consent (or never consented), any
    # inbound text/media is ignored and the consent card is re-shown. No
    # side-effect captures, no DB writes.
    # Apr-2026: hydrate from persisted consent store first so a returning
    # reporter is treated as already-consented even on a fresh session.
    if not session.consented and consent_has(user_id):
        session.consented = True
    if session.state == "AWAIT_CONSENT" or not session.consented:
        # Phase 3: buffer a cold "X-first" message (photo / location pin / a few
        # words sent before the consent tap) so it's replayed after consent
        # instead of silently dropped - an impatient reporter never loses input.
        if _message_has_capturable(message):
            session.pending_message = message
        track_prompt_msg(session, await send_consent_prompt(chat_id, session.lang))
        return

    # ADD_MORE state - user is adding details to an already-submitted report
    if session.state == "ADD_MORE" and session.report_id:
        await _capture_any_media(session, message)
        await send_text(chat_id, "✅ " + t(session.lang, "add_more_done") + "\n\n📎 Send more, or tap Done 👇")
        return

    # ── CAPTURE everything first, regardless of step ──
    had_location_before = session.has_location
    prev_lat, prev_lng = session.latitude, session.longitude
    had_evidence_before = session.has_evidence
    captured = await _capture_any_media(session, message)

    # Resolve the place name when a pin is first received OR re-shared (a
    # corrected pin). On a re-share the EDITED location is authoritative:
    # update_report_location asks the backend to re-derive the owning operation
    # from the new coords (reresolve_operation), and we confirm the re-match.
    loc_is_new = session.has_location and not had_location_before
    loc_changed = (session.has_location and had_location_before
                   and (session.latitude != prev_lat or session.longitude != prev_lng))
    if loc_is_new or loc_changed:
        await resolve_location_name(session)
        # Resolve the active crisis-form pack at this location so the bot can ask the
        # UNDP questions (the 3 multi-selects) before submitting. No active pack →
        # pack_fields stays empty and nothing changes. Re-resolve on a corrected pin.
        if not session.pack_resolved or loc_changed:
            await _resolve_pack(session)
        if session.report_id:
            await update_report_location(session)
            if loc_changed:
                await send_text(chat_id, t(session.lang, "loc_updated_reresolved"))

    # Phase 2: forward-geocode a typed place name when there's no GPS pin yet
    # and we're on the location step. Lets desktop / GPS-denied reporters set a
    # location by typing instead of being stuck on the mobile-only button (the
    # old #1 blocker). Sets a coarse accuracy + low geocoding_confidence so the
    # dashboard isn't misled into trusting it as a precise fix.
    if (not session.has_location and session.state == "STEP_LOCATION"
            and text and not text.startswith("/")):
        geo = await forward_geocode(text)
        if geo:
            session.latitude, session.longitude, session.location_name = geo
            session.geocoding_source = "telegram_forward_geocode"
            session.geocoding_confidence = 0.3   # low - typed place name
            await send_text(chat_id, "📍 " + (session.location_name or t(session.lang, "step_loc_done")))
            if session.report_id:
                await update_report_location(session)

    # P2.8 - Defer server-side report creation until the session has a minimal
    # viable set of fields (photo OR audio, plus location or explicit text), AND -
    # when an active crisis pack covers the location - until the UNDP pack questions
    # are answered, so the single /reports/meta POST carries form_pack_id/form_data.
    # The previous "aggressive early submit on any data" created partial rows that
    # stranded in the DB. Media upload stays fire-and-forget after creation.
    await _maybe_create_report(session)

    # ── Instant acknowledgment if new evidence just captured ──
    if not had_evidence_before and session.has_evidence:
        if session.image_data_url:
            await send_text(chat_id, t(session.lang, "photo_ack"))
        elif session.audio_data_url:
            await send_text(chat_id, t(session.lang, "desc_ack"))

    # ── Advance to next step ──
    next_step = _next_missing_step(session)

    if next_step == "READY":
        await _finalize(session)
    elif session.state != next_step:
        # Step changed - send the new prompt
        session.state = next_step
        await _prompt_for_step(session, chat_id, next_step)
    else:
        # Same step - no advance. Phase 3: don't leave the user in silence.
        if not captured and _message_is_unsupported_media(message):
            # Sticker / GIF / file-Document / contact - acknowledge instead of
            # silently swallowing what looked (to the user) like evidence.
            await send_text(chat_id, t(session.lang, "unsupported_media"))
        elif (text and not text.startswith("/") and session.state in _TAP_ONLY_STEPS):
            # Stray text typed on a tap-only step - re-send the current prompt
            # so the user knows to tap a button (their text is still kept on
            # the description by _capture_any_media above).
            await _prompt_for_step(session, chat_id, session.state)
        # else: bonus data on a non-tap step (e.g. extra photo) - no re-prompt


async def _handle_callback(callback_query: dict):
    user = callback_query.get("from", {})
    user_id = user.get("id")
    msg = callback_query.get("message", {}) or {}
    chat_id = msg.get("chat", {}).get("id")
    callback_msg_id = msg.get("message_id")
    data = callback_query.get("data", "")
    cq_id = callback_query.get("id", "")
    if not user_id or not chat_id:
        return

    session = get_or_create_session(user_id, chat_id)
    session.touch()
    detected = detect_lang(user)
    if not session.lang:
        session.lang = detected
    lang = session.lang

    # BUGFIX May 2026 - stale-message dedupe (operator-reported).
    #
    # Scenario: user opens the bot in two phone tabs. They pick the
    # crisis type from tab A - state advances, a new prompt is sent.
    # They scroll up in tab B (or come back hours later) and tap the
    # same crisis chip on the OLD inline keyboard. Different cq_id,
    # identical `data`, way outside the 2 s `is_duplicate_callback`
    # window → handler used to re-fire and state advanced again.
    #
    # `is_stale_callback_message` compares the callback's message_id
    # against the last prompt-with-keyboard we sent. Mismatch = stale.
    # Ack the press (clear the user's spinner) and silently drop. As
    # an additional defence, clear the inline keyboard on the stale
    # message so it physically can't be tapped again.
    if is_stale_callback_message(session, callback_msg_id):
        try:
            await answer_callback(cq_id)
        except Exception:
            pass
        try:
            await edit_reply_markup_clear(chat_id, callback_msg_id)
        except Exception:
            pass
        logger.info(
            f"telegram callback dropped - stale message {callback_msg_id} "
            f"vs active {session.active_prompt_msg_id} (data={data})"
        )
        return

    # UX fix - multi-tap debounce. Users tap a chip, see nothing
    # for 500-800 ms while the backend roundtrip runs, tap again in
    # frustration. Without this guard the second callback fires the
    # same handler (crisis_type clicked twice → re-sends the next-step
    # prompt twice). Ack-and-drop duplicates silently.
    if is_duplicate_callback(session, cq_id, data):
        try:
            await answer_callback(cq_id)
        except Exception:
            pass
        return

    # The callback has been accepted as fresh - clear the inline
    # keyboard on the *active* prompt so the user can't physically
    # tap the same button again from this message. The next prompt
    # (sent below by `_prompt_for_step`) becomes the new active one.
    try:
        if session.active_prompt_msg_id is not None:
            await edit_reply_markup_clear(chat_id, session.active_prompt_msg_id)
    except Exception:
        pass

    # P3.5 - Language selection routes through consent before any data is
    # captured. Apr-2026 fix: consent is persisted to SQLite keyed by
    # `user_id`, so a returning reporter skips the consent card entirely.
    # In-memory `session.consented` is mirrored from the store on first
    # lookup so the rest of the flow keeps working unchanged.
    # Phase 1: explicit "Change language" affordance - shows the 9-chip grid
    # on demand (the grid is no longer a forced first step). After a pick the
    # lang_ handler below re-shows the localized consent card if not yet
    # consented, else re-prompts the current step in the new language.
    if data == "change_lang":
        await answer_callback(cq_id)
        track_prompt_msg(session, await send_welcome(chat_id, session.lang))
        return

    if data.startswith("lang_"):
        new_lang = data.replace("lang_", "")
        session.lang = new_lang
        await answer_callback(cq_id, f"Language: {new_lang.upper()}")
        # Hydrate from the consent store - asked once, remembered forever.
        if not session.consented and consent_has(user_id):
            session.consented = True
        # BUGFIX May 2026 (operator-reported) - persist the user's pick
        # to the consent_store so `/start` (which calls clear_session)
        # can restore it instead of reverting to the Telegram-locale
        # default. UPDATE-only on the store row: only takes effect
        # AFTER the user consents (when grant() creates the row with
        # their then-current session.lang). Pre-consent picks survive
        # via session.lang alone, which is fine for the unbroken flow.
        try:
            if session.consented:
                consent_set_lang(user_id, new_lang)
        except Exception:
            pass
        if session.consented:
            session.state = _next_missing_step(session)
            await _prompt_for_step(session, chat_id, session.state)
        else:
            session.state = "AWAIT_CONSENT"
            track_prompt_msg(session, await send_consent_prompt(chat_id, new_lang))
        return

    # User accepted the consent card - proceed to reporting flow.
    if data == "consent_accept":
        session.consented = True
        consent_grant(user_id, session.lang)     # persist → never re-ask
        await answer_callback(cq_id, "Thanks!")
        # Phase 3: replay any pre-consent message we buffered so the reporter's
        # first action (photo / pin / words sent before this tap) is captured
        # rather than lost. Mirrors handle_update's capture + create path.
        if session.pending_message:
            pending = session.pending_message
            session.pending_message = None
            had_loc = session.has_location
            await _capture_any_media(session, pending)
            if session.has_location and not had_loc:
                await resolve_location_name(session)
                # Resolve the active pack here too so a pre-consent location still
                # gets the UNDP questions; _maybe_create_report then defers the
                # create until they're answered (pack-region) or creates now (no pack).
                await _resolve_pack(session)
            await _maybe_create_report(session)
            if session.has_evidence:
                await send_text(
                    chat_id,
                    t(session.lang, "photo_ack") if session.image_data_url
                    else t(session.lang, "desc_ack"),
                )
        # Jump straight to the NEXT missing step (usually STEP_LOCATION in
        # the Apr-2026 reorder). Previously always landed on STEP_PHOTO.
        session.state = _next_missing_step(session)
        await _prompt_for_step(session, chat_id, session.state)
        return

    # User declined - wipe session and bid farewell. Nothing captured so
    # nothing to delete.
    if data == "consent_decline":
        await answer_callback(cq_id)
        await send_text(
            chat_id,
            "🙏 " + (t(session.lang, "consent_declined")
                    or "Understood - no data collected. Send /start anytime to try again.")
        )
        clear_session(user_id)
        return

    # Phase 5 - pre-submit review card.
    # ✅ Send: confirm the review and commit. The idempotent latch in
    # _finalize makes a double-tap a no-op.
    if data == "review_send":
        await answer_callback(cq_id)
        session.reviewed = True
        await _finalize(session)
        return

    # ✏️ Fix: open the field-edit menu (review gate stays closed).
    if data == "review_fix":
        await answer_callback(cq_id)
        track_prompt_msg(session, await send_review_fix_menu(chat_id, lang))
        return

    # ⬅ Back to review (from the Fix menu) → re-show the card unchanged.
    if data == "review_back":
        await answer_callback(cq_id)
        session.state = "REVIEW"
        track_prompt_msg(session, await send_review_card(chat_id, lang, _review_summary(session)))
        return

    # Fix a specific field → clear its answered flag, reset the review gate,
    # and re-open that field's existing prompt. After the user re-answers, the
    # normal advance lands back on the review card (reviewed is now False).
    if data.startswith("fix:"):
        field = data.split(":", 1)[1]
        spec = _FIX_FIELDS.get(field)
        if spec:
            clear_fn, step = spec
            clear_fn(session)
            session.reviewed = False
            session.state = step
            await answer_callback(cq_id)
            await _prompt_for_step(session, chat_id, step)
        else:
            await answer_callback(cq_id)
        return

    # Start / Report Another → carry consent across the session reset so
    # the reporter isn't re-prompted between reports.
    if data == "start_report":
        persisted_consent = session.consented or consent_has(user_id)
        # Capture the current language BEFORE clear_session wipes it.
        # Prefer the in-memory pick (most recent), fall back to the
        # consent_store (across-restart durability), then geo-detected.
        carried_lang = session.lang or consent_get_lang(user_id) or detected
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = carried_lang
        s.consented = persisted_consent
        if s.consented:
            s.state = _next_missing_step(s)
            await answer_callback(cq_id)
            await _prompt_for_step(s, chat_id, s.state)
        else:
            s.state = "AWAIT_CONSENT"
            await answer_callback(cq_id)
            track_prompt_msg(s, await send_consent_prompt(chat_id, s.lang))
        return

    if data == "stop":
        await answer_callback(cq_id)
        await send_text(chat_id, "🙏 " + t(lang, "done_stop"))
        clear_session(user_id)
        return

    # Add more details to the last submitted report
    if data.startswith("add_more:"):
        report_id = data.split(":", 1)[1]
        session.report_id = report_id
        session.state = "ADD_MORE"
        await answer_callback(cq_id)
        track_prompt_msg(session, await send_add_more_prompt(chat_id, lang))
        return

    if data == "add_more_done":
        await answer_callback(cq_id)
        await send_text(chat_id, "✅ " + t(lang, "add_more_done"))
        session.state = "DONE"
        return

    if data == "cancel_report":
        if session.report_id:
            await delete_report(session)
        await answer_callback(cq_id)
        # Preserve the user's pick - see the /start handler in
        # _handle_text for the same restore pattern.
        carried_lang = session.lang or consent_get_lang(user_id) or detected
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = carried_lang
        s.state = "LANG_SELECT"
        track_prompt_msg(s, await send_welcome(chat_id, s.lang))
        return

    # ── Skip photo → go to description ──
    if data == "skip_photo":
        session.state = "STEP_DESCRIPTION"
        await answer_callback(cq_id)
        # BUGFIX May 2026 - track this prompt's message_id on the session
        # so the stale-message dedupe at the top of _handle_callback
        # doesn't silently DROP the next callback as "stale". Pre-fix,
        # this `send_step_description` was untracked → active_prompt_msg_id
        # still pointed at the previous (STEP_PHOTO) prompt → every
        # callback on the description prompt was rejected → user saw
        # the same screen and tapped repeatedly, looking like the bot
        # was repeating the same message at them.
        track_prompt_msg(session, await send_step_description(chat_id, lang))
        return

    # ── Skip description → advance to type ──
    if data == "skip_description":
        await answer_callback(cq_id)
        next_step = _next_missing_step(session)
        session.state = next_step
        if next_step == "READY":
            await _finalize(session)
        else:
            await _prompt_for_step(session, chat_id, next_step)
        return

    # Skip text / submit now
    if data == "skip_text":
        await answer_callback(cq_id)
        await _finalize(session)
        return

    # ── Telegram UX - OSM building pick: `bldg:osm:way:<id>`
    # (or `bldg:osm:relation:<id>`). Resolves directly to session.building_id
    # + mirrors the OSM name into `infra_name` via update_report_metadata.
    if data.startswith("bldg:osm:"):
        osm_id = data[len("bldg:"):]
        session.building_id = osm_id
        session.infra_name_answered = True
        await update_report_metadata(session)
        await answer_callback(cq_id, "✓")
        next_step = _next_missing_step(session)
        session.state = next_step
        if next_step == "READY":
            await _finalize(session)
        else:
            await _prompt_for_step(session, chat_id, next_step)
        return

    # User prefers to type the name freehand. Show the free-text prompt.
    if data == "bldg_type":
        await answer_callback(cq_id)
        # BUGFIX May 2026 - track this prompt's message_id (same reason
        # as the skip_photo branch above). Without this, the user's
        # next text reply / button tap on the free-text building prompt
        # would be dropped as stale by is_stale_callback_message.
        track_prompt_msg(session, await send_step_building_name(chat_id, session.lang or detected))
        return

    # ── - skip the native-language building prompt.
    # The reporter chose not to name the building. Mark the slot answered so
    # `_next_missing_step` advances; `infra_name` stays empty.
    if data == "skip_building":
        await answer_callback(cq_id)
        session.infra_name_answered = True
        next_step = _next_missing_step(session)
        session.state = next_step
        if next_step == "READY":
            await _finalize(session)
        else:
            await _prompt_for_step(session, chat_id, next_step)
        return

    # ── - debris Yes/No.
    # Tapping either flips `debris_answered=True` and records the value
    # on `debris_needed`; the flow then advances to the next missing step.
    if data in DEBRIS_MAP:
        session.debris_needed = DEBRIS_MAP[data]
        session.debris_answered = True
        await update_report_metadata(session)
        await answer_callback(cq_id)
        next_step = _next_missing_step(session)
        session.state = next_step
        if next_step == "READY":
            await _finalize(session)
        else:
            await _prompt_for_step(session, chat_id, next_step)
        return

    # - grouped crisis keyboard renders "- GROUP -" separator
    # buttons for visual clarity. They carry a `noop_group_*` callback
    # that silently ACKs the tap so the user doesn't see a spinner.
    if data.startswith("noop_"):
        await answer_callback(cq_id)
        return

    # ── Type buttons ──
    if data.startswith("type_"):
        itype = TYPE_MAP.get(data)
        if itype:
            session.infra_type = itype
            session.type_answered = True
            await update_report_metadata(session)
            await answer_callback(cq_id)
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                await _finalize(session)
            else:
                await _prompt_for_step(session, chat_id, next_step)
        return

    # ── Severity buttons ──
    if data.startswith("sev_"):
        sev = SEVERITY_MAP.get(data)
        if sev:
            session.severity = sev
            session.severity_answered = True
            await update_report_metadata(session)
            await answer_callback(cq_id)
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                await _finalize(session)
            else:
                await _prompt_for_step(session, chat_id, next_step)
        return

    # ── Crisis type buttons ──
    if data.startswith("crisis_"):
        ct = CRISIS_MAP.get(data)
        if ct:
            session.crisis_type = ct
            await update_report_metadata(session)
            await answer_callback(cq_id)
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                await _finalize(session)
            else:
                await _prompt_for_step(session, chat_id, next_step)
        return

    # ── Damage classification buttons ──
    # UX parity with PWA - severity is auto-derived from damage:
    # MINIMAL→MINOR, PARTIAL→MODERATE, COMPLETE→SEVERE. Saves one chip
    # step and matches what the PWA / RN flows do. Reporters can still
    # override on the severity prompt if we ever keep it in the future.
    if data.startswith("dmg_"):
        dc = DAMAGE_MAP.get(data)
        if dc:
            session.damage_class = dc
            derive = {"MINIMAL": "MINOR", "PARTIAL": "MODERATE",
                      "COMPLETE": "SEVERE", "NO_DAMAGE": "MINOR", "DESTROYED": "SEVERE"}
            derived = derive.get(dc)
            if derived and session.severity == "UNKNOWN":
                session.severity = derived
                session.severity_answered = True
            await update_report_metadata(session)
            await answer_callback(cq_id)
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                await _finalize(session)
            else:
                await _prompt_for_step(session, chat_id, next_step)
        return

    # ── Crisis-form pack: multi-select toggle (UNDP questions) ──
    # ps:{field_idx}:{opt_idx} → toggle the option in the running selection and
    # re-render the SAME question keyboard (✓ marks). Does NOT advance the flow.
    if data.startswith("ps:"):
        parts = data.split(":")
        try:
            fi, oi = int(parts[1]), int(parts[2])
        except (IndexError, ValueError):
            await answer_callback(cq_id)
            return
        if 0 <= fi < len(session.pack_fields) and fi == session.pack_index and not session.pack_awaiting_other:
            field = session.pack_fields[fi]
            opts = field.get("options") or []
            if 0 <= oi < len(opts):
                val = opts[oi].get("value")
                if val in session.pack_partial:
                    session.pack_partial.remove(val)
                else:
                    mc = max_count(field)
                    if mc and len(session.pack_partial) >= mc:
                        await answer_callback(cq_id, t(lang, "pack_done"))   # at cap → finish
                        return
                    session.pack_partial.append(val)
                result = await send_pack_question(chat_id, lang, field, fi, session.pack_partial)
                if result is not None:
                    track_prompt_msg(session, result)
        await answer_callback(cq_id)
        return

    # ── Crisis-form pack: finish a multi-select question ──
    # ps_done:{field_idx} → commit the selection, run the "Other" follow-up if
    # picked, else advance; when the pack completes, create the (deferred) report
    # so the meta POST carries form_pack_id/form_data, then go to review.
    if data.startswith("ps_done:"):
        await answer_callback(cq_id)
        try:
            fi = int(data.split(":", 1)[1])
        except (IndexError, ValueError):
            return
        if not (0 <= fi < len(session.pack_fields) and fi == session.pack_index):
            return
        field = session.pack_fields[fi]
        session.pack_answers[field["key"]] = coerce_answer(field, list(session.pack_partial))
        child = conditional_child(session.pack_schema, field["key"], "TELEGRAM")
        ask_other = child is not None and selection_has_other(field, session.pack_partial)
        session.pack_partial = []
        if ask_other:
            session.pack_awaiting_other = child["key"]
            session.state = "STEP_PACK"
            await _prompt_for_step(session, chat_id, "STEP_PACK")
            return
        session.pack_index += 1
        await _maybe_create_report(session)
        next_step = _next_missing_step(session)
        session.state = next_step
        if next_step == "READY":
            await _finalize(session)
        else:
            await _prompt_for_step(session, chat_id, next_step)
        return

    await answer_callback(cq_id)


def _review_summary(session) -> str:
    """Phase 5 - build the pre-submit review card body: one line per captured
    field (localized label : the reporter's own pick). Skips empty fields.
    Crisis/type/damage values are the canonical enums the reporter chose
    (readable: EARTHQUAKE / RESIDENTIAL / COMPLETE); localizing the VALUE
    labels is deferred to the i18n cleanup pass."""
    lang = session.lang
    lines = []
    if session.crisis_type:
        lines.append(f"🆘 *{t(lang, 'review_crisis')}:* {session.crisis_type}")
    if session.damage_class:
        lines.append(f"🏚 *{t(lang, 'review_damage')}:* {session.damage_class}")
    if session.type_answered and session.infra_type:
        lines.append(f"🏢 *{t(lang, 'review_type')}:* {session.infra_type}")
    if session.infra_name:
        lines.append(f"🏗 *{t(lang, 'review_building')}:* {session.infra_name}")
    loc = session.location_name or (
        f"{session.latitude:.4f}, {session.longitude:.4f}" if session.has_location else "")
    if loc:
        lines.append(f"📍 *{t(lang, 'review_location')}:* {loc}")
    if session.debris_answered:
        if session.debris_needed is True:
            dtxt = t(lang, "debris_yes")
        elif session.debris_needed is False:
            dtxt = t(lang, "debris_no")
        else:
            dtxt = t(lang, "debris_na")
        lines.append(f"🚜 *{t(lang, 'review_debris')}:* {dtxt}")
    # Crisis-pack answers (UNDP Appendix-1) - question label + selected option
    # labels, localized via the pack's own label_i18n.
    for f in (session.pack_fields or []):
        key = f.get("key")
        val = session.pack_answers.get(key)
        if val in (None, "", []):
            continue
        if isinstance(val, list):
            opt_by_val = {o.get("value"): o for o in (f.get("options") or [])}
            vtxt = ", ".join(option_label(opt_by_val[v], lang) if v in opt_by_val else str(v) for v in val)
        else:
            vtxt = str(val)
        lines.append(f"📋 *{field_label(f, lang)}:* {vtxt}")
    _other = session.pack_answers.get("pressing_needs_other")
    if _other:
        lines.append(f"✏️ {_other}")
    # Evidence - count photos (primary + extras) + audio + text flags.
    ev = []
    n_photos = (1 if session.image_data_url else 0) + len(session.extra_images)
    if n_photos:
        ev.append(f"{n_photos}×📸")
    if session.audio_data_url:
        ev.append("🎤")
    if session.text:
        ev.append("📝")
    lines.append(f"📎 *{t(lang, 'review_evidence')}:* {' '.join(ev) if ev else t(lang, 'review_none')}")
    return "\n".join(lines)


# Phase 5: maps a ✏️ Fix field key → (clear-fn, step) so tapping it re-opens
# the relevant existing prompt. clear-fn resets that field's answered-flag(s)
# so `_next_missing_step` routes back to that step; everything else stays
# answered, so after the correction the flow returns straight to the review
# card (because consent_accept/fix reset `session.reviewed = False`).
def _fix_clear_location(s):
    s.latitude = None
    s.longitude = None
    s.location_name = ""

def _fix_clear_damage(s):
    s.damage_class = ""
    # severity is re-derived from the next damage pick; reset the gate so the
    # damage callback recomputes it rather than keeping the stale value.
    s.severity_answered = False

def _fix_clear_type(s):
    s.type_answered = False
    s.infra_type = "OTHER"

def _fix_clear_crisis(s):
    s.crisis_type = ""

def _fix_clear_building(s):
    s.infra_name = ""
    s.infra_name_answered = False

def _fix_clear_debris(s):
    s.debris_answered = False
    s.debris_needed = False

_FIX_FIELDS = {
    "location": (_fix_clear_location, "STEP_LOCATION"),
    "damage":   (_fix_clear_damage,   "STEP_DAMAGE_CLASS"),
    "type":     (_fix_clear_type,     "STEP_TYPE"),
    "crisis":   (_fix_clear_crisis,   "STEP_CRISIS_TYPE"),
    "building": (_fix_clear_building, "STEP_BUILDING_NAME"),
    "debris":   (_fix_clear_debris,   "STEP_DEBRIS"),
}


async def _finalize(session):
    lang = session.lang
    chat_id = session.chat_id
    # Idempotent submit latch (HC80 analogue): once a submit is in flight or
    # done, never file again - a double-tap of ✅ Send is a no-op.
    if session.submitted:
        return
    # Phase 5 - pre-submit review gate. Show the confirm card once and wait for
    # ✅ Send; a ✏️ Fix resets `reviewed` so the card re-appears after the edit.
    if not session.reviewed:
        session.state = "REVIEW"
        track_prompt_msg(session, await send_review_card(chat_id, lang, _review_summary(session)))
        return
    session.submitted = True   # latch BEFORE the await - double-tap safe
    report_id = await submit_report(session)
    if report_id:
        await send_confirmation(
            chat_id, lang, report_id,
            session.infra_type, session.severity,
            session.latitude, session.longitude,
            session.location_name,
            has_photo=bool(session.image_data_url),
            has_audio=bool(session.audio_data_url),
        )
        session.state = "DONE"

        # Deferred: upload full video after confirmation
        if session.video_data_url:
            _fire_upload(session, upload_video_deferred(session))
    else:
        session.submitted = False   # submission failed - allow a retry
        await send_text(chat_id, t(lang, "error"))
