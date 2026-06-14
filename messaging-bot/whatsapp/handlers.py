"""
WhatsApp Message Handlers - Routes incoming messages by type,
updates the session buffer, and drives the guided conversation flow.
"""
import logging
from .session_manager import (
    get_or_create_session, is_duplicate_message, submit_report,
    clear_session, SEVERITY_MAP, TYPE_MAP,
)
from .media_handler import download_media
from .bot_replies import (
    send_welcome, send_received_ack, send_severity_prompt,
    send_type_prompt, send_location_request, send_confirmation, send_text,
    send_lang_menu, detect_lang_from_phone, parse_lang_selection, t,
)

logger = logging.getLogger(__name__)


async def handle_incoming_message(phone: str, message: dict):
    """
    Main entry point: receives a WhatsApp message and processes it.
    Called by the webhook for each message in the payload.
    """
    msg_id = message.get("id", "")
    msg_type = message.get("type", "")
    session = get_or_create_session(phone)

    # Auto-detect language from phone number on first message
    if not hasattr(session, 'lang') or not session.lang:
        session.lang = detect_lang_from_phone(phone)

    # Deduplication
    if msg_id and is_duplicate_message(session, msg_id):
        logger.debug(f"Duplicate message {msg_id} - skipping")
        return

    session.touch()

    # Check for language switch command
    if msg_type == "text":
        text_body = message.get("text", {}).get("body", "").strip()
        lang_result = parse_lang_selection(text_body)
        if lang_result == "__SHOW_MENU__":
            await send_lang_menu(phone, session.lang)
            return
        elif lang_result:
            session.lang = lang_result
            await send_welcome(phone, session.lang)
            return

    # Route by message type
    if msg_type == "text":
        await _handle_text(session, message)
    elif msg_type == "image":
        await _handle_image(session, message)
    elif msg_type == "audio":
        await _handle_audio(session, message)
    elif msg_type == "location":
        await _handle_location(session, message)
    elif msg_type == "interactive":
        await _handle_interactive(session, message)
    else:
        logger.info(f"Unhandled message type: {msg_type}")
        await send_text(phone, "Please send a photo, voice note, text, or location.")
        return

    # After processing, advance the guided flow
    await _advance_flow(session)


async def _handle_text(session, message: dict):
    """Handle plain text message."""
    text = message.get("text", {}).get("body", "").strip()
    if not text:
        return

    # Check if this is a reply to severity/type prompt (fallback text input)
    lower = text.lower()

    if session.state == "AWAITING_SEVERITY":
        sev = SEVERITY_MAP.get(lower) or SEVERITY_MAP.get(text)
        if sev:
            session.severity = sev
            session.state = "AWAITING_TYPE"
            logger.info(f"{session.phone_hash}: severity={sev}")
            return

    if session.state == "AWAITING_TYPE":
        itype = TYPE_MAP.get(lower) or TYPE_MAP.get(text)
        if itype:
            session.infra_type = itype
            session.state = "AWAITING_LOCATION" if not session.has_location else "COLLECTING"
            logger.info(f"{session.phone_hash}: type={itype}")
            return

    # Regular text - append to description
    if session.text:
        session.text += " " + text
    else:
        session.text = text
    logger.info(f"{session.phone_hash}: text received ({len(text)} chars)")
    await send_received_ack(session.phone_raw, "text")


async def _handle_image(session, message: dict):
    """Handle image message - download from Meta servers."""
    image_info = message.get("image", {})
    media_id = image_info.get("id")
    caption = image_info.get("caption", "")

    if not media_id:
        return

    # Download from Meta
    media = await download_media(media_id)
    if not media:
        await send_text(session.phone_raw, "⚠️ Could not download the image. Please try again.")
        return

    session.image_data_url = media["data_url"]
    if caption and not session.text:
        session.text = caption
    logger.info(f"{session.phone_hash}: image received ({media['size_bytes']:,} bytes)")
    await send_received_ack(session.phone_raw, "image")
    await send_text(session.phone_raw, "🔒 Privacy: Faces in your photo will be automatically blurred.")


async def _handle_audio(session, message: dict):
    """Handle voice note/audio message - download from Meta servers."""
    audio_info = message.get("audio", {})
    media_id = audio_info.get("id")

    if not media_id:
        return

    media = await download_media(media_id)
    if not media:
        await send_text(session.phone_raw, "⚠️ Could not download the voice note. Please try again.")
        return

    session.audio_data_url = media["data_url"]
    logger.info(f"{session.phone_hash}: audio received ({media['size_bytes']:,} bytes)")
    await send_received_ack(session.phone_raw, "audio")


async def _handle_location(session, message: dict):
    """Handle shared location."""
    loc = message.get("location", {})
    lat = loc.get("latitude")
    lng = loc.get("longitude")

    if lat is None or lng is None:
        return

    session.latitude = float(lat)
    session.longitude = float(lng)
    logger.info(f"{session.phone_hash}: location received ({lat}, {lng})")
    await send_received_ack(session.phone_raw, "location")


async def _handle_interactive(session, message: dict):
    """Handle interactive button/list replies."""
    interactive = message.get("interactive", {})
    reply_type = interactive.get("type", "")

    reply_id = ""
    if reply_type == "button_reply":
        reply_id = interactive.get("button_reply", {}).get("id", "")
    elif reply_type == "list_reply":
        reply_id = interactive.get("list_reply", {}).get("id", "")

    if not reply_id:
        return

    # Severity reply
    if reply_id.startswith("sev_"):
        sev = SEVERITY_MAP.get(reply_id)
        if sev:
            session.severity = sev
            session.state = "AWAITING_TYPE"
            logger.info(f"{session.phone_hash}: severity={sev} (interactive)")
            return

    # Type reply
    if reply_id.startswith("type_"):
        itype = TYPE_MAP.get(reply_id)
        if itype:
            session.infra_type = itype
            session.state = "AWAITING_LOCATION" if not session.has_location else "COLLECTING"
            logger.info(f"{session.phone_hash}: type={itype} (interactive)")
            return


async def _advance_flow(session):
    """
    Drive the guided conversation forward based on current session state.
    Sends the next prompt or submits the report when complete.
    """
    phone = session.phone_raw

    # If first message ever - send welcome
    if len(session.message_ids) <= 1 and not session.has_evidence:
        await send_welcome(phone)
        return

    # Check if we can submit
    if session.is_complete and session.state != "SUBMITTING" and session.state != "DONE":
        report_id = await submit_report(session)
        if report_id:
            await send_confirmation(
                phone, report_id,
                session.infra_type, session.severity,
                session.latitude, session.longitude,
                has_photo=bool(session.image_data_url),
                has_audio=bool(session.audio_data_url),
            )
            clear_session(phone)
        else:
            await send_text(phone, "⚠️ Submission failed. Please try again in a moment.")
        return

    # Prompt for missing fields
    if session.has_evidence and session.severity == "UNKNOWN" and session.state == "COLLECTING":
        session.state = "AWAITING_SEVERITY"
        await send_severity_prompt(phone)
        return

    if session.state == "AWAITING_TYPE":
        await send_type_prompt(phone)
        return

    if session.state == "AWAITING_LOCATION" or (
        session.has_evidence and session.severity != "UNKNOWN"
        and session.infra_type != "OTHER" and not session.has_location
    ):
        session.state = "AWAITING_LOCATION"
        await send_location_request(phone)
        return
