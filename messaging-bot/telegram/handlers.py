"""
Telegram Handlers — Resilient crisis reporting for low-connectivity scenarios.

RESILIENCE STRATEGY:
  1. ONE-MESSAGE REPORTING: Photo with caption = instant complete report.
     No multi-step flow needed. Caption parsed for location + description.
  2. AGGRESSIVE EARLY SUBMIT: Report created on FIRST data received
     (even just text), not waiting for location. Partial data > no data.
  3. REDUCED ROUND-TRIPS: Steps combined. Type+severity skippable.
     AI Assessment on dashboard infers type/severity later.

Accepts ANY input at ANY step. People in crisis send data randomly.
Photo, video, voice, text, location — all captured regardless of sequence.
"""
import logging
from .session_manager import (
    get_or_create_session, is_duplicate_message,
    create_report_early, upload_image, upload_audio, upload_video_deferred,
    update_report_metadata, delete_report, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP, hash_user,
    resolve_location_name,
)
from .media_handler import download_media, download_and_split_video
from .bot_replies import (
    send_welcome, send_step_location, send_step_photo,
    send_step_voice, send_step_severity, send_step_type,
    send_step_text, send_confirmation, send_add_more_prompt,
    send_text, answer_callback,
    detect_lang, t,
)

logger = logging.getLogger(__name__)


