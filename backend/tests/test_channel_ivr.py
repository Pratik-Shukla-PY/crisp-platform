"""IVR webhook tests.

Covers the Twilio/Exotel voice-call TwiML flow:
  /webhook/<secret>        → greet + language Gather
  /location-step/<secret>  → ask for location recording
  /describe/<secret>       → ask for description recording
  /done/<secret>           → thank you + kick off background processing

Background processing (audio download, Whisper transcription, geocoding,
report POST) is mocked out — the tests verify the *webhook* contracts,
not the downstream pipeline.
"""
import pytest

import messaging_bot.ivr.webhook as ivr_webhook
import app.main as app_main


IVR_PATH = ivr_webhook.IVR_WEBHOOK_SECRET


def _url(suffix: str) -> str:
    return f"/api/v1/ivr/{suffix}/{IVR_PATH}"


@pytest.fixture(autouse=True)
def _clean_ivr():
    ivr_webhook._ivr_sessions.clear()
    app_main._rate_limits.clear()
    yield
    ivr_webhook._ivr_sessions.clear()
    app_main._rate_limits.clear()


def test_ivr_webhook_greets_caller_and_returns_twiml(client):
    """POST CallSid + From to /webhook → 200 TwiML containing a
    ``<Gather>`` that routes to /location-step/."""
    res = client.post(
        _url("webhook"),
        data={
            "CallSid": "CA-test-001",
            "From": "+919999900020",
            "Direction": "inbound",
        },
    )
    assert res.status_code == 200, res.text
    assert "application/xml" in res.headers.get("content-type", "")
    body = res.text
    assert "<Response>" in body
    assert "<Gather" in body
    # The Gather's action points at /location-step/<secret> — that's
    # the next hop when the user presses a digit (or the Redirect fires).
    assert f"/api/v1/ivr/location-step/{IVR_PATH}" in body
    # Session was recorded so later steps can look it up.
    assert "CA-test-001" in ivr_webhook._ivr_sessions


def test_ivr_welcome_menu_uses_native_voice_per_language(client):
    """Phase 23.3 — each "press N for X" prompt is spoken in language
    X's own Polly voice, not all in English. A Hindi speaker hears
    Hindi pronunciation of "press 2 for Hindi"; an Arabic speaker
    hears Arabic for "press 5 for Arabic"; etc.
    """
    res = client.post(
        _url("webhook"),
        data={"CallSid": "CA-test-multi-lang", "From": "+10000", "Direction": "inbound"},
    )
    body = res.text
    # English line still uses Joanna.
    assert 'voice="Polly.Joanna" language="en-US">For English' in body
    # Hindi → Aditi voice + hi-IN locale + Devanagari script.
    assert 'voice="Polly.Aditi" language="hi-IN">' in body
    assert "हिन्दी" in body
    # Spanish → Lupe voice + Spanish prompt.
    assert 'voice="Polly.Lupe" language="es-US">' in body
    assert "español" in body
    # French → Lea voice + French prompt.
    assert 'voice="Polly.Lea" language="fr-FR">' in body
    assert "français" in body
    # Arabic → Zeina voice + ar-XA locale (NOT "arb" — Twilio's TwiML
    # parser rejects the entire response when it sees an unrecognised
    # language code, dropping the call with no audio at all).
    # ar-XA matches the rest of the CRISP codebase's _IVR_VOICES map.
    assert 'voice="Polly.Zeina" language="ar-XA">' in body
    assert "عربية" in body


