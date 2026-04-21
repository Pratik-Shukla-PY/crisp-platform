"""
IVR Webhook — FastAPI router for voice call-based incident reporting.
Supports BOTH Exotel (India) and Twilio Voice API.

Simplified 2-step call flow (no buttons needed):
  Step 1: "Say your location" → auto-stops after 10s silence or * key (max 30s)
  Step 2: "Describe your problem" → auto-stops after 20s silence or * key (max 120s)
  → "Thank you, goodbye." → Hangup

Background processing after call:
  1. Download both recordings from Twilio (WAV format, authenticated)
  2. Whisper transcribes both to English (task="translate")
  3. Claude AI fixes mangled place names (geocoder with prompt caching)
  4. Mapbox geocodes the corrected place name
  5. Report created with caller_info (phone, network city/state/country)
  6. Both audio recordings uploaded as chunked media

AI Assessment (type/severity classification) is triggered manually by admin
on the dashboard — not auto-run (saves API costs).

Caller detection:
  - Inbound calls: caller = From (production)
  - Outbound calls (Twilio API test): caller = To (the person being called)

Endpoints:
  POST /webhook/{secret}    → Step 1: Welcome + record location
  POST /describe/{secret}   → Step 2: Record description
  POST /done/{secret}       → Step 3: Thank you + background processing
  POST /exotel/{secret}     → Exotel Passthru Applet (alternate entry)
  GET  /status              → Bot status
  GET  /webhook-url         → Get configured URLs (local only)
"""
import os
import hashlib
import logging
import secrets
import base64
from uuid import uuid4
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks
from fastapi.responses import Response

logger = logging.getLogger(__name__)

ivr_router = APIRouter()

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")
IVR_WEBHOOK_SECRET = os.getenv("IVR_WEBHOOK_PATH_SECRET", secrets.token_urlsafe(16))
EXOTEL_SID = os.getenv("EXOTEL_SID", "")
EXOTEL_API_KEY = os.getenv("EXOTEL_API_KEY", "")
EXOTEL_API_TOKEN = os.getenv("EXOTEL_API_TOKEN", "")

_ivr_sessions = {}


def _hash_phone(phone: str) -> str:
    return "IVR-" + hashlib.sha256(phone.encode()).hexdigest()[:16]


def _get_base_url(request: Request) -> str:
    """Get the public-facing base URL (works behind ngrok)."""
    forwarded = request.headers.get("x-forwarded-proto", "")
    host = request.headers.get("x-forwarded-host", "") or request.headers.get("host", "")
    if forwarded and host:
        return f"{forwarded}://{host}"
    return str(request.base_url).rstrip("/")


