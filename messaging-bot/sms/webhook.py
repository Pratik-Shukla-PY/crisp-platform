"""
SMS Webhook - FastAPI router for SMS gateway integration.
Supports Exotel and Twilio incoming SMS webhooks.
Each SMS = one report submitted to the CRISP backend.
"""
import os
import hashlib
import logging
import secrets
import time
from collections import defaultdict
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks

from .parser import parse_sms
from .geocoder import geocode_text

logger = logging.getLogger(__name__)

sms_router = APIRouter()

# ── SMS Multilingual replies (short, SMS-optimized) ──────────────────────────
_SMS_REPLIES = {
    "en": "CRISP: Report received (ID:{id}). Rescue teams notified. Data anonymized. Reply DELETE to remove.",
    "zh": "CRISP: 报告已收到(ID:{id})。救援队已通知。数据匿名。回复DELETE删除。",
    "ru": "CRISP: Отчет получен (ID:{id}). Спасатели уведомлены. Данные анонимны. Ответьте DELETE для удаления.",
    "es": "CRISP: Reporte recibido (ID:{id}). Rescate notificado. Datos anonimos. Responde DELETE para eliminar.",
    "fr": "CRISP: Rapport recu (ID:{id}). Secours alertes. Donnees anonymes. Repondez DELETE pour supprimer.",
    "ar": "CRISP: تم استلام التقرير (ID:{id}). تم إبلاغ الإنقاذ. البيانات مجهولة. أرسل DELETE للحذف.",
    "hi": "CRISP: रिपोर्ट मिली (ID:{id})। बचाव दल को सूचित किया गया। डेटा गुमनाम। DELETE भेजें हटाने के लिए।",
}

# Confirmation for the "DELETE" right-to-erasure keyword (parity with the
# Telegram /delete command). Every ack tells the reporter "Reply DELETE to
# remove" - this is what they get when they do.
_SMS_DELETE_REPLIES = {
    "en": "CRISP: Your reports have been deleted. Send a new message to report again.",
    "zh": "CRISP: 您的报告已删除。发送新消息可再次报告。",
    "ru": "CRISP: Ваши отчёты удалены. Отправьте новое сообщение, чтобы сообщить снова.",
    "es": "CRISP: Tus reportes han sido eliminados. Envia un nuevo mensaje para reportar de nuevo.",
    "fr": "CRISP: Vos rapports ont ete supprimes. Envoyez un nouveau message pour signaler a nouveau.",
    "ar": "CRISP: تم حذف تقاريرك. أرسل رسالة جديدة للإبلاغ مرة أخرى.",
    "hi": "CRISP: आपकी रिपोर्ट हटा दी गई हैं। दोबारा रिपोर्ट करने के लिए नया संदेश भेजें।",
}

# Phone prefix → language
_PHONE_LANG_SMS = {
    "86": "zh", "7": "ru", "34": "es", "52": "es", "54": "es",
    "33": "fr", "212": "ar", "966": "ar", "971": "ar", "20": "ar",
    "91": "hi", "1": "en", "44": "en", "61": "en",
}

def _detect_sms_lang(phone: str) -> str:
    clean = phone.lstrip('+').replace(' ', '').replace('-', '')
    for prefix in sorted(_PHONE_LANG_SMS.keys(), key=len, reverse=True):
        if clean.startswith(prefix):
            return _PHONE_LANG_SMS[prefix]
    return "en"

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")
SMS_WEBHOOK_SECRET = os.getenv("SMS_WEBHOOK_PATH_SECRET", secrets.token_urlsafe(16))
EXOTEL_API_KEY = os.getenv("EXOTEL_API_KEY", "")
EXOTEL_API_TOKEN = os.getenv("EXOTEL_API_TOKEN", "")
EXOTEL_SID = os.getenv("EXOTEL_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")

# Rate limiting
_rate_store: dict = defaultdict(list)
RATE_LIMIT = 10
RATE_WINDOW = 60

# Deduplication
_recent_messages: dict = {}  # hash → timestamp


def _hash_phone(phone: str) -> str:
    return "SMS-" + hashlib.sha256(phone.encode()).hexdigest()[:16]


def _deduplicate(phone: str, text: str) -> bool:
    """Returns True if this is a duplicate message."""
    key = hashlib.md5(f"{phone}:{text}".encode()).hexdigest()
    now = time.time()
    # Clean old entries
    for k in list(_recent_messages.keys()):
        if now - _recent_messages[k] > 300:
            del _recent_messages[k]
    if key in _recent_messages:
        return True
    _recent_messages[key] = now
    return False