def test_ivr_location_step_captures_speech_to_text(client):
    """POST with a Digits selection → 200 TwiML with a ``<Record>`` for
    the user's spoken location.

    The real flow doesn't use SpeechResult (we use <Record>, not
    <Gather input="speech">) — so the assertion is on the <Record>
    element routing forward to /describe/<secret>, which is the
    handler's actual output contract.
    """
    call_sid = "CA-test-loc"
    # Seed a session the way /webhook would.
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-seed",
        "phone": "+9190000",
        "caller_number": "+9190000",
        "step": "record_location",
    }

    res = client.post(
        _url("location-step"),
        data={
            "CallSid": call_sid,
            "sid": call_sid,
            "Digits": "1",          # English
            "SpeechResult": "Bangalore",
        },
    )
    assert res.status_code == 200, res.text
    body = res.text
    assert "<Record" in body
    assert f"/api/v1/ivr/describe/{IVR_PATH}" in body
    # Session now remembers the chosen language.
    assert ivr_webhook._ivr_sessions[call_sid]["lang"] == "en"


def test_ivr_done_creates_report(client, monkeypatch):
    """POST /done/ → 200 TwiML with ``<Hangup/>`` and the background
    ``_process_ivr_report`` coroutine is scheduled.

    The call pipeline does the DB write inside ``_process_ivr_report``
    (Whisper → geocode → HTTP post → report row). That full chain
    requires network + AI and is exercised by other tests. Here we
    stub the coroutine, assert the webhook invokes it with the right
    CallSid, and check the goodbye TwiML is returned to the caller.
    """
    call_sid = "CA-test-done"
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-xyz",
        "phone": "+91123",
        "caller_number": "+91123",
        "caller_city": "",
        "caller_state": "",
        "caller_country": "",
        "caller_zip": "",
        "location_audio_url": "https://fake/location.wav",
        "audio_url": "https://fake/desc.wav",
        "lang": "en",
        "step": "record_description",
    }

    called_with = []

    async def _fake_process(sid):
        called_with.append(sid)

    monkeypatch.setattr(ivr_webhook, "_process_ivr_report", _fake_process)

    res = client.post(
        _url("done"),
        data={
            "CallSid": call_sid,
            "sid": call_sid,
            "RecordingUrl": "https://fake/final.wav",
        },
    )
    assert res.status_code == 200, res.text
    assert "application/xml" in res.headers.get("content-type", "")
    body = res.text
    assert "<Hangup" in body
    assert "Thank you" in body or "Gracias" in body or "शक्रिया" in body or "Merci" in body
    # Background processing was scheduled with the right CallSid.
    assert called_with == [call_sid]
    # Session state flipped to "done" before processing.
    assert ivr_webhook._ivr_sessions[call_sid]["step"] == "done"


# ── May 2026 — press-star early-finish prompt + ru/zh language menu ────────


def test_ivr_welcome_menu_includes_russian_and_chinese_options(client):
    """May 2026 (operator-supplied scope) — the welcome menu now lists
    Russian (press 6) and Chinese (press 7) alongside the original 5
    languages. Voice IDs for ru/zh existed in `_IVR_VOICES` since day
    one (Polly.Tatyana + Polly.Zhiyu), but the Gather verb never
    surfaced them as DTMF options."""
    res = client.post(
        _url("webhook"),
        data={"CallSid": "CA-test-ru-zh-menu", "From": "+10000", "Direction": "inbound"},
    )
    body = res.text
    # Russian — Polly.Tatyana voice, ru-RU locale, Cyrillic script.
    assert 'voice="Polly.Tatyana" language="ru-RU">' in body, (
        "Russian welcome line missing from menu Gather"
    )
    assert "русского" in body, "Russian prompt script missing"
    # Chinese — Polly.Zhiyu voice, cmn-CN locale, Han script.
    assert 'voice="Polly.Zhiyu" language="cmn-CN">' in body, (
        "Chinese welcome line missing from menu Gather"
    )
    assert "中文" in body, "Chinese prompt script missing"


