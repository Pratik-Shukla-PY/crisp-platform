"""
WhatsApp Bot Reply Templates — Sends guided prompts and confirmations to users.
Uses the WhatsApp Cloud API to send text, interactive buttons, and location requests.
"""
import os
import logging
import httpx

logger = logging.getLogger(__name__)

GRAPH_API = "https://graph.facebook.com/v19.0"
PHONE_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")


def _headers():
    return {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


async def send_text(to: str, text: str):
    """Send a plain text message."""
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(url, json=payload, headers=_headers())
            if r.status_code != 200:
                logger.warning(f"WhatsApp send failed ({r.status_code}): {r.text}")
    except Exception as e:
        logger.error(f"WhatsApp send error: {e}")


async def send_severity_prompt(to: str):
    """Ask user to classify severity using interactive buttons."""
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": "Thank you for reporting. How severe is the damage?"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "sev_severe", "title": "🔴 Severe"}},
                    {"type": "reply", "reply": {"id": "sev_moderate", "title": "🟠 Moderate"}},
                    {"type": "reply", "reply": {"id": "sev_minor", "title": "🟢 Minor"}},
                ]
            },
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, json=payload, headers=_headers())
    except Exception as e:
        logger.error(f"Severity prompt error: {e}")


async def send_type_prompt(to: str):
    """Ask user to classify infrastructure type using interactive list."""
    url = f"{GRAPH_API}/{PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": "What type of infrastructure is affected?"},
            "action": {
                "button": "Select Type",
                "sections": [
                    {
                        "title": "Infrastructure",
                        "rows": [
                            {"id": "type_road", "title": "🛣️ Road / Bridge"},
                            {"id": "type_hospital", "title": "🏥 Hospital / Clinic"},
                            {"id": "type_house", "title": "🏠 House / Building"},
                            {"id": "type_power", "title": "⚡ Power / Electricity"},
                            {"id": "type_water", "title": "💧 Water / Sanitation"},
                            {"id": "type_other", "title": "❓ Other"},
                        ],
                    }
                ],
            },
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, json=payload, headers=_headers())
    except Exception as e:
        logger.error(f"Type prompt error: {e}")


async def send_location_request(to: str):
    """Ask user to share their location."""
    await send_text(
        to,
        "📍 Please share your location so rescue teams can find the incident.\n\n"
        "Tap the 📎 (attach) button → Location → Share Live Location or Send Your Current Location."
    )


async def send_confirmation(to: str, report_id: str, infra_type: str, severity: str,
                            lat: float = None, lng: float = None,
                            has_photo: bool = False, has_audio: bool = False):
    """Send submission confirmation with report summary."""
    loc_str = f"{lat:.4f}, {lng:.4f}" if lat and lng else "Not provided"
    photo_str = "✅" if has_photo else "❌"
    audio_str = "✅" if has_audio else "❌"

    msg = (
        f"✅ *Report Submitted Successfully!*\n\n"
        f"📋 *Type:* {infra_type}\n"
        f"⚠️ *Severity:* {severity}\n"
        f"📍 *Location:* {loc_str}\n"
        f"📸 *Photo:* {photo_str}  🎙️ *Audio:* {audio_str}\n"
        f"🆔 *ID:* `{report_id[:12]}...`\n\n"
        f"Your report is now being reviewed by crisis response teams. "
        f"Thank you for helping."
    )
    await send_text(to, msg)


async def send_welcome(to: str):
    """Send welcome message when user first contacts the bot."""
    msg = (
        "🆘 *CRISP — Crisis Report Bot*\n\n"
        "Report infrastructure damage quickly:\n\n"
        "📸 Send a *photo* of the damage\n"
        "🎙️ Send a *voice note* describing the situation\n"
        "📝 Type a *text description*\n"
        "📍 Share your *location*\n\n"
        "You can send these in any order. "
        "I'll guide you through the rest."
    )
    await send_text(to, msg)


async def send_received_ack(to: str, media_type: str):
    """Acknowledge receipt of a specific input type."""
    acks = {
        "image": "📸 Photo received!",
        "audio": "🎙️ Voice note received!",
        "text": "📝 Text noted.",
        "location": "📍 Location received!",
    }
    await send_text(to, acks.get(media_type, "✓ Received."))
