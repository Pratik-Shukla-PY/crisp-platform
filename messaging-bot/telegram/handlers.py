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
from .session_manager import (
    get_or_create_session, is_duplicate_message,
    create_report_early, upload_image, upload_audio, upload_video_deferred,
    update_report_metadata, update_report_location, delete_report, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP, CRISIS_MAP, DAMAGE_MAP, hash_user,
    resolve_location_name,
)
from .media_handler import download_media, download_and_split_video
from .bot_replies import (
    send_welcome, send_step_location, send_step_photo, send_step_photo_first,
    send_step_voice, send_step_severity, send_step_type,
    send_step_crisis_type, send_step_damage_class,
    send_step_text, send_step_description, send_confirmation, send_add_more_prompt,
    send_text, answer_callback,
    detect_lang, t,
)

logger = logging.getLogger(__name__)


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
        else:
            session.text = (session.text + "\n" + text).strip() if session.text else text
            captured = True

    # Push metadata to backend immediately
    if captured and session.report_id:
        await update_report_metadata(session)

    return captured


def _next_missing_step(session) -> str:
    """Flow: Photo → Description → Type → Crisis → Damage → Severity → Location → READY"""
    if not session.image_data_url and not session.audio_data_url and not session.text:
        return "STEP_PHOTO"
    if not session.text and (session.image_data_url or session.audio_data_url):
        return "STEP_DESCRIPTION"
    if not session.type_answered:
        return "STEP_TYPE"
    if not session.crisis_type:
        return "STEP_CRISIS_TYPE"
    if not session.damage_class:
        return "STEP_DAMAGE_CLASS"
    if not session.severity_answered:
        return "STEP_SEVERITY"
    if not session.has_location:
        return "STEP_LOCATION"
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

    # /start always resets — show language picker
    if text.startswith("/start"):
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        s.state = "LANG_SELECT"
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

    # AGGRESSIVE EARLY SUBMIT: Create report on ANY first data
    if not session.report_id:
        has_any_data = session.has_location or session.text or session.image_data_url or session.audio_data_url
        if has_any_data:
            await create_report_early(session)
            logger.info(f"[TG] Early report created: loc={session.has_location} text={bool(session.text)} img={bool(session.image_data_url)}")
            # Fire-and-forget upload for media captured before report existed
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

    # ── Language selection → immediately start photo step ──
    if data.startswith("lang_"):
        new_lang = data.replace("lang_", "")
        session.lang = new_lang
        session.state = "STEP_PHOTO"
        await answer_callback(cq_id, f"Language: {new_lang.upper()}")
        await send_step_photo_first(chat_id, new_lang)
        return

    # Start / Report Another → go straight to photo
    if data == "start_report":
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = session.lang or detected
        s.state = "STEP_PHOTO"
        await answer_callback(cq_id)
        await send_step_photo_first(chat_id, s.lang)
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
    if data.startswith("dmg_"):
        dc = DAMAGE_MAP.get(data)
        if dc:
            session.damage_class = dc
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