def test_ivr_digit_six_routes_to_russian(client):
    """Pressing 6 selects Russian — the location step's TwiML must use
    Polly.Tatyana / ru-RU and carry the new Cyrillic press-star prompt."""
    call_sid = "CA-test-digit-6"
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-seed",
        "phone": "+7000",
        "caller_number": "+7000",
        "step": "record_location",
    }
    res = client.post(
        _url("location-step"),
        data={"CallSid": call_sid, "sid": call_sid, "Digits": "6"},
    )
    assert res.status_code == 200
    body = res.text
    assert ivr_webhook._ivr_sessions[call_sid]["lang"] == "ru"
    assert 'voice="Polly.Tatyana" language="ru-RU">' in body
    # Press-star prompt rendered in Cyrillic.
    assert "звёздочку" in body, (
        f"Russian press-star prompt missing from location TwiML; body: {body[:300]}"
    )


def test_ivr_digit_seven_routes_to_chinese(client):
    """Pressing 7 selects Chinese — same shape as ru."""
    call_sid = "CA-test-digit-7"
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-seed",
        "phone": "+8600",
        "caller_number": "+8600",
        "step": "record_location",
    }
    res = client.post(
        _url("location-step"),
        data={"CallSid": call_sid, "sid": call_sid, "Digits": "7"},
    )
    assert res.status_code == 200
    body = res.text
    assert ivr_webhook._ivr_sessions[call_sid]["lang"] == "zh"
    assert 'voice="Polly.Zhiyu" language="cmn-CN">' in body
    # Press-star prompt rendered in Mandarin (星号 = "star/asterisk key").
    assert "星号" in body, (
        f"Chinese press-star prompt missing from location TwiML; body: {body[:300]}"
    )


_PRESS_STAR_NEEDLE = {
    "en": "press star",
    "hi": "स्टार दबाएं",
    "es": "presione asterisco",
    "fr": "appuyez sur etoile",
    "ar": "اضغط على النجمة",
    "ru": "нажмите звёздочку",
    "zh": "按星号键",
}


@pytest.mark.parametrize("digit,lang", [
    ("1", "en"), ("2", "hi"), ("3", "es"), ("4", "fr"),
    ("5", "ar"), ("6", "ru"), ("7", "zh"),
])
def test_ivr_location_step_has_press_star_prompt_in_every_language(client, digit, lang):
    """The location <Record> step now ends with a native-language
    "press star to finish" instruction. Operator-reported: speaking
    quickly meant 10 s of silence-timeout wasted; the capability
    (finishOnKey="*") was already wired since day one but had no
    audio surface. This test pins the prompt across all 7 supported
    IVR languages."""
    call_sid = f"CA-test-press-star-loc-{digit}"
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-seed",
        "phone": "+10",
        "caller_number": "+10",
        "step": "record_location",
    }
    res = client.post(
        _url("location-step"),
        data={"CallSid": call_sid, "sid": call_sid, "Digits": digit},
    )
    assert res.status_code == 200
    body = res.text
    needle = _PRESS_STAR_NEEDLE[lang]
    assert needle in body, (
        f"press-star prompt missing for {lang} (looking for '{needle}'); "
        f"body excerpt: {body[:400]}"
    )
    # And the Record verb still carries `finishOnKey="*"` so the
    # capability the prompt advertises is actually wired.
    assert 'finishOnKey="*"' in body, (
        f"finishOnKey=\"*\" missing from {lang} location TwiML — "
        "press-star prompt would be a lie without it"
    )


@pytest.mark.parametrize("digit,lang", [
    ("1", "en"), ("2", "hi"), ("3", "es"), ("4", "fr"),
    ("5", "ar"), ("6", "ru"), ("7", "zh"),
])
def test_ivr_describe_step_has_press_star_prompt_in_every_language(client, digit, lang):
    """Same press-star prompt assertion on the description <Record>
    step (the 20 s timeout — the operator's most acute pain point)."""
    call_sid = f"CA-test-press-star-desc-{digit}"
    ivr_webhook._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-seed",
        "phone": "+10",
        "caller_number": "+10",
        "lang": lang,
        "location_audio_url": "https://fake/loc.wav",
        "step": "record_description",
    }
    res = client.post(
        _url("describe"),
        data={
            "CallSid": call_sid, "sid": call_sid,
            "RecordingUrl": "https://fake/loc.wav",
        },
    )
    assert res.status_code == 200
    body = res.text
    needle = _PRESS_STAR_NEEDLE[lang]
    assert needle in body, (
        f"press-star prompt missing for {lang} on describe step; "
        f"body excerpt: {body[:400]}"
    )
    assert 'finishOnKey="*"' in body