async def _capture_any_media(session, message: dict):
    """
    Silently capture ANY media/text from the message, regardless of current step.
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
                    await upload_image(session)
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

            # Audio from video → upload in chunks first (priority for transcription)
            if split.get("audio") and not session.audio_data_url:
                session.audio_data_url = split["audio"]["data_url"]
                if session.report_id:
                    await upload_audio(session)
                captured = True
                logger.info("[TG] Audio extracted from video and uploaded")

            # Thumbnail/frame as image evidence
            if split.get("image") and not session.image_data_url:
                session.image_data_url = split["image"]["data_url"]
                if session.report_id:
                    await upload_image(session)
                captured = True

            # Store full video for deferred upload (after everything else)
            if split.get("video"):
                session.video_data_url = split["video"]["data_url"]
                captured = True

        if message.get("caption"):
            session.text = (session.text + "\n" + message["caption"]).strip() if session.text else message["caption"]

    # Video note (round video) — same treatment
    if message.get("video_note"):
        vn = message["video_note"]
        vn_file_id = vn.get("file_id")
        thumb_file_id = vn.get("thumb", {}).get("file_id") if vn.get("thumb") else None

        if vn_file_id:
            split = await download_and_split_video(vn_file_id, thumb_file_id)
            if split.get("audio") and not session.audio_data_url:
                session.audio_data_url = split["audio"]["data_url"]
                if session.report_id:
                    await upload_audio(session)
                captured = True
            if split.get("image") and not session.image_data_url:
                session.image_data_url = split["image"]["data_url"]
                if session.report_id:
                    await upload_image(session)
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
                    await upload_audio(session)
                captured = True

    # Location (can update even if already set — user might correct it)
    if message.get("location"):
        session.latitude = float(message["location"]["latitude"])
        session.longitude = float(message["location"]["longitude"])
        captured = True

    # Text — always accumulate (never reject text from a person in crisis)
    text = message.get("text", "").strip()
    if text and not text.startswith("/"):
        # Check if it's a severity or type answer first
        sev = SEVERITY_MAP.get(text.lower()) or SEVERITY_MAP.get(text)
        itype = TYPE_MAP.get(text.lower()) or TYPE_MAP.get(text)
        if sev and session.severity == "UNKNOWN":
            session.severity = sev
            captured = True
        elif itype and session.infra_type == "OTHER":
            session.infra_type = itype
            captured = True
        else:
            # Accumulate as description — every word matters in a crisis
            session.text = (session.text + "\n" + text).strip() if session.text else text
            captured = True
            logger.info(f"[TG] Text accumulated: {len(session.text)} chars total")

    # Push ALL changes to backend immediately (text, severity, type)
    if captured and session.report_id:
        await update_report_metadata(session)

    return captured


def _next_missing_step(session) -> str:
    """Determine what the user still needs to provide.
    Reduced steps for connectivity resilience:
      - Location (critical for rescue teams)
      - Photo OR voice/text (at least one evidence)
      - Type/Severity SKIPPED — AI Assessment infers these on dashboard
    """
    if not session.has_location:
        return "STEP_LOCATION"
    if not session.image_data_url and not session.audio_data_url and not session.text:
        return "STEP_PHOTO"  # Ask for any evidence — photo, voice, or text
    return "READY"


async def _prompt_for_step(session, chat_id: int, step: str):
    """Send the appropriate prompt for the given step."""
    lang = session.lang
    if step == "STEP_LOCATION":
        await send_step_location(chat_id, lang)
    elif step == "STEP_TYPE":
        await send_step_type(chat_id, lang)
    elif step == "STEP_SEVERITY":
        await send_step_severity(chat_id, lang)
    elif step == "STEP_PHOTO":
        await send_step_photo(chat_id, lang)
    elif step == "STEP_VOICE":
        await send_step_voice(chat_id, lang)
    elif step == "READY":
        await send_step_text(chat_id, lang)


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

    # /start always resets
    if text.startswith("/start"):
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        await send_welcome(chat_id, s.lang)
        return

    # /cancel always aborts
    if text.startswith("/cancel") or text.startswith("/delete"):
        if session.report_id:
            await delete_report(session)
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        await send_welcome(chat_id, s.lang)
        return

    # If in START or DONE state, show welcome
    if session.state in ("START", "DONE"):
        await send_welcome(chat_id, session.lang)
        return

    # ADD_MORE state — user is adding details to an already-submitted report
    if session.state == "ADD_MORE" and session.report_id:
        await _capture_any_media(session, message)
        await send_text(chat_id, "✅ " + t(session.lang, "add_more_done") + "\n\n📎 Send more, or tap Done 👇")
        return

    # ── CAPTURE everything first, regardless of step ──
    had_location_before = session.has_location
    had_report_before = session.report_id
    await _capture_any_media(session, message)

    # Resolve location name if just received
    if session.has_location and not had_location_before:
        await resolve_location_name(session)

    # AGGRESSIVE EARLY SUBMIT: Create report on ANY first data
    # Even text-only or photo-only gets saved immediately.
    # Partial data on the dashboard > complete data lost to connectivity.
    if not session.report_id:
        has_any_data = session.has_location or session.text or session.image_data_url or session.audio_data_url
        if has_any_data:
            await create_report_early(session)
            logger.info(f"[TG] Early report created with partial data: loc={session.has_location} text={bool(session.text)} img={bool(session.image_data_url)}")

    # ── Now advance to the next missing step ──
    next_step = _next_missing_step(session)

    # ── ONE-MESSAGE REPORTING: If photo+caption has location info, auto-submit ──
    if not had_report_before and session.report_id and session.image_data_url and session.text and len(session.text) > 10:
        # User sent a rich single message (photo + detailed caption)
        # This is likely a one-shot report — auto-submit to minimize round-trips
        if session.has_location or any(w in session.text.lower() for w in ['near', 'at', 'in', 'village', 'road', 'bridge', 'city']):
            logger.info(f"[TG] One-message report detected — auto-submitting")
            await _finalize(session)
            return

    if next_step == "READY":
        # Everything we need is collected — ask for final text or submit
        if session.state != "STEP_TEXT":
            session.state = "STEP_TEXT"
            await send_step_text(chat_id, session.lang)
        else:
            # They already sent text at the text step — finalize
            await _finalize(session)
    else:
        session.state = next_step
        await _prompt_for_step(session, chat_id, next_step)


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

    # Language selection
    if data.startswith("lang_"):
        new_lang = data.replace("lang_", "")
        session.lang = new_lang
        await answer_callback(cq_id, f"Language: {new_lang.upper()}")
        # Re-send welcome in the new language
        await send_welcome(chat_id, new_lang)
        return

    # Start / Report Another
    if data == "start_report":
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = session.lang or detected  # Preserve language choice
        s.state = "STEP_LOCATION"
        await answer_callback(cq_id)
        await send_step_location(chat_id, s.lang)
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
        await send_welcome(chat_id, s.lang)
        return

    # Skip text — submit now
    if data == "skip_text":
        await answer_callback(cq_id)
        await _finalize(session)
        return

    # Type buttons
    if data.startswith("type_"):
        itype = TYPE_MAP.get(data)
        if itype:
            session.infra_type = itype
            await update_report_metadata(session)
            await answer_callback(cq_id)
            # Advance to next missing step
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                session.state = "STEP_TEXT"
                await send_step_text(chat_id, lang)
            else:
                await _prompt_for_step(session, chat_id, next_step)
        return

    # Severity buttons
    if data.startswith("sev_"):
        sev = SEVERITY_MAP.get(data)
        if sev:
            session.severity = sev
            await update_report_metadata(session)
            await answer_callback(cq_id)
            next_step = _next_missing_step(session)
            session.state = next_step
            if next_step == "READY":
                session.state = "STEP_TEXT"
                await send_step_text(chat_id, lang)
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

        # Deferred: upload full video after confirmation (low priority, large file)
        if session.video_data_url:
            logger.info(f"[TG] Starting deferred video upload for {report_id}")
            await upload_video_deferred(session)
    else:
        await send_text(chat_id, t(lang, "error"))
