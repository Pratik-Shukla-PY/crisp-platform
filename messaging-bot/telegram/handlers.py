"""
Telegram Handlers — Zero-friction crisis reporting.

FLOW: Language → Photo → Description → Type → Severity → Location → Done

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
    create_report_early, upload_image, upload_audio, upload_video_deferred,
    update_report_metadata, update_report_location, delete_report, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP, CRISIS_MAP, DAMAGE_MAP, DEBRIS_MAP, hash_user,
    resolve_location_name,
    is_duplicate_callback,
)
from .consent_store import (
    has_consented as consent_has,
    grant as consent_grant,
    revoke as consent_revoke,
)
from .media_handler import download_media, download_and_split_video
from .bot_replies import (
    send_welcome, send_step_location, send_step_photo, send_step_photo_first, send_consent_prompt,
    send_step_voice, send_step_severity, send_step_type,
    send_step_crisis_type, send_step_damage_class, send_step_building_name,
    send_step_debris, send_building_suggestions,
    send_step_text, send_step_description, send_confirmation, send_add_more_prompt,
    send_text, answer_callback,
    detect_lang, t,
)

logger = logging.getLogger(__name__)


# Phase 23 — /start <token> decoder.
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


async def _capture_any_media(session, message: dict):
    """
    Silently capture ANY media/text from the message, regardless of current step.
    Uploads fire-and-forget (never block the next prompt).
    Returns True if something was captured.
    """
    captured = False

    # Photo
    if message.get("photo") and not session.image_data_url:
        photos = message["photo"]
        file_id = photos[-1].get("file_id")
        if file_id:
            media = await download_media(file_id)
            if media:
                session.image_data_url = media["data_url"]
                if session.report_id:
                    _fire_upload(session, upload_image(session))
                captured = True
        if message.get("caption"):
            session.text = (session.text + " " + message["caption"]).strip() if session.text else message["caption"]

    # Video — split into audio (priority) + image (thumbnail) + video (deferred)
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

    # Location (can update even if already set — user might correct it)
    if message.get("location"):
        session.latitude = float(message["location"]["latitude"])
        session.longitude = float(message["location"]["longitude"])
        captured = True

    # Text — always accumulate (never reject text from a person in crisis)
    text = message.get("text", "").strip()
    if text and not text.startswith("/"):
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
            # Phase D (Apr 2026 UI v3) — native-language building name. Cap at
            # 120 chars to match backend `infrastructure_name` column width.
            # Never overwritten by subsequent messages — once answered, subsequent
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
    hard-require a photo). Text/voice-first users — e.g. reporters on feature
    phones via SMS/IVR-class channels — must still be able to file a report
    even if they can't attach a photo.
    """
    # Phase B4 (Apr 2026 UI v3) — question sequence reordered to match the
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
    # include a caption with their first media — by the time we reach
    # STEP_DESCRIPTION `session.text` is almost always populated, and we
    # skip to READY.
    # Apr 2026 UX fix — match the PWA/RN 8-stage capture-flow sequence
    # exactly so evaluators comparing channels see the same order:
    #
    #   1 home           ← handled by /start + consent
    #   2 where+damage   → STEP_LOCATION, STEP_DAMAGE_CLASS
    #   3 infra          → STEP_TYPE
    #   4 crisis + name  → STEP_CRISIS_TYPE, STEP_BUILDING_NAME
    #   5 extras         → STEP_DEBRIS, STEP_SEVERITY  (service + needs
    #                     skipped on Telegram for brevity — low-friction)
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
    if not session.severity_answered:
        return "STEP_SEVERITY"
    # Evidence — accepts any of photo, voice, or text. The STEP_PHOTO
    # prompt explicitly invites all three so users aren't forced into
    # a media type they can't produce (feature phones can type; voice-
    # only speakers can record).
    if not session.image_data_url and not session.audio_data_url and not session.text:
        return "STEP_PHOTO"
    return "READY"