# ── Phase 23 — voice-to-map pipeline assertions ────────────────────────────


def test_ivr_get_base_url_handles_layered_proxy():
    """`_get_base_url` must return `https://undp.crisplabs.tech` for
    the public host even when nginx clobbers the upstream ALB's
    `X-Forwarded-Proto: https` with its own `$scheme` (http).

    Bug repro (pre-fix):
      Twilio sends to ALB on :443 with X-Forwarded-Proto: https.
      ALB forwards to nginx on :80.
      nginx sets `proxy_set_header X-Forwarded-Proto $scheme;`
        → backend sees X-Forwarded-Proto: http (nginx's view).
      _get_base_url returned `http://undp.crisplabs.tech/...`
        → TwiML callback URLs were http → Twilio errored mid-call.

    The fix pins HTTPS for known public hostnames (regardless of
    whatever Forwarded-Proto value made it through the proxy chain)
    while still honouring the header for non-public hosts.
    """
    class _FakeReq:
        def __init__(self, headers, base_url="http://127.0.0.1:8000"):
            self.headers = headers
            self.base_url = base_url

    # Production reality: nginx clobbered the proto. Function must
    # still return https for the public host.
    req = _FakeReq({"x-forwarded-proto": "http", "host": "undp.crisplabs.tech"})
    assert ivr_webhook._get_base_url(req) == "https://undp.crisplabs.tech"

    # ALB → nginx → backend with the multi-hop list form.
    req = _FakeReq({"x-forwarded-proto": "https, http", "host": "undp.crisplabs.tech"})
    assert ivr_webhook._get_base_url(req) == "https://undp.crisplabs.tech"

    # x-forwarded-host takes precedence over host (CDN scenarios).
    req = _FakeReq({"x-forwarded-host": "undp.crisplabs.tech", "host": "backend:8000"})
    assert ivr_webhook._get_base_url(req) == "https://undp.crisplabs.tech"

    # ngrok dev tunnel → also force HTTPS.
    req = _FakeReq({"x-forwarded-proto": "https", "host": "abc123.ngrok.io"})
    assert ivr_webhook._get_base_url(req) == "https://abc123.ngrok.io"

    # Localhost dev path stays HTTP.
    req = _FakeReq({"host": "localhost:8000"})
    assert ivr_webhook._get_base_url(req) == "http://localhost:8000"

    # No host header at all — fall back to request.base_url.
    req = _FakeReq({}, base_url="http://127.0.0.1:8000/")
    assert ivr_webhook._get_base_url(req) == "http://127.0.0.1:8000"

    # Unknown public host with no header — default to HTTPS (safer
    # for Twilio-style integrations).
    req = _FakeReq({"host": "example.com"})
    assert ivr_webhook._get_base_url(req) == "https://example.com"


def test_ivr_country_to_lang_helper():
    """Sanity-check that `_country_to_lang` returns the expected
    defaults for the canonical examples used in production."""
    assert ivr_webhook._country_to_lang("IN") == "hi"
    assert ivr_webhook._country_to_lang("BD") == "hi"
    assert ivr_webhook._country_to_lang("ES") == "es"
    assert ivr_webhook._country_to_lang("FR") == "fr"
    assert ivr_webhook._country_to_lang("AE") == "ar"
    assert ivr_webhook._country_to_lang("EG") == "ar"
    assert ivr_webhook._country_to_lang("US") == "en"   # not mapped → en
    assert ivr_webhook._country_to_lang("") == "en"
    assert ivr_webhook._country_to_lang(None) == "en"   # type: ignore[arg-type]
    # Whitespace + lowercase are normalised.
    assert ivr_webhook._country_to_lang(" in ") == "hi"
    assert ivr_webhook._country_to_lang("in") == "hi"