def _extract_params(request: Request, form_data: dict = None) -> dict:
    """Merge query params + POST form into a single dict."""
    params = dict(request.query_params)
    if form_data:
        params.update(form_data)
    return params


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: Incoming call → Welcome + Record location (voice, auto-stop)
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.api_route(f"/webhook/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def handle_incoming_call(request: Request):
    """Entry point: play welcome, ask for location. Auto-stops after 3s silence.

    P2.16 — rate limited per IP (Twilio/Exotel all call from a small pool of
    IPs, so this is only protective against a leaked URL path being spammed
    by a hostile actor; legitimate traffic is comfortably under the limit).
    """
    from app.main import check_rate_limit
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(f"ivr_webhook:{client_ip}", max_requests=120, window=60):
        raise HTTPException(status_code=429, detail="rate limit")

    params = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            params.update(dict(form))
        except:
            pass

    call_sid = params.get("CallSid") or str(uuid4())
    direction = params.get("Direction") or ""

    # For outbound (Twilio API test): actual caller is "To"
    if "outbound" in direction.lower():
        phone = params.get("To") or params.get("Called") or ""
        caller_city = params.get("ToCity") or params.get("CalledCity") or ""
        caller_state = params.get("ToState") or params.get("CalledState") or ""
        caller_country = params.get("ToCountry") or params.get("CalledCountry") or ""
        caller_zip = params.get("ToZip") or params.get("CalledZip") or ""
    else:
        phone = params.get("From") or params.get("CallFrom") or params.get("from") or ""
        caller_city = params.get("FromCity") or params.get("CallerCity") or ""
        caller_state = params.get("FromState") or params.get("CallerState") or ""
        caller_country = params.get("FromCountry") or params.get("CallerCountry") or ""
        caller_zip = params.get("FromZip") or params.get("CallerZip") or ""

    _ivr_sessions[call_sid] = {
        "phone_hash": _hash_phone(phone),
        "phone": phone,
        "caller_number": phone,
        "caller_city": caller_city,
        "caller_state": caller_state,
        "caller_country": caller_country,
        "caller_zip": caller_zip,
        "location_audio_url": "",
        "audio_url": "",
        "step": "record_location",
    }

    base = _get_base_url(request)
    loc_url = f"{base}/api/v1/ivr/location-step/{IVR_WEBHOOK_SECRET}?sid={call_sid}"

    logger.info(f"IVR call from {_hash_phone(phone)}, sid={call_sid[:12]}")

    # Step 0: Language selection + privacy notice + ask location
    # Uses Gather with timeout=5 — if user presses a key, route to language handler
    # If no key pressed (timeout), default to English and proceed to location
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="{loc_url}" method="POST" numDigits="1" timeout="5">
        <Say voice="Polly.Joanna" language="en-US">Welcome to CRISP Crisis Reporting.
This call is recorded to help rescue teams. Your data is anonymized.
Press 1 for English.
Press 2 for Hindi.
Press 3 for Spanish.
Press 4 for French.
Press 5 for Arabic.
Or just start speaking after the beep.</Say>
    </Gather>
    <Redirect method="POST">{loc_url}?lang=en</Redirect>
</Response>"""

    return Response(content=xml, media_type="application/xml")


# IVR language → Polly voice + language code
_IVR_VOICES = {
    "en": ("Polly.Joanna", "en-US"),
    "hi": ("Polly.Aditi", "hi-IN"),
    "es": ("Polly.Lupe", "es-US"),
    "fr": ("Polly.Lea", "fr-FR"),
    "ar": ("Polly.Zeina", "ar-XA"),
    "ru": ("Polly.Tatyana", "ru-RU"),
    "zh": ("Polly.Zhiyu", "cmn-CN"),
}

_IVR_PROMPTS = {
    "en": {"loc": "Please say your location. Your village, city, or nearest landmark.",
           "desc": "Now describe your problem. What happened and how serious is it.",
           "done": "Thank you. Your report has been received. Rescue teams will be notified. Stay safe. Goodbye."},
    "hi": {"loc": "कृपया अपना स्थान बताएं। गांव, शहर, या नजदीकी स्थान।",
           "desc": "अब अपनी समस्या बताएं। क्या हुआ और कितना गंभीर है।",
           "done": "धन्यवाद। आपकी रिपोर्ट मिल गई। बचाव दल को सूचित किया जाएगा। सुरक्षित रहें।"},
    "es": {"loc": "Diga su ubicacion. Pueblo, ciudad o punto de referencia.",
           "desc": "Describa su problema. Que paso y que tan grave es.",
           "done": "Gracias. Su reporte ha sido recibido. Los equipos de rescate seran notificados."},
    "fr": {"loc": "Dites votre emplacement. Village, ville ou repere.",
           "desc": "Decrivez votre probleme. Que s'est-il passe.",
           "done": "Merci. Votre rapport a ete recu. Les secours seront alertes."},
    "ar": {"loc": "قل موقعك. القرية أو المدينة أو أقرب معلم.",
           "desc": "صف مشكلتك. ماذا حدث وما مدى خطورته.",
           "done": "شكراً. تم استلام تقريرك. سيتم إبلاغ فرق الإنقاذ."},
}

_DIGIT_LANG = {"1": "en", "2": "hi", "3": "es", "4": "fr", "5": "ar"}


@ivr_router.api_route(f"/location-step/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def handle_location_step(request: Request):
    """Receives language selection (if any), then asks for location."""
    params = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            params.update(dict(form))
        except:
            pass

    call_sid = params.get("sid", "") or params.get("CallSid", "")
    digits = params.get("Digits", "")
    lang = _DIGIT_LANG.get(digits, params.get("lang", "en"))

    session = _ivr_sessions.get(call_sid, {})
    session["lang"] = lang
    _ivr_sessions[call_sid] = session

    voice, voice_lang = _IVR_VOICES.get(lang, _IVR_VOICES["en"])
    prompts = _IVR_PROMPTS.get(lang, _IVR_PROMPTS["en"])

    base = _get_base_url(request)
    next_url = f"{base}/api/v1/ivr/describe/{IVR_WEBHOOK_SECRET}?sid={call_sid}"

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="{voice}" language="{voice_lang}">{prompts['loc']}</Say>
    <Record action="{next_url}" method="POST"
            maxLength="30" timeout="10" finishOnKey="*"
            playBeep="true" transcribe="false"/>
    <Redirect method="POST">{next_url}</Redirect>
</Response>"""

    return Response(content=xml, media_type="application/xml")


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Receive location → Ask to describe problem (voice, auto-stop)
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.api_route(f"/describe/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def handle_describe(request: Request, background_tasks: BackgroundTasks):
    """
    Receives location recording (if any), asks user to describe problem.
    If user didn't record location (timeout/no speech), we still continue —
    better to get partial data than nothing.
    """
    params = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            params.update(dict(form))
        except:
            pass

    call_sid = params.get("sid", "") or params.get("CallSid", "")
    recording_url = params.get("RecordingUrl") or params.get("RecordUrl") or ""

    session = _ivr_sessions.get(call_sid, {})
    if recording_url:
        session["location_audio_url"] = recording_url
        logger.info(f"IVR location recorded: sid={call_sid[:12]}")
    else:
        logger.info(f"IVR no location recording (timeout/silence): sid={call_sid[:12]}")

    session["step"] = "record_description"
    _ivr_sessions[call_sid] = session

    base = _get_base_url(request)
    done_url = f"{base}/api/v1/ivr/done/{IVR_WEBHOOK_SECRET}?sid={call_sid}"

    # Step 2: Ask to describe problem in user's selected language
    lang = session.get("lang", "en")
    voice, voice_lang = _IVR_VOICES.get(lang, _IVR_VOICES["en"])
    prompts = _IVR_PROMPTS.get(lang, _IVR_PROMPTS["en"])

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="{voice}" language="{voice_lang}">{prompts['desc']}</Say>
    <Record action="{done_url}" method="POST"
            maxLength="120" timeout="20" finishOnKey="*"
            playBeep="true" transcribe="false"/>
    <Redirect method="POST">{done_url}</Redirect>
</Response>"""

    return Response(content=xml, media_type="application/xml")


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: Receive description → Thank you + submit in background
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.api_route(f"/done/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def handle_done(request: Request, background_tasks: BackgroundTasks):
    """
    Receives description recording (if any). Thanks the user and hangs up.
    Processes everything in background — even partial data gets submitted.
    """
    params = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            params.update(dict(form))
        except:
            pass

    call_sid = params.get("sid", "") or params.get("CallSid", "")
    recording_url = params.get("RecordingUrl") or params.get("RecordUrl") or ""

    session = _ivr_sessions.get(call_sid, {})
    if recording_url:
        session["audio_url"] = recording_url
        logger.info(f"IVR description recorded: sid={call_sid[:12]}")
    else:
        logger.info(f"IVR no description recording (timeout/silence): sid={call_sid[:12]}")

    session["step"] = "done"
    _ivr_sessions[call_sid] = session

    # Always process — even if we only got location or only description
    background_tasks.add_task(_process_ivr_report, call_sid)

    lang = session.get("lang", "en")
    voice, voice_lang = _IVR_VOICES.get(lang, _IVR_VOICES["en"])
    prompts = _IVR_PROMPTS.get(lang, _IVR_PROMPTS["en"])

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="{voice}" language="{voice_lang}">{prompts['done']}</Say>
    <Hangup/>
</Response>"""

    return Response(content=xml, media_type="application/xml")


# ═══════════════════════════════════════════════════════════════════════════════
# Background: Download audio → Transcribe → AI extract → Geocode → Report
# ═══════════════════════════════════════════════════════════════════════════════

async def _download_and_transcribe(audio_url: str, label: str = "audio") -> tuple:
    """Download a Twilio/Exotel recording and transcribe it. Returns (transcription, audio_bytes)."""
    import httpx
    import tempfile

    if not audio_url:
        return "", b""

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            if EXOTEL_API_KEY and "exotel" in audio_url.lower():
                r = await c.get(audio_url, auth=(EXOTEL_API_KEY, EXOTEL_API_TOKEN))
            else:
                twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
                twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")
                if twilio_sid and twilio_token and "twilio" in audio_url.lower():
                    r = await c.get(audio_url + ".wav", auth=(twilio_sid, twilio_token))
                else:
                    r = await c.get(audio_url)

            if r.status_code == 200 and len(r.content) > 100:
                audio_bytes = r.content
                logger.info(f"IVR {label} downloaded: {len(audio_bytes):,} bytes")

                ext = ".wav" if "wav" in audio_url else ".mp3"
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                    f.write(audio_bytes)
                    audio_path = f.name
                try:
                    import sys
                    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))
                    from app.services.ai_service import ai_service
                    transcription = ai_service.transcribe_audio(audio_path)
                    if transcription:
                        logger.info(f"IVR {label} transcribed: '{transcription[:80]}'")
                    return transcription or "", audio_bytes
                except Exception as e:
                    logger.warning(f"IVR {label} transcription error: {e}")
                    return "", audio_bytes
                finally:
                    try:
                        os.unlink(audio_path)
                    except:
                        pass
            else:
                logger.warning(f"IVR {label} download failed: status={r.status_code}")
    except Exception as e:
        logger.error(f"IVR {label} download error: {e}")

    return "", b""