def _rate_check(ip: str) -> bool:
    now = time.time()
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT:
        return False
    _rate_store[ip].append(now)
    return True


# ── Exotel-format webhook ──────────────────────────────────────────────────────

@sms_router.post(f"/webhook/{SMS_WEBHOOK_SECRET}")
async def receive_sms(request: Request, background_tasks: BackgroundTasks):
    """
    Receive incoming SMS from Exotel or Twilio.

    Exotel sends form-encoded: From, To, Body
    Twilio sends form-encoded: From, To, Body
    Generic: accepts JSON or form-encoded with 'from'/'phone' and 'body'/'text' fields
    """
    client_ip = request.client.host if request.client else "unknown"
    if not _rate_check(client_ip):
        raise HTTPException(status_code=429, detail="Rate limited")

    # Parse incoming data (support both form-encoded and JSON)
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)

    # Extract phone and text (handle multiple gateway formats)
    phone = data.get("From") or data.get("from") or data.get("phone") or data.get("CallFrom") or ""
    text = data.get("Body") or data.get("body") or data.get("text") or data.get("TextMessage") or ""

    phone = str(phone).strip()
    text = str(text).strip()

    if not phone or not text:
        logger.warning(f"SMS webhook: empty phone or text from {client_ip}")
        return {"status": "ignored", "reason": "empty"}

    # Deduplication
    if _deduplicate(phone, text):
        logger.info(f"SMS duplicate: {_hash_phone(phone)}")
        return {"status": "duplicate"}

    logger.info(f"SMS received: from={_hash_phone(phone)} len={len(text)}")

    # Process in background
    background_tasks.add_task(_process_sms, phone, text)
    return {"status": "accepted"}


async def _process_sms(phone: str, text: str):
    """Process an incoming SMS: parse → geocode → create report → reply."""
    import httpx
    from uuid import uuid4

    device_hash = _hash_phone(phone)

    # 0. Right-to-erasure (must-have #10 + parity with Telegram /delete): a
    # reporter replying exactly "DELETE" (as instructed in every ack) must ERASE
    # their data, NOT create a garbage report. Pre-fix this keyword fell straight
    # through to report creation. Strict exact-match so a description like
    # "delete the road" cannot trigger an accidental erasure.
    if text.strip().rstrip(".!? ").upper() == "DELETE":
        sms_lang = _detect_sms_lang(phone)
        deleted = 0
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                resp = await c.delete(f"{BACKEND_URL}/api/v1/reports/device/{device_hash}")
            if resp.status_code == 200:
                deleted = (resp.json() or {}).get("deleted", 0)
        except Exception as e:
            logger.error(f"SMS erasure failed for {device_hash}: {e}")
        logger.info(f"SMS erasure: device={device_hash} deleted={deleted}")
        await _send_reply(phone, _SMS_DELETE_REPLIES.get(sms_lang, _SMS_DELETE_REPLIES["en"]))
        return

    # 1. Parse SMS
    parsed = parse_sms(text)

    # 2. Geocode location
    geo = await geocode_text(parsed["location_text"])

    # 3. Create report on CRISP backend
    # damage_classification is an enum-validated field on the backend
    # schema - pass None (not "") when the parser couldn't classify,
    # otherwise /reports/meta returns 422 and the SMS is silently lost.
    #
    # UNDP "Other, please specify" rule (report.py:185) - when the SMS
    # parser couldn't match a specific infrastructure keyword it returns
    # OTHER. The backend then requires a non-empty infrastructure_name.
    # We synthesise one from the first line of the SMS description so
    # the report lands cleanly rather than 422-ing on every keyword-
    # less SMS (which is the common case for "earthquake at Sector 7"
    # style submissions).
    infra_type = parsed["infrastructure_type"]
    infra_name = parsed.get("infrastructure_name")
    if infra_type == "OTHER" and not (infra_name and infra_name.strip()):
        # Use the first 40 chars of the description (the SMS body)
        # as the "please specify" text - gives operators something
        # meaningful to triage on. Falls back to a sentinel if even
        # the description is empty.
        snippet = (parsed.get("description") or "").strip()
        infra_name = snippet[:40] if snippet else "Reporter did not specify"

    meta = {
        "device_hash": device_hash,
        "client_report_id": str(uuid4()),
        "source": "SMS",
        "severity": parsed["severity"],
        "infrastructure_type": infra_type,
        "infrastructure_name": infra_name,
        "description": parsed["description"],
        "expected_media": 0,
        "caller_info": {"phone": phone, "source": "SMS"},
        "crisis_type": parsed.get("crisis_type") or None,
        "damage_classification": parsed.get("damage_classification") or None,
        # UNDP core question - True when the SMS text signals debris, else
        # None (unknown). Never False from SMS: absence of the word is not a
        # "no". `is None` check (not `or None`) so a real False would survive.
        "debris_clearing_needed": parsed.get("debris_clearing_needed"),
    }

    if geo["latitude"] is not None:
        meta["location"] = {
            "latitude": geo["latitude"],
            "longitude": geo["longitude"],
            "device_latitude": geo["latitude"],
            "device_longitude": geo["longitude"],
            "accuracy_meters": 5000.0 if geo["confidence"] == "low" else 1000.0,
            "device_location_name": geo["location_name"],
        }

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{BACKEND_URL}/api/v1/reports/meta", json=meta)
            if r.status_code in (200, 201):
                report = r.json()
                report_id = report["id"]
                logger.info(f"SMS report created: {report_id} type={parsed['infrastructure_type']} sev={parsed['severity']}")

                # Send confirmation SMS
                sms_lang = _detect_sms_lang(phone)
                reply_template = _SMS_REPLIES.get(sms_lang, _SMS_REPLIES["en"])
                await _send_reply(phone, reply_template.format(id=report_id[:8]))

                # AI extraction removed - admin triggers AI Assessment on dashboard instead
                # This saves 1 Claude API call per SMS report

                # If location was unclear, ask for clarification
                if geo["latitude"] is None:
                    await _send_reply(phone, "CRISP: We could not determine your exact location. Please reply with the nearest landmark or village name.")
            else:
                logger.error(f"SMS report creation failed ({r.status_code}): {r.text[:200]}")
    except Exception as e:
        logger.error(f"SMS processing error: {e}")