def test_ivr_country_to_lang_phase25_unmapped_locales():
    """Phase 25 (May 2026) — the PWA gained 6 new locales (pt, ja,
    tr, vi, ko, id). The IVR channel does NOT yet ship native Polly
    prompts for these languages (Twilio Polly only has voices for
    some of them; native-prompt translations are a separate
    workstream — see docs/I18N-WORKFLOW.md §1 and the
    `_IVR_PROMPTS` dict).

    Until those land, callers from those countries fall back to
    the English voice. This test documents the expected fallback
    behavior so a future deploy that wires Brazilian Portuguese
    IVR prompts (BR → 'pt') will surface as a deliberate
    test-update, not a silent regression."""
    # New PWA locales without IVR prompts yet — must fall to 'en'.
    assert ivr_webhook._country_to_lang("BR") == "en"
    assert ivr_webhook._country_to_lang("PT") == "en"
    assert ivr_webhook._country_to_lang("JP") == "en"
    assert ivr_webhook._country_to_lang("TR") == "en"
    assert ivr_webhook._country_to_lang("VN") == "en"
    assert ivr_webhook._country_to_lang("KR") == "en"
    assert ivr_webhook._country_to_lang("ID") == "en"
    # And the Russian/Chinese countries are similarly un-mapped today
    # (the welcome menu offers them as digit-pick options; the
    # auto-pick by FromCountry hasn't been extended yet).
    assert ivr_webhook._country_to_lang("RU") == "en"
    assert ivr_webhook._country_to_lang("CN") == "en"


def test_ivr_country_to_lang_un6_coverage():
    """Phase 25 (May 2026) — at least one canonical country per UN-6
    spoken language is mapped, so a caller from that country gets
    their language pre-selected without having to press a digit.

    This is a coverage guarantee: removing any of these mappings
    is a regression that should surface in CI immediately."""
    # English  → covered implicitly (default fallback)
    # Spanish  → ES / MX / AR / etc.
    assert ivr_webhook._country_to_lang("ES") == "es"
    assert ivr_webhook._country_to_lang("MX") == "es"
    # French   → FR / BE / CH / SN / CI / etc.
    assert ivr_webhook._country_to_lang("FR") == "fr"
    assert ivr_webhook._country_to_lang("SN") == "fr"
    # Arabic   → SA / AE / EG / MA / etc.
    assert ivr_webhook._country_to_lang("SA") == "ar"
    assert ivr_webhook._country_to_lang("MA") == "ar"
    # Hindi    → IN / BD / NP / PK / LK
    assert ivr_webhook._country_to_lang("IN") == "hi"
    assert ivr_webhook._country_to_lang("PK") == "hi"


def test_ivr_normalise_geo_confidence_helper():
    """Geocoder confidence values come in several flavours; this helper
    normalises them to a float in [0, 1] (or None when missing)."""
    assert ivr_webhook._normalise_geo_confidence("high") == pytest.approx(0.9)
    assert ivr_webhook._normalise_geo_confidence("medium") == pytest.approx(0.6)
    assert ivr_webhook._normalise_geo_confidence("low") == pytest.approx(0.3)
    assert ivr_webhook._normalise_geo_confidence("HIGH") == pytest.approx(0.9)
    # Numeric pass-through, with /100 normalisation for 0-100 scales.
    assert ivr_webhook._normalise_geo_confidence(0.87) == pytest.approx(0.87)
    assert ivr_webhook._normalise_geo_confidence(87) == pytest.approx(0.87)
    assert ivr_webhook._normalise_geo_confidence(1.5) == pytest.approx(1.0)
    assert ivr_webhook._normalise_geo_confidence(-0.5) == pytest.approx(0.0)
    # Missing / unrecognised → None.
    assert ivr_webhook._normalise_geo_confidence(None) is None
    assert ivr_webhook._normalise_geo_confidence("garbage") is None


