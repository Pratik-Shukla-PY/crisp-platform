"""
Telegram Handlers — Clear step-by-step: each step asks ONE thing.

Flow: /start → [🚨] → Location → Photo (required) → Voice/Text (required) → Severity → Type → Done
"""
import logging
from .session_manager import (
    get_or_create_session, is_duplicate_message,
    create_report_early, upload_image, upload_audio,
    update_report_metadata, delete_report, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP, hash_user,
    resolve_location_name,
)
from .media_handler import download_media
from .bot_replies import (
    send_welcome, send_step_location, send_step_photo,
    send_step_voice, send_step_severity, send_step_type,
    send_confirmation, send_text, answer_callback, detect_lang, t,
)

logger = logging.getLogger(__name__)


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
    lang = session.lang
    text = message.get("text", "").strip()

    # Commands
    if text.startswith("/start"):
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        await send_welcome(chat_id, s.lang)
        return
    if text.startswith("/cancel") or text.startswith("/delete"):
        if session.report_id:
            await delete_report(session)
            await send_text(chat_id, "🗑")
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        await send_welcome(chat_id, s.lang)
        return

    state = session.state

    # ── STEP 1: LOCATION (mandatory) ──
    if state == "STEP_LOCATION":
        if message.get("location"):
            loc = message["location"]
            session.latitude = float(loc["latitude"])
            session.longitude = float(loc["longitude"])
            # Reverse geocode to get place name
            await resolve_location_name(session)
            await send_text(chat_id, t(lang, "step_loc_done"))
            # Create report immediately
            report_id = await create_report_early(session)
            if not report_id:
                await send_text(chat_id, t(lang, "error"))
                return
            logger.info(f"[TG] Report {report_id} created")
            session.state = "STEP_PHOTO"
            await send_step_photo(chat_id, lang)
        else:
            await send_step_location(chat_id, lang)
        return

    # ── STEP 2: PHOTO (mandatory) ──
    if state == "STEP_PHOTO":
        if message.get("photo"):
            photos = message["photo"]
            file_id = photos[-1].get("file_id")
            if file_id:
                media = await download_media(file_id)
                if media:
                    session.image_data_url = media["data_url"]
                    caption = message.get("caption", "")
                    if caption:
                        session.text = caption
                    await send_text(chat_id, "📸 ✅")
                    # Stream to dashboard immediately
                    if session.report_id:
                        await upload_image(session)
                    session.state = "STEP_VOICE"
                    await send_step_voice(chat_id, lang)
                else:
                    await send_text(chat_id, "⚠️ " + t(lang, "error"))
            else:
                await send_step_photo(chat_id, lang)
        else:
            # Not a photo — remind them
            await send_step_photo(chat_id, lang)
        return

    # ── STEP 3: VOICE or TEXT (one required) ──
    if state == "STEP_VOICE":
        if message.get("voice") or message.get("audio"):
            voice = message.get("voice") or message.get("audio")
            file_id = voice.get("file_id")
            if file_id:
                media = await download_media(file_id)
                if media:
                    session.audio_data_url = media["data_url"]
                    await send_text(chat_id, "🎙 ✅")
                    if session.report_id:
                        await upload_audio(session)
                    session.state = "STEP_SEVERITY"
                    await send_step_severity(chat_id, lang)
                    return
        if text:
            session.text = text if not session.text else session.text + " " + text
            await update_report_metadata(session)
            await send_text(chat_id, "📝 ✅")
            session.state = "STEP_SEVERITY"
            await send_step_severity(chat_id, lang)
            return
        # Neither voice nor text
        await send_step_voice(chat_id, lang)
        return

    # ── STEP 4: SEVERITY ──
    if state == "STEP_SEVERITY":
        sev = SEVERITY_MAP.get(text.lower()) or SEVERITY_MAP.get(text)
        if sev:
            session.severity = sev
            await update_report_metadata(session)
            session.state = "STEP_TYPE"
            await send_step_type(chat_id, lang)
        else:
            await send_step_severity(chat_id, lang)
        return

    # ── STEP 5: TYPE ──
    if state == "STEP_TYPE":
        itype = TYPE_MAP.get(text.lower()) or TYPE_MAP.get(text)
        if itype:
            session.infra_type = itype
            await update_report_metadata(session)
            await _finalize(session)
        else:
            await send_step_type(chat_id, lang)
        return

    await send_welcome(chat_id, lang)


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

    if data == "start_report":
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        s.state = "STEP_LOCATION"
        await answer_callback(cq_id, "🚨")
        await send_step_location(chat_id, s.lang)
        return

    if data == "stop":
        await answer_callback(cq_id, "✅")
        clear_session(user_id)
        return

    if data == "cancel_report":
        if session.report_id:
            await delete_report(session)
        await answer_callback(cq_id, "🗑")
        clear_session(user_id)
        s = get_or_create_session(user_id, chat_id)
        s.lang = detected
        await send_welcome(chat_id, s.lang)
        return

    # Severity buttons
    if data.startswith("sev_"):
        sev = SEVERITY_MAP.get(data)
        if sev:
            session.severity = sev
            await update_report_metadata(session)
            session.state = "STEP_TYPE"
            await answer_callback(cq_id, f"⚠️ {sev}")
            await send_step_type(chat_id, lang)
        return

    # Type buttons
    if data.startswith("type_"):
        itype = TYPE_MAP.get(data)
        if itype:
            session.infra_type = itype
            await update_report_metadata(session)
            await answer_callback(cq_id, f"🏗 {itype}")
            await _finalize(session)
        return

    await answer_callback(cq_id)


async def _finalize(session):
    lang = session.lang
    chat_id = session.chat_id
    await send_text(chat_id, t(lang, "submitting"))
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
    else:
        await send_text(chat_id, t(lang, "error"))