async def _send_reply(phone: str, message: str):
    """Send SMS reply via Exotel or Twilio."""
    import httpx

    # Exotel
    if EXOTEL_SID and EXOTEL_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(
                    f"https://{EXOTEL_API_KEY}:{EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/{EXOTEL_SID}/Sms/send",
                    data={"From": EXOTEL_SID, "To": phone, "Body": message},
                )
                if r.status_code == 200:
                    logger.info(f"SMS reply sent via Exotel to {_hash_phone(phone)}")
                    return
        except Exception as e:
            logger.warning(f"Exotel send failed: {e}")

    # Twilio
    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")
    # accept either TWILIO_PHONE_NUMBER (canonical) or
    # TWILIO_FROM (operator-set alternative shorthand). Some
    # deployments shipped only TWILIO_FROM in .env.production, which
    # silently broke outbound SMS reply because we looked only at
    # TWILIO_PHONE_NUMBER. Either name now works.
    twilio_from = os.getenv("TWILIO_PHONE_NUMBER", "") or os.getenv("TWILIO_FROM", "")
    if twilio_sid and twilio_token and twilio_from:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{twilio_sid}/Messages.json",
                    auth=(twilio_sid, twilio_token),
                    data={"From": twilio_from, "To": phone, "Body": message},
                )
                if r.status_code in (200, 201):
                    logger.info(f"SMS reply sent via Twilio to {_hash_phone(phone)}")
                    return
        except Exception as e:
            logger.warning(f"Twilio send failed: {e}")

    logger.warning(f"No SMS gateway configured - reply not sent to {_hash_phone(phone)}")


# ── Status ─────────────────────────────────────────────────────────────────────

@sms_router.get("/status")
async def sms_status():
    return {
        "status": "SMS Bot Online",
        "webhook_path_configured": bool(SMS_WEBHOOK_SECRET),
        "exotel_configured": bool(EXOTEL_SID and EXOTEL_API_KEY),
        "twilio_configured": bool(os.getenv("TWILIO_ACCOUNT_SID")),
        "recent_messages": len(_recent_messages),
    }


@sms_router.get("/webhook-url")
async def get_sms_webhook_url(request: Request):
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")
    base = str(request.base_url).rstrip("/")
    return {
        "webhook_url": f"{base}/api/v1/sms/webhook/{SMS_WEBHOOK_SECRET}",
        "note": "Configure this URL in your SMS gateway (Exotel/Twilio) as the incoming SMS webhook.",
    }