async def _process_ivr_report(call_sid: str):
    """Download audio, transcribe via Whisper, geocode, create CRISP report.
    AI (Claude) determines type + severity from description — no DTMF needed."""
    import httpx

    session = _ivr_sessions.get(call_sid)
    if not session:
        return

    phone_hash = session["phone_hash"]

    # ── 1. Transcribe LOCATION recording ─────────────────────────────────────
    location_url = session.get("location_audio_url", "")
    location_text, location_audio_bytes = await _download_and_transcribe(location_url, "location")
    location_b64 = base64.b64encode(location_audio_bytes).decode() if location_audio_bytes else ""

    # ── 2. Transcribe DESCRIPTION recording ──────────────────────────────────
    desc_url = session.get("audio_url", "")
    description_text, desc_audio_bytes = await _download_and_transcribe(desc_url, "description")
    audio_b64 = base64.b64encode(desc_audio_bytes).decode() if desc_audio_bytes else ""

    # Combined text for AI extraction
    full_text = ""
    if location_text and description_text:
        full_text = f"Location: {location_text}. Situation: {description_text}"
    elif description_text:
        full_text = description_text
    elif location_text:
        full_text = location_text

    if not full_text and not location_b64 and not audio_b64:
        logger.warning(f"IVR call {call_sid[:12]}: no recordings at all, skipping report")
        _ivr_sessions.pop(call_sid, None)
        return

    # ── 3. Geocode — try location recording first, then description, then both
    # User might say location in step 1, step 2, or both
    from messaging_bot.sms.geocoder import geocode_text
    geo = {"latitude": None, "longitude": None, "location_name": "", "confidence": "low"}

    # Try location recording first (dedicated location step)
    if location_text:
        geo = await geocode_text(location_text)
        logger.info(f"IVR geocoded location audio: '{location_text}' → {geo.get('location_name', 'unknown')}")

    # If location step failed/empty, try the description — user may have
    # mentioned location while describing ("I am in Bansdih and there is a flood")
    if not geo.get("latitude") and description_text:
        geo = await geocode_text(description_text)
        logger.info(f"IVR geocoded from description: '{description_text[:60]}' → {geo.get('location_name', 'unknown')}")

    # Last resort: combine both texts and try — AI geocoder can pick up
    # fragmented location mentions across both recordings
    if not geo.get("latitude") and location_text and description_text:
        combined = f"{location_text} {description_text}"
        geo = await geocode_text(combined)
        logger.info(f"IVR geocoded combined text → {geo.get('location_name', 'unknown')}")

    # ── 4. Build caller info for control center ────────────────────────────
    caller_info = {
        "phone": session.get("caller_number", ""),
        "network_city": session.get("caller_city", ""),
        "network_state": session.get("caller_state", ""),
        "network_country": session.get("caller_country", ""),
        "network_zip": session.get("caller_zip", ""),
    }
    net_parts = [p for p in [caller_info["network_city"], caller_info["network_state"], caller_info["network_country"]] if p]
    caller_info["network_location"] = ", ".join(net_parts) if net_parts else ""

    # ── 5. Create CRISP report (type=OTHER, severity=SEVERE as defaults) ─────
    # AI extractor will update type + severity after analyzing the text
    meta = {
        "device_hash": phone_hash,
        "client_report_id": str(uuid4()),
        "source": "IVR",
        "severity": "SEVERE",
        "infrastructure_type": "OTHER",
        "description": full_text or "Voice report — awaiting AI analysis",
        "expected_media": (1 if location_b64 else 0) + (1 if audio_b64 else 0),
        "caller_info": caller_info,
    }

    if geo.get("latitude"):
        meta["location"] = {
            "latitude": geo["latitude"],
            "longitude": geo["longitude"],
            "device_latitude": geo["latitude"],
            "device_longitude": geo["longitude"],
            "accuracy_meters": 5000.0 if geo.get("confidence") == "low" else 2000.0,
            "device_location_name": geo.get("location_name", location_text or ""),
        }

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{BACKEND_URL}/api/v1/reports/meta", json=meta)
            if r.status_code in (200, 201):
                report = r.json()
                report_id = report["id"]
                logger.info(f"IVR report created: {report_id} loc={geo.get('location_name', 'none')}")

                # Attach location audio
                if location_b64:
                    from messaging_bot.chunked_uploader import upload_media_chunked
                    await upload_media_chunked(report_id, location_b64, "AUDIO", "audio/wav")
                    logger.info(f"IVR location audio uploaded for {report_id}")

                # Attach description audio
                if audio_b64:
                    from messaging_bot.chunked_uploader import upload_media_chunked
                    await upload_media_chunked(report_id, audio_b64, "AUDIO", "audio/wav")
                    logger.info(f"IVR description audio uploaded for {report_id}")

                # AI extraction removed — admin triggers AI Assessment on dashboard instead
                # This saves 1 Claude API call per IVR report
            else:
                logger.error(f"IVR report creation failed ({r.status_code})")
    except Exception as e:
        logger.error(f"IVR report submission error: {e}")

    # Cleanup
    _ivr_sessions.pop(call_sid, None)