def test_ivr_caller_country_picks_default_language(client):
    """POST /webhook with `FromCountry=IN` → the Redirect at the end of
    the welcome TwiML must carry `lang=hi`, so a silent caller is
    routed into Hindi prompts rather than always falling back to
    English. The Polly digit-pick menu itself stays English (the
    1-5 menu is a universal selector)."""
    res = client.post(
        _url("webhook"),
        data={
            "CallSid": "CA-test-country-IN",
            "From": "+91999900020",
            "Direction": "inbound",
            "FromCountry": "IN",
            "FromCity": "Mumbai",
            "FromState": "Maharashtra",
        },
    )
    assert res.status_code == 200, res.text
    body = res.text
    # The Gather still contains the English-language line "For English,
    # press 1." — confirms the welcome menu is multilingual but still
    # includes the English option (Phase 23.3 — each language's prompt
    # rendered in that language's own voice).
    assert "For English, press 1" in body
    # But the *fallback Redirect* honours the country default. This is
    # the URL the caller hits when they don't press a digit.
    assert "lang=hi" in body, (
        f"Expected fallback Redirect to carry lang=hi (FromCountry=IN), "
        f"got body: {body[:500]}"
    )
    # And the session remembers the resolved default for downstream
    # steps that need it.
    sess = ivr_webhook._ivr_sessions["CA-test-country-IN"]
    assert sess["default_lang"] == "hi"
    assert sess["caller_country"] == "IN"

    # Mexico → Spanish.
    res2 = client.post(
        _url("webhook"),
        data={
            "CallSid": "CA-test-country-MX",
            "From": "+52555000",
            "Direction": "inbound",
            "FromCountry": "MX",
        },
    )
    assert "lang=es" in res2.text
    assert ivr_webhook._ivr_sessions["CA-test-country-MX"]["default_lang"] == "es"

    # No country → English (no regression).
    res3 = client.post(
        _url("webhook"),
        data={
            "CallSid": "CA-test-country-none",
            "From": "+10000",
            "Direction": "inbound",
        },
    )
    assert "lang=en" in res3.text
    assert ivr_webhook._ivr_sessions["CA-test-country-none"]["default_lang"] == "en"


