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