async def _prompt_for_step(session, chat_id: int, step: str):
    """Send the appropriate prompt for the given step."""
    lang = session.lang
    if step == "STEP_PHOTO":
        await send_step_photo_first(chat_id, lang)
    elif step == "STEP_DESCRIPTION":
        await send_step_description(chat_id, lang)
    elif step == "STEP_TYPE":
        await send_step_type(chat_id, lang)
    elif step == "STEP_CRISIS_TYPE":
        await send_step_crisis_type(chat_id, lang)
    elif step == "STEP_DAMAGE_CLASS":
        await send_step_damage_class(chat_id, lang)
    elif step == "STEP_SEVERITY":
        await send_step_severity(chat_id, lang)
    elif step == "STEP_BUILDING_NAME":
        # Apr 2026 UX fix — if we have GPS, try to offer nearby OSM
        # buildings as tap-to-pick chips first. Reporter taps one → done.
        # Timeout/empty-result falls through to the free-text prompt.
        picked = False
        if session.has_location:
            try:
                from .building_lookup import nearby_buildings
                suggestions = await nearby_buildings(session.latitude, session.longitude, limit=5)
                if suggestions:
                    await send_building_suggestions(chat_id, lang, suggestions)
                    picked = True
            except Exception:
                picked = False
        if not picked:
            await send_step_building_name(chat_id, lang)
    elif step == "STEP_DEBRIS":
        await send_step_debris(chat_id, lang)
    elif step == "STEP_LOCATION":
        await send_step_location(chat_id, lang)


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

    # /start always resets — show language picker.
    # Phase 23 — also accept an optional payload (`/start <token>`).
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
        s.lang = detected
        s.state = "LANG_SELECT"
        if decoded_pwa_hash:
            s.pwa_device_hash = decoded_pwa_hash
            logger.info(
                "telegram /start linked to PWA device-hash (chat_id=%s)",
                chat_id,
            )
        await send_welcome(chat_id, s.lang)
        return

    # /cancel always aborts
    if text.startswith("/cancel") or text.startswith("/delete"):
        if session.report_id:
            await delete_report(session)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        s.state = "LANG_SELECT"
        await send_welcome(chat_id, s.lang)
        return

    # If in START, DONE, or LANG_SELECT — show language picker
    if session.state in ("START", "DONE", "LANG_SELECT"):
        session.state = "LANG_SELECT"
        await send_welcome(chat_id, session.lang)
        return

    # P3.5 — Consent-gate: if waiting on consent (or never consented), any
    # inbound text/media is ignored and the consent card is re-shown. No
    # side-effect captures, no DB writes.
    # Apr-2026: hydrate from persisted consent store first so a returning
    # reporter is treated as already-consented even on a fresh session.
    if not session.consented and consent_has(user_id):
        session.consented = True
    if session.state == "AWAIT_CONSENT" or not session.consented:
        await send_consent_prompt(chat_id, session.lang)
        return

    # ADD_MORE state — user is adding details to an already-submitted report
    if session.state == "ADD_MORE" and session.report_id:
        await _capture_any_media(session, message)
        await send_text(chat_id, "✅ " + t(session.lang, "add_more_done") + "\n\n📎 Send more, or tap Done 👇")
        return

    # ── CAPTURE everything first, regardless of step ──
    had_location_before = session.has_location
    had_evidence_before = session.has_evidence
    await _capture_any_media(session, message)

    # Resolve location name if just received
    if session.has_location and not had_location_before:
        await resolve_location_name(session)
        if session.report_id:
            await update_report_location(session)

    # P2.8 — Defer server-side report creation until the session has a minimal
    # viable set of fields (photo OR audio, plus location or explicit text).
    # The previous "aggressive early submit on any data" created partial rows
    # that stranded in the DB with severity='UNKNOWN' when users dropped off
    # mid-conversation. Keep the session in local memory until we're sure.
    # Once created, media upload is fire-and-forget as before.
    if not session.report_id:
        has_media_or_text = bool(session.image_data_url or session.audio_data_url or session.text)
        has_location = session.has_location
        if has_media_or_text and has_location:
            await create_report_early(session)
            logger.info(
                f"[TG] Report created once ready: loc={has_location} "
                f"text={bool(session.text)} img={bool(session.image_data_url)} "
                f"aud={bool(session.audio_data_url)}"
            )
            if session.report_id:
                if session.image_data_url:
                    _fire_upload(session, upload_image(session))
                if session.audio_data_url:
                    _fire_upload(session, upload_audio(session))

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
        # Step changed — send the new prompt
        session.state = next_step
        await _prompt_for_step(session, chat_id, next_step)
    # else: same step, user sent bonus data (e.g. extra photo) — no re-prompt