# ═══════════════════════════════════════════════════════════════════════════════
# Exotel Passthru Applet — alternate entry point for Exotel's applet system
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.api_route(f"/exotel/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def exotel_passthru(request: Request, background_tasks: BackgroundTasks):
    """
    Exotel Passthru Applet — receives call data AFTER Record applets.
    Processes the recording in background and returns 200 OK.
    """
    params = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            params.update(dict(form))
        except:
            pass

    call_sid = params.get("CallSid", str(uuid4()))
    phone = params.get("CallFrom") or params.get("From") or params.get("from") or ""
    recording_url = params.get("RecordingUrl") or params.get("RecordUrl") or params.get("recording_url") or ""

    for key in params:
        if "record" in key.lower() and "url" in key.lower() and params[key]:
            recording_url = params[key]
            break

    phone_hash = _hash_phone(phone)
    logger.info(f"Exotel Passthru: phone={phone_hash} recording={'yes' if recording_url else 'no'}")

    _ivr_sessions[call_sid] = {
        "phone_hash": phone_hash,
        "phone": phone,
        "caller_number": phone,
        "audio_url": recording_url,
        "step": "done",
    }

    background_tasks.add_task(_process_ivr_report, call_sid)
    return {"status": "received"}


# ═══════════════════════════════════════════════════════════════════════════════
# Status & Info
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.get("/status")
async def ivr_status():
    return {
        "status": "IVR Bot Online",
        "active_calls": len([s for s in _ivr_sessions.values() if s.get("step") != "done"]),
        "webhook_configured": bool(IVR_WEBHOOK_SECRET),
        "exotel_configured": bool(EXOTEL_SID and EXOTEL_API_KEY),
        "twilio_configured": bool(os.getenv("TWILIO_ACCOUNT_SID")),
    }


@ivr_router.get("/webhook-url")
async def get_ivr_webhook_url(request: Request):
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")
    base = str(request.base_url).rstrip("/")
    return {
        "webhook_url": f"{base}/api/v1/ivr/webhook/{IVR_WEBHOOK_SECRET}",
        "exotel_applet_url": f"{base}/api/v1/ivr/exotel/{IVR_WEBHOOK_SECRET}",
        "note": "For Exotel: use exotel_applet_url as Passthru Applet URL. For Twilio: use webhook_url as Voice webhook.",
    }
