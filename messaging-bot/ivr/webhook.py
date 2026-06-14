"""
IVR Webhook - FastAPI router for voice call-based incident reporting.
Supports BOTH Exotel (India) and Twilio Voice API.

Simplified 2-step call flow (no buttons needed):
  Step 1: "Say your location" → auto-stops after 10s silence or * key (max 30s)
  Step 2: "Describe your problem" → auto-stops after 20s silence or * key (max 120s)
  → "Thank you, goodbye." → Hangup

Background processing after call:
  1. Download both recordings from Twilio (WAV format, authenticated)
  2. Whisper transcribes both to English (task="translate")
  3. AI fixes mangled place names (geocoder with prompt caching)
  4. Mapbox geocodes the corrected place name
  5. Report created with caller_info (phone, network city/state/country)
  6. Both audio recordings uploaded as chunked media

AI Assessment (type/severity classification) is triggered manually by admin
on the dashboard - not auto-run (saves API costs).

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
import asyncio
import logging
import secrets
import base64
from uuid import uuid4
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks
from fastapi.responses import Response

logger = logging.getLogger(__name__)

ivr_router = APIRouter()

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")


def _resolve_ivr_secret() -> str:
    """Resolve the IVR webhook path secret with persistence across
    container rebuilds.

    Precedence:
      1. `IVR_WEBHOOK_PATH_SECRET` env var (operator-controlled, stable).
      2. Cached value at `/data/.ivr_webhook_secret` (host-mounted
         volume - survives docker rebuilds).
      3. New random `secrets.token_urlsafe(16)`, then persisted to
         the cache file when possible.

    Without this, each backend image rebuild generated a fresh
    random secret, silently breaking the Twilio Voice webhook URL
    configured in the Twilio admin console (which still pointed at
    the prior secret → 404 → Twilio plays
    "An application error has occurred. Goodbye.").
    """
    env_secret = os.getenv("IVR_WEBHOOK_PATH_SECRET", "").strip()
    if env_secret:
        return env_secret
    cache_path = os.getenv(
        "IVR_WEBHOOK_SECRET_CACHE",
        "/data/.ivr_webhook_secret",
    )
    # Try to read a cached value.
    try:
        if os.path.exists(cache_path):
            with open(cache_path, "r") as fh:
                cached = fh.read().strip()
            if cached:
                return cached
    except (OSError, IOError):
        pass
    # Generate + persist.
    fresh = secrets.token_urlsafe(16)
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w") as fh:
            fh.write(fresh)
        try:
            os.chmod(cache_path, 0o600)
        except OSError:
            pass
    except (OSError, IOError):
        # Read-only filesystem - fall back to in-memory (will rotate
        # on every restart, but we log loudly below so the operator
        # can re-sync Twilio).
        pass
    return fresh


IVR_WEBHOOK_SECRET = _resolve_ivr_secret()
# emit the public webhook URL on import so the operator
# can pick it up from `docker logs <backend-container>` after a fresh
# deploy and verify the Twilio admin console still points at the
# correct URL. We only log a TRUNCATED hint of the secret (last 6
# chars) in case CloudWatch / log aggregators get exfiltrated; the
# full URL is available via the localhost-only /webhook-url endpoint.
logging.getLogger(__name__).info(
    "IVR webhook secret resolved (suffix=…%s) - set IVR_WEBHOOK_PATH_SECRET "
    "in .env.production to keep this stable across rebuilds. The full URL "
    "is exposed via GET /api/v1/ivr/webhook-url (localhost only).",
    IVR_WEBHOOK_SECRET[-6:] if len(IVR_WEBHOOK_SECRET) >= 6 else IVR_WEBHOOK_SECRET,
)

EXOTEL_SID = os.getenv("EXOTEL_SID", "")
EXOTEL_API_KEY = os.getenv("EXOTEL_API_KEY", "")
EXOTEL_API_TOKEN = os.getenv("EXOTEL_API_TOKEN", "")

_ivr_sessions = {}


def _hash_phone(phone: str) -> str:
    return "IVR-" + hashlib.sha256(phone.encode()).hexdigest()[:16]


def _get_base_url(request: Request) -> str:
    """Get the public-facing base URL the caller (Twilio) should hit
    for the next TwiML step.

    Handles the layered-proxy gotcha. In production the request path is:

        Twilio  ──https──▶  ALB / CloudFront  ──http──▶  nginx  ──http──▶  backend

    The ALB terminates TLS and forwards to nginx on port 80 with
    `X-Forwarded-Proto: https` set. Nginx's own
    `proxy_set_header X-Forwarded-Proto $scheme;` (see nginx.conf)
    then OVERWRITES that header with `http` because nginx's own
    `$scheme` for the ALB-to-nginx connection is http. The backend
    ends up seeing `X-Forwarded-Proto: http` → renders TwiML callback
    URLs as `http://undp.crisplabs.tech/...` → Twilio breaks on the
    second hop with "An application error has occurred. Goodbye."

    Fix: for known public hostnames we force `https` regardless of
    what header value reached us. Everything else honours the header
    if present, then falls back to nginx-supplied `$scheme`.
    """
    forwarded_proto = request.headers.get("x-forwarded-proto", "").strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").strip()
    # Multi-hop proxies can produce a comma-separated list; the
    # left-most entry is the original client-facing value.
    if "," in forwarded_proto:
        forwarded_proto = forwarded_proto.split(",")[0].strip()
    if "," in forwarded_host:
        forwarded_host = forwarded_host.split(",")[0].strip()
    host = forwarded_host or request.headers.get("host", "").strip()
    if not host:
        return str(request.base_url).rstrip("/")

    # Public hostnames are HTTPS in production. The layered-proxy
    # path strips that signal; this list pins it back deterministically.
    is_public_https_host = (
        host.endswith(".crisplabs.tech")
        or host.endswith(".ngrok.io")
        or host.endswith(".ngrok-free.app")
        or host.endswith(".trycloudflare.com")
    )
    if is_public_https_host:
        scheme = "https"
    elif forwarded_proto in ("http", "https"):
        scheme = forwarded_proto
    elif host.startswith(("localhost", "127.0.0.1", "0.0.0.0", "backend")):
        scheme = "http"
    else:
        # Unknown host: default to https (Twilio + most public hosts).
        scheme = "https"
    return f"{scheme}://{host}"


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

    P2.16 - rate limited per IP (Twilio/Exotel all call from a small pool of
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

    # pre-select a default language based on the caller's
    # country (Twilio's `FromCountry` / `CallerCountry`). The digit-
    # pick menu still lets the caller override, but if they just stay
    # silent during the Gather we route to their country's likely
    # language instead of always defaulting to English. The location
    # prompt (step 1) is then read out in that language.
    default_lang = _country_to_lang(caller_country)

    _ivr_sessions[call_sid] = {
        "phone_hash": _hash_phone(phone),
        "phone": phone,
        "caller_number": phone,
        "caller_city": caller_city,
        "caller_state": caller_state,
        "caller_country": caller_country,
        "caller_zip": caller_zip,
        "default_lang": default_lang,
        "location_audio_url": "",
        "audio_url": "",
        "step": "record_location",
    }

    base = _get_base_url(request)
    loc_url = f"{base}/api/v1/ivr/location-step/{IVR_WEBHOOK_SECRET}?sid={call_sid}"

    logger.info(
        f"IVR call from {_hash_phone(phone)}, sid={call_sid[:12]}, "
        f"country={caller_country!r}, default_lang={default_lang}"
    )

    # Step 0: Language selection + privacy notice + ask location.
    # Gather with timeout=5; if the caller presses 1-5, the
    # location-step handler picks that language; otherwise the
    # Redirect routes to the country's default language.
    #
    # each language's prompt is now spoken in THAT
    # language's own Polly voice. A Hindi speaker hears their
    # option in Hindi ("हिन्दी के लिए 2 दबाएं") instead of an
    # English narrator listing language names. Helps low-literacy
    # callers recognise their language is supported. Each <Say>
    # uses the language-appropriate Polly voice + locale.
    #
    # the fallback URL uses `&amp;lang=…` (not `?lang=…`)
    # because loc_url already carries a `?sid=…` query string.
    # Arabic language code is "ar-XA" (Twilio's accepted form) - not
    # "arb" (AWS Polly's MSA code, which Twilio rejects). Twilio's
    # `<Say>` validation rejects the whole TwiML response when ANY
    # voice/language combo is unrecognised, which silently drops
    # the call (no audio at all on the caller end). The rest of the
    # CRISP codebase has always used "ar-XA" with Polly.Zeina in
    # `_IVR_VOICES`; the welcome menu now matches.
    # May 2026 - extended language menu from 5 → 7 options. Russian +
    # Chinese added with native-voice <Say> lines (Polly.Tatyana ru-RU,
    # Polly.Zhiyu cmn-CN - voice IDs already in _IVR_VOICES). The
    # Gather's `timeout="6"` is silence-after-prompt, not total time,
    # so the additional ~4 s of menu audio doesn't change the effective
    # DTMF wait.
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="{loc_url}" method="POST" numDigits="1" timeout="6">
        <Say voice="Polly.Joanna" language="en-US">Welcome to CRISP Crisis Reporting. This call is recorded to help rescue teams. Your data is anonymized.</Say>
        <Say voice="Polly.Joanna" language="en-US">For English, press 1.</Say>
        <Say voice="Polly.Aditi" language="hi-IN">हिन्दी के लिए, 2 दबाएं।</Say>
        <Say voice="Polly.Lupe" language="es-US">Para español, presione 3.</Say>
        <Say voice="Polly.Lea" language="fr-FR">Pour français, appuyez sur 4.</Say>
        <Say voice="Polly.Zeina" language="ar-XA">للعربية، اضغط 5.</Say>
        <Say voice="Polly.Tatyana" language="ru-RU">Для русского языка, нажмите 6.</Say>
        <Say voice="Polly.Zhiyu" language="cmn-CN">中文请按 7。</Say>
        <Say voice="Polly.Joanna" language="en-US">Or just start speaking after the beep.</Say>
    </Gather>
    <Redirect method="POST">{loc_url}&amp;lang={default_lang}</Redirect>
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

# May 2026 (operator-reported) - each `loc` and `desc` prompt now ends
# with a native-language "press star to finish" instruction so callers
# who speak quickly don't sit through the silence timeout (10 s for
# location, 20 s for description). Capability has been in place since
# day one (`finishOnKey="*"` on both <Record> verbs at line ~441,493),
# but no audio prompt told callers it existed. Discovery fix only -
# no logic / timeout changes.
#
# Russian + Chinese added in the same change (operator scope expansion).
# Voice IDs already existed in `_IVR_VOICES` above (Polly.Tatyana / ru-RU
# and Polly.Zhiyu / cmn-CN); only the prompts + the welcome-menu digit
# mapping needed wiring.
_IVR_PROMPTS = {
    "en": {"loc": "Please say your location. Your village, city, or nearest landmark. When you're done speaking, press star.",
           "desc": "Now describe your problem. What happened and how serious is it. When you're done speaking, press star.",
           "done": "Thank you. Your report has been received. Rescue teams will be notified. Stay safe. Goodbye."},
    "hi": {"loc": "कृपया अपना स्थान बताएं। गांव, शहर, या नजदीकी स्थान। बोलने के बाद, स्टार दबाएं।",
           "desc": "अब अपनी समस्या बताएं। क्या हुआ और कितना गंभीर है। बोलने के बाद, स्टार दबाएं।",
           "done": "धन्यवाद। आपकी रिपोर्ट मिल गई। बचाव दल को सूचित किया जाएगा। सुरक्षित रहें।"},
    "es": {"loc": "Diga su ubicacion. Pueblo, ciudad o punto de referencia. Cuando termine de hablar, presione asterisco.",
           "desc": "Describa su problema. Que paso y que tan grave es. Cuando termine de hablar, presione asterisco.",
           "done": "Gracias. Su reporte ha sido recibido. Los equipos de rescate seran notificados."},
    "fr": {"loc": "Dites votre emplacement. Village, ville ou repere. Lorsque vous avez termine, appuyez sur etoile.",
           "desc": "Decrivez votre probleme. Que s'est-il passe. Lorsque vous avez termine, appuyez sur etoile.",
           "done": "Merci. Votre rapport a ete recu. Les secours seront alertes."},
    "ar": {"loc": "قل موقعك. القرية أو المدينة أو أقرب معلم. عندما تنتهي من الكلام، اضغط على النجمة.",
           "desc": "صف مشكلتك. ماذا حدث وما مدى خطورته. عندما تنتهي من الكلام، اضغط على النجمة.",
           "done": "شكراً. تم استلام تقريرك. سيتم إبلاغ فرق الإنقاذ."},
    "ru": {"loc": "Пожалуйста, скажите ваше местоположение. Деревня, город или ближайший ориентир. Закончив говорить, нажмите звёздочку.",
           "desc": "Теперь опишите вашу проблему. Что случилось и насколько серьёзно. Закончив говорить, нажмите звёздочку.",
           "done": "Спасибо. Ваш отчёт получен. Спасательные службы будут уведомлены. Будьте в безопасности."},
    "zh": {"loc": "请说出您的位置。村庄、城市或最近的地标。说完后请按星号键。",
           "desc": "现在请描述您的问题。发生了什么以及严重程度。说完后请按星号键。",
           "done": "谢谢您。您的报告已收到。救援队伍将收到通知。请保持安全。"},
}

# Welcome-menu DTMF map. May 2026 - extended from 5 → 7 languages
# (added Russian = 6 and Chinese = 7). The Gather verb in
# handle_incoming_call below renders one <Say> line per language.
_DIGIT_LANG = {"1": "en", "2": "hi", "3": "es", "4": "fr", "5": "ar", "6": "ru", "7": "zh"}

# caller-country → default IVR language. Twilio's webhook
# payload includes a `FromCountry` field (ISO-3166-1 alpha-2) when
# available; we use it to pre-select a language so the caller doesn't
# have to press a digit. Falls back to English when the country
# isn't mapped or `FromCountry` is missing.
_COUNTRY_LANG = {
    # South Asia → Hindi
    "IN": "hi", "BD": "hi", "NP": "hi", "PK": "hi", "LK": "hi",
    # Spanish-speaking
    "ES": "es", "MX": "es", "AR": "es", "CO": "es", "CL": "es",
    "PE": "es", "VE": "es", "EC": "es", "GT": "es", "CU": "es",
    "BO": "es", "DO": "es", "HN": "es", "PY": "es", "SV": "es",
    "NI": "es", "CR": "es", "PA": "es", "UY": "es",
    # French-speaking
    "FR": "fr", "BE": "fr", "CH": "fr", "LU": "fr", "MC": "fr",
    "SN": "fr", "CI": "fr", "ML": "fr", "BF": "fr", "BJ": "fr",
    "CM": "fr", "CG": "fr", "CD": "fr", "GA": "fr", "GN": "fr",
    "MG": "fr", "NE": "fr", "RW": "fr", "TG": "fr", "DJ": "fr",
    "HT": "fr",
    # Arabic-speaking
    "SA": "ar", "AE": "ar", "EG": "ar", "JO": "ar", "KW": "ar",
    "QA": "ar", "OM": "ar", "BH": "ar", "YE": "ar", "IQ": "ar",
    "LY": "ar", "LB": "ar", "MA": "ar", "TN": "ar", "DZ": "ar",
    "SY": "ar", "SD": "ar", "PS": "ar", "MR": "ar", "SO": "ar",
}


def _country_to_lang(country_code: str) -> str:
    """Resolve an ISO country code to a CRISP IVR language.

    Returns 'en' if the country is missing, unknown, or invalid.
    Used to pre-select the IVR prompt language so callers don't have
    to press 1-5 manually (they still can; the digit-pick overrides).
    """
    if not country_code:
        return "en"
    return _COUNTRY_LANG.get(country_code.strip().upper(), "en")


def _normalise_geo_confidence(raw):
    """Normalise a geocoder confidence value to a float in [0, 1].

    The CRISP geocoder (`messaging_bot/sms/geocoder.py`) returns either
    a string ("low" | "medium" | "high") OR an already-numeric value
    in some code paths. Heuristic:
      • [0, 1]   pass-through (already normalised).
      • (1, 100] divide by 100 (looks like a percentage).
      • >100     clamp to 1.0 (definitely out of range).
      • <0       clamp to 0.0.
    Slightly-over-1 values (1.0001 … 1.999) get clamped rather than
    divided so a buggy "0.87 but encoded as 1.5" upstream doesn't
    silently become 0.015. Returns None for missing / unrecognised
    inputs so the dashboard's "no confidence" branch fires.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return None
        if v < 0:
            return 0.0
        if v <= 1.0:
            return v
        if v >= 2.0 and v <= 100.0:
            return v / 100.0
        # 1.0 < v < 2.0  → clamp (malformed) ; v > 100 → clamp.
        return 1.0
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("high", "h"):
            return 0.9
        if s in ("medium", "med", "m"):
            return 0.6
        if s in ("low", "l"):
            return 0.3
        try:
            return _normalise_geo_confidence(float(s))
        except (TypeError, ValueError):
            return None
    return None


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
    If user didn't record location (timeout/no speech), we still continue -
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
    Processes everything in background - even partial data gets submitted.
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

    # Always process - even if we only got location or only description
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
    AI (Claude) determines type + severity from description - no DTMF needed."""
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

    # ── 3. Geocode - try location recording first, then description, then both
    # User might say location in step 1, step 2, or both
    from messaging_bot.sms.geocoder import geocode_text
    geo = {"latitude": None, "longitude": None, "location_name": "", "confidence": "low"}

    # Try location recording first (dedicated location step)
    if location_text:
        geo = await geocode_text(location_text)
        logger.info(f"IVR geocoded location audio: '{location_text}' → {geo.get('location_name', 'unknown')}")

    # If location step failed/empty, try the description - user may have
    # mentioned location while describing ("I am in Bansdih and there is a flood")
    if not geo.get("latitude") and description_text:
        geo = await geocode_text(description_text)
        logger.info(f"IVR geocoded from description: '{description_text[:60]}' → {geo.get('location_name', 'unknown')}")

    # Last resort: combine both texts and try - AI geocoder can pick up
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
    # AI extractor will update type + severity after analyzing the text.
    #
    # UNDP "Other, please specify" rule (backend report.py:185) - when
    # we default to OTHER we MUST supply a non-empty infrastructure_name
    # or /reports/meta returns 422 and the IVR call is silently lost.
    # The AI extractor runs ASYNC after the report lands, so we need a
    # placeholder that's informative for the operator until the extractor
    # rewrites it. First ~40 chars of the transcript work well; otherwise
    # a sentinel that flags "voice-only, type unknown".
    _ivr_snippet = (full_text or "").strip()
    _ivr_name_placeholder = (
        _ivr_snippet[:40] if _ivr_snippet
        else "Voice report - type pending AI analysis"
    )
    meta = {
        "device_hash": phone_hash,
        "client_report_id": str(uuid4()),
        "source": "IVR",
        "severity": "SEVERE",
        "infrastructure_type": "OTHER",
        "infrastructure_name": _ivr_name_placeholder,
        "description": full_text or "Voice report - awaiting AI analysis",
        "expected_media": (1 if location_b64 else 0) + (1 if audio_b64 else 0),
        "caller_info": caller_info,
    }

    # normalise geocoder confidence ("low/medium/high" or
    # a raw float) to a [0, 1] float that we can persist + render as
    # a dashboard chip. Source string passes through as-is.
    geo_conf_float = _normalise_geo_confidence(geo.get("confidence"))
    geo_source = geo.get("source") or None

    if geo.get("latitude"):
        meta["location"] = {
            "latitude": geo["latitude"],
            "longitude": geo["longitude"],
            "device_latitude": geo["latitude"],
            "device_longitude": geo["longitude"],
            "accuracy_meters": 5000.0 if geo.get("confidence") == "low" else 2000.0,
            "device_location_name": geo.get("location_name", location_text or ""),
            # persist these so the dashboard can render a
            # confidence chip / colour-coded map pin tooltip on IVR
            # reports (see web-dashboard/src/app.js for the renderer).
            "geocoding_confidence": geo_conf_float,
            "geocoding_source": geo_source,
        }

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{BACKEND_URL}/api/v1/reports/meta", json=meta)
            if r.status_code in (200, 201):
                report = r.json()
                report_id = report["id"]
                logger.info(
                    f"IVR report created: {report_id} "
                    f"loc={geo.get('location_name', 'none')} "
                    f"conf={geo_conf_float} src={geo_source}"
                )

                # audio upload reliability hardening.
                # Original code fired-and-forgot two chunked-uploader
                # calls and assumed success. Real-call observation: the
                # dashboard couldn't play back the IVR audio, suggesting
                # the upload silently failed or attached a Media row
                # the player couldn't load. Now we:
                #   (a) capture the chunked uploader's return value,
                #   (b) on failure, fall back to the single-shot
                #       /reports/{id}/media endpoint (data: URL POST
                #       with `audio/wav` MIME) - slower but more robust
                #       for the small ≤2 MB WAV files Twilio returns,
                #   (c) loudly log success/failure with byte counts so
                #       the operator can grep for upload trouble.
                async def _attach_audio(label, b64_data):
                    if not b64_data:
                        return
                    size_kb = len(b64_data) * 3 // 4 // 1024
                    try:
                        from messaging_bot.chunked_uploader import upload_media_chunked
                        ok = await upload_media_chunked(
                            report_id, b64_data, "AUDIO", "audio/wav",
                        )
                        if ok:
                            logger.info(
                                f"IVR {label} audio uploaded (chunked) "
                                f"for {report_id} ≈{size_kb} KB"
                            )
                            return
                        logger.warning(
                            f"IVR {label} chunked upload returned False; "
                            f"falling back to single-shot attach"
                        )
                    except Exception as ex:
                        logger.warning(
                            f"IVR {label} chunked upload raised: {ex}; "
                            f"falling back to single-shot attach"
                        )
                    # Single-shot fallback: POST the full data: URL to
                    # /reports/{id}/media. The endpoint runs magic-byte
                    # detection and stores with audio/wav content-type
                    # so the dashboard's HTML5 <audio> player works.
                    try:
                        async with httpx.AsyncClient(timeout=60) as cf:
                            data_url = f"data:audio/wav;base64,{b64_data}"
                            rf = await cf.post(
                                f"{BACKEND_URL}/api/v1/reports/{report_id}/media",
                                json={"type": "AUDIO", "url": data_url},
                            )
                            if rf.status_code in (200, 201):
                                logger.info(
                                    f"IVR {label} audio uploaded "
                                    f"(single-shot) for {report_id} "
                                    f"≈{size_kb} KB"
                                )
                            else:
                                logger.error(
                                    f"IVR {label} single-shot upload "
                                    f"failed for {report_id}: "
                                    f"status={rf.status_code} "
                                    f"body={rf.text[:200]}"
                                )
                    except Exception as ex2:
                        logger.error(
                            f"IVR {label} single-shot upload error "
                            f"for {report_id}: {ex2}"
                        )

                await _attach_audio("location", location_b64)
                await _attach_audio("description", audio_b64)

                # restore AI extraction. Claude reads the
                # full English transcription and back-fills
                # infrastructure_type / severity / crisis_type /
                # damage_classification on the Report, replacing the
                # OTHER / SEVERE placeholders above. Wrapped in
                # try/except so a Claude outage never blocks the
                # report - the placeholders persist and the admin can
                # still trigger an AI re-pass manually from the
                # dashboard.
                if full_text:
                    try:
                        from messaging_bot.ai_extractor import (
                            extract_and_update_report,
                        )
                        asyncio.create_task(
                            extract_and_update_report(report_id, full_text)
                        )
                        logger.info(
                            f"IVR AI extraction scheduled for {report_id}"
                        )
                    except Exception as ex:
                        logger.warning(
                            f"IVR AI extraction kickoff failed for "
                            f"{report_id}: {ex}"
                        )
            else:
                logger.error(f"IVR report creation failed ({r.status_code})")
    except Exception as e:
        logger.error(f"IVR report submission error: {e}")

    # Cleanup
    _ivr_sessions.pop(call_sid, None)


# ═══════════════════════════════════════════════════════════════════════════════
# Exotel Passthru Applet - alternate entry point for Exotel's applet system
# ═══════════════════════════════════════════════════════════════════════════════

@ivr_router.api_route(f"/exotel/{IVR_WEBHOOK_SECRET}", methods=["GET", "POST"])
async def exotel_passthru(request: Request, background_tasks: BackgroundTasks):
    """
    Exotel Passthru Applet - receives call data AFTER Record applets.
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