async def _handle_callback(callback_query: dict):
    user = callback_query.get("from", {})
    user_id = user.get("id")
    chat_id = callback_query.get("message", {}).get("chat", {}).get("id")
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

    # Apr 2026 UX fix — multi-tap debounce. Users tap a chip, see nothing
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

    # P3.5 — Language selection routes through consent before any data is
    # captured. Apr-2026 fix: consent is persisted to SQLite keyed by
    # `user_id`, so a returning reporter skips the consent card entirely.
    # In-memory `session.consented` is mirrored from the store on first
    # lookup so the rest of the flow keeps working unchanged.
    if data.startswith("lang_"):
        new_lang = data.replace("lang_", "")
        session.lang = new_lang
        await answer_callback(cq_id, f"Language: {new_lang.upper()}")
        # Hydrate from the consent store — asked once, remembered forever.
        if not session.consented and consent_has(user_id):
            session.consented = True
        if session.consented:
            session.state = _next_missing_step(session)
            await _prompt_for_step(session, chat_id, session.state)
        else:
            session.state = "AWAIT_CONSENT"
            await send_consent_prompt(chat_id, new_lang)
        return

    # User accepted the consent card — proceed to reporting flow.
    if data == "consent_accept":
        session.consented = True
        consent_grant(user_id, session.lang)     # persist → never re-ask
        await answer_callback(cq_id, "Thanks!")
        # Jump straight to the NEXT missing step (usually STEP_LOCATION in
        # the Apr-2026 reorder). Previously always landed on STEP_PHOTO.
        session.state = _next_missing_step(session)
        await _prompt_for_step(session, chat_id, session.state)
        return

    # User declined — wipe session and bid farewell. Nothing captured so
    # nothing to delete.
    if data == "consent_decline":
        await answer_callback(cq_id)
        await send_text(
            chat_id,
            "🙏 " + (t(session.lang, "consent_declined")
                    or "Understood — no data collected. Send /start anytime to try again.")
        )
        clear_session(user_id)
        return

    # Start / Report Another → carry consent across the session reset so
    # the reporter isn't re-prompted between reports.
    if data == "start_report":
        persisted_consent = session.consented or consent_has(user_id)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = session.lang or detected
        s.consented = persisted_consent
        if s.consented:
            s.state = _next_missing_step(s)
            await answer_callback(cq_id)
            await _prompt_for_step(s, chat_id, s.state)
        else:
            s.state = "AWAIT_CONSENT"
            await answer_callback(cq_id)
            await send_consent_prompt(chat_id, s.lang)
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
        await send_add_more_prompt(chat_id, lang)
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
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        s.state = "LANG_SELECT"
        await send_welcome(chat_id, s.lang)
        return

    # ── Skip photo → go to description ──
    if data == "skip_photo":
        session.state = "STEP_DESCRIPTION"
        await answer_callback(cq_id)
        await send_step_description(chat_id, lang)
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

    # ── Apr 2026 Telegram UX — OSM building pick: `bldg:osm:way:<id>`
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
        await send_step_building_name(chat_id, session.lang or detected)
        return

    # ── Phase D (Apr 2026 UI v3) — skip the native-language building prompt.
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

    # ── Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — debris Yes/No.
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

    # Phase B4 — grouped crisis keyboard renders "— GROUP —" separator
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
    # Apr 2026 UX parity with PWA — severity is auto-derived from damage:
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

    await answer_callback(cq_id)


async def _finalize(session):
    lang = session.lang
    chat_id = session.chat_id
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
        await send_text(chat_id, t(lang, "error"))