async def _run_process_ivr_with_mocks(monkeypatch, *, geo_overrides=None,
                                       capture_meta_box=None,
                                       extractor_capture=None):
    """Test helper: seed an IVR session, patch the external services
    (transcribe, geocoder, HTTP POST, ai_extractor) so the pipeline
    runs in-process. Returns whatever capture-boxes the caller passed.

    Asserting on the captured POST body is the cleanest way to verify
    the geocoding_confidence + geocoding_source persistence — the
    real backend receives those keys via the meta payload.
    """
    import asyncio
    from messaging_bot.ivr import webhook as _w

    call_sid = "CA-test-process-001"
    _w._ivr_sessions[call_sid] = {
        "phone_hash": "IVR-pipe-001",
        "phone": "+91999111",
        "caller_number": "+91999111",
        "caller_city": "Delhi",
        "caller_state": "Delhi",
        "caller_country": "IN",
        "caller_zip": "",
        "default_lang": "hi",
        "lang": "hi",
        "location_audio_url": "https://fake/loc.wav",
        "audio_url": "https://fake/desc.wav",
        "step": "record_description",
    }

    async def _fake_dl(url, _kind):
        # Returns (transcription_text, raw_audio_bytes).
        if "loc" in url:
            return ("near Connaught Place, New Delhi", b"loc-bytes")
        return ("the road is flooded after heavy rain", b"desc-bytes")

    monkeypatch.setattr(_w, "_download_and_transcribe", _fake_dl)

    geo_default = {
        "latitude": 28.6304,
        "longitude": 77.2177,
        "location_name": "Connaught Place, New Delhi",
        "confidence": "high",
        "source": "mapbox",
    }
    if geo_overrides:
        geo_default.update(geo_overrides)

    async def _fake_geo(_text, **_kwargs):
        return geo_default

    # geocode_text is imported inside _process_ivr_report; patch the
    # source module too in case of late binding.
    monkeypatch.setattr(
        "messaging_bot.sms.geocoder.geocode_text", _fake_geo, raising=False,
    )

    # Stub the chunked uploader so we don't try to push WAV bytes.
    async def _fake_upload(_rid, _b64, _kind, _mime):
        return {"status": "ok"}
    monkeypatch.setattr(
        "messaging_bot.chunked_uploader.upload_media_chunked",
        _fake_upload,
        raising=False,
    )

    # Stub the AI extractor — we only care that it was scheduled.
    async def _fake_extract(rid, text):
        if extractor_capture is not None:
            extractor_capture.append((rid, text))
    monkeypatch.setattr(
        "messaging_bot.ai_extractor.extract_and_update_report",
        _fake_extract,
        raising=False,
    )

    # Mock the backend POST so we can inspect the meta payload the
    # webhook builds. `httpx` is imported inside `_process_ivr_report`
    # so we patch the live `httpx.AsyncClient` attribute (the function
    # sees the patched class on its `import httpx` lookup).
    class _FakeResp:
        status_code = 201
        def json(self):
            return {"id": "report-fake-001"}
        text = "fake-201"

    class _FakeClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def post(self, _url, json=None, **_kw):
            if capture_meta_box is not None:
                capture_meta_box.append(json)
            return _FakeResp()

    import httpx as _httpx
    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)

    await _w._process_ivr_report(call_sid)
    # `_process_ivr_report` fires the AI extractor via
    # `asyncio.create_task(...)`. asyncio.run() cancels still-running
    # tasks at loop shutdown, so the fake extractor would never
    # finish — we explicitly drain all pending tasks (except the
    # current one) before returning.
    me = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not me and not t.done()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    return call_sid


def test_ivr_pipeline_persists_geocoding_confidence(monkeypatch):
    """End-to-end: `_process_ivr_report` should pass
    `geocoding_confidence` and `geocoding_source` through the meta POST
    body so the Location row carries the values. Confidence is
    normalised from the geocoder's string ("high" → 0.9)."""
    import asyncio

    captured = []
    asyncio.run(_run_process_ivr_with_mocks(
        monkeypatch,
        capture_meta_box=captured,
    ))
    assert len(captured) == 1, "expected exactly one POST to /reports/meta"
    meta = captured[0]
    loc = meta.get("location") or {}
    assert loc.get("geocoding_confidence") == pytest.approx(0.9)
    assert loc.get("geocoding_source") == "mapbox"
    # And the human-readable name + coords arrived too (regression
    # guard for the original geocode path).
    assert loc.get("latitude") == pytest.approx(28.6304)
    assert loc.get("longitude") == pytest.approx(77.2177)
    assert "Connaught Place" in (loc.get("device_location_name") or "")


def test_ivr_pipeline_runs_ai_extraction(monkeypatch):
    """`_process_ivr_report` should schedule `extract_and_update_report`
    after a successful report creation. The extractor consumes the
    combined transcription text and is responsible for back-filling
    infrastructure_type / severity / crisis_type / damage_classification
    on the Report row (Phase 23 restored this from Phase 21's
    'admin-only' regression)."""
    import asyncio

    extractor_calls = []
    asyncio.run(_run_process_ivr_with_mocks(
        monkeypatch,
        extractor_capture=extractor_calls,
    ))
    assert len(extractor_calls) == 1, (
        "expected ai_extractor.extract_and_update_report to be invoked "
        "exactly once after a successful IVR report POST"
    )
    rid, text = extractor_calls[0]
    assert rid == "report-fake-001"
    # The combined transcription should include BOTH the location
    # utterance and the description utterance, so the LLM has
    # context for both location + damage extraction.
    assert "Connaught Place" in text
    assert "flooded" in text
