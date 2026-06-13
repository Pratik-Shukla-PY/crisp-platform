"""WhatsApp webhook tests.

Covers Meta Cloud API verification (GET) + message receive (POST) plus
HMAC-SHA256 signing and per-IP rate limiting.

The webhook URL path is fixed at module import time
(``@router.get(f"/webhook/{WEBHOOK_SECRET_PATH}")``) so each test reads
the live value from the imported module rather than guessing.
"""
import hmac
import hashlib
import json

import pytest

import messaging_bot.whatsapp.webhook as wa_webhook


# Resolved at import — matches what the live app registered.
WA_PATH = wa_webhook.WEBHOOK_SECRET_PATH
WA_VERIFY_TOKEN = wa_webhook.VERIFY_TOKEN


def _wa_url() -> str:
    return f"/api/v1/whatsapp/webhook/{WA_PATH}"


def _reset_wa_rate_store():
    """Clear per-IP rate buckets between tests — otherwise the 30/min cap
    leaks between tests that share the ``testclient`` source IP."""
    wa_webhook._rate_store.clear()


@pytest.fixture(autouse=True)
def _clean_wa_rate():
    _reset_wa_rate_store()
    yield
    _reset_wa_rate_store()


def test_verify_webhook_accepts_valid_hub_challenge(client):
    """GET with correct hub.verify_token echoes the challenge back as int."""
    res = client.get(
        _wa_url(),
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": WA_VERIFY_TOKEN,
            "hub.challenge": "42",
        },
    )
    assert res.status_code == 200
    # Handler returns ``int(hub_challenge)`` — TestClient serialises as JSON.
    assert res.json() == 42


def test_verify_webhook_rejects_bad_token(client):
    """Wrong verify_token → 403 Verification failed."""
    res = client.get(
        _wa_url(),
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "definitely-wrong",
            "hub.challenge": "42",
        },
    )
    assert res.status_code == 403


def test_receive_webhook_accepts_signed_message_and_creates_report(client, monkeypatch):
    """POST with a valid HMAC-SHA256 signature returns 200 and dispatches
    the message into the background handler.

    The WhatsApp handler lives over multiple turns (language pick →
    photo → severity → …) so a single text payload never creates a
    Report row on its own. We monkeypatch ``handle_incoming_message`` so
    the test can assert *the webhook accepted the payload AND queued it
    for processing* — that's the contract the webhook owes its caller.
    """
    # Force a known APP_SECRET so signature validation is exercised.
    monkeypatch.setattr(wa_webhook, "APP_SECRET", "unit-test-app-secret")

    captured = []

    async def _fake_handler(phone, message):
        captured.append((phone, message))

    monkeypatch.setattr(wa_webhook, "handle_incoming_message", _fake_handler)

    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "123",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "messages": [
                                {
                                    "id": "wamid.TEST-001",
                                    "from": "919999900001",
                                    "type": "text",
                                    "text": {"body": "flood in Koramangala"},
                                }
                            ],
                        },
                        "field": "messages",
                    }
                ],
            }
        ],
    }
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(b"unit-test-app-secret", body, hashlib.sha256).hexdigest()

    res = client.post(
        _wa_url(),
        content=body,
        headers={"X-Hub-Signature-256": sig, "Content-Type": "application/json"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"status": "ok"}
    # Background task ran → handler got the phone + message.
    assert len(captured) == 1
    phone, message = captured[0]
    assert phone == "919999900001"
    assert message["text"]["body"] == "flood in Koramangala"


def test_receive_webhook_rejects_bad_signature(client, monkeypatch):
    """POST with wrong X-Hub-Signature-256 → 401 Invalid signature."""
    monkeypatch.setattr(wa_webhook, "APP_SECRET", "unit-test-app-secret")

    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"id": "123", "changes": [{"value": {}, "field": "messages"}]}],
    }
    body = json.dumps(payload).encode()
    # Signature computed with the WRONG secret:
    bad_sig = "sha256=" + hmac.new(b"attacker-key", body, hashlib.sha256).hexdigest()

    res = client.post(
        _wa_url(),
        content=body,
        headers={"X-Hub-Signature-256": bad_sig, "Content-Type": "application/json"},
    )
    assert res.status_code == 401


def test_rate_limit_on_verify_webhook(client):
    """31st GET from the same IP inside the 60s window returns 429.

    The in-memory limiter is capped at 30/min. We need >30 calls to
    observe the ceiling — loop 35 times and assert at least one 429.
    """
    saw_429 = False
    for _ in range(35):
        res = client.get(
            _wa_url(),
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": "whatever",
                "hub.challenge": "1",
            },
        )
        if res.status_code == 429:
            saw_429 = True
            break
    assert saw_429, "rate limiter should trip within 35 requests (cap is 30/min)"


def test_whatsapp_attaches_crisis_event_id_when_in_active_zone(client, monkeypatch):
    """WhatsApp shares a GPS location → submit_report resolves the active zone
    and echoes ONLY crisis_event_id (never form_pack_id — WhatsApp doesn't render
    the dynamic pack). The server re-derives authoritatively from the location."""
    import asyncio
    from messaging_bot.whatsapp import session_manager as wa_sessions

    session = wa_sessions.SessionBuffer(phone_hash="WA-zone-test", phone_raw="+10000000000")
    session.severity = "MODERATE"
    session.infra_type = "ROAD"
    session.text = "wall collapsed"
    session.latitude = 12.97
    session.longitude = 77.59

    captured = []

    class _GetResp:
        status_code = 200
        def json(self):
            return {"active": True, "event_id": "evt-wa-zone",
                    "pack_id": "pk-A", "pack_version": 1}

    class _PostResp:
        status_code = 201
        text = "ok"
        def json(self):
            return {"id": "rep-wa-zone"}

    class _FakeClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, params=None, headers=None): return _GetResp()
        async def post(self, url, json=None, **kw):
            captured.append(json)
            return _PostResp()

    import httpx as _httpx
    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)

    asyncio.run(wa_sessions.submit_report(session))
    assert captured, "submit_report didn't POST"
    meta = captured[0]
    assert meta.get("crisis_event_id") == "evt-wa-zone"
    assert "form_pack_id" not in meta, "chat channels must NOT attach a form pack"


def test_whatsapp_without_location_stays_global(client, monkeypatch):
    """No shared location → no /active lookup, no crisis_event_id (GLOBAL)."""
    import asyncio
    from messaging_bot.whatsapp import session_manager as wa_sessions

    session = wa_sessions.SessionBuffer(phone_hash="WA-noloc-test", phone_raw="+10000000001")
    session.severity = "MODERATE"
    session.infra_type = "ROAD"
    session.text = "no location report"
    # no latitude/longitude → has_location is False

    captured = []

    class _PostResp:
        status_code = 201
        text = "ok"
        def json(self):
            return {"id": "rep-wa-noloc"}

    class _FakeClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, params=None, headers=None):
            raise AssertionError("must not call /active without a shared location")
        async def post(self, url, json=None, **kw):
            captured.append(json)
            return _PostResp()

    import httpx as _httpx
    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)

    asyncio.run(wa_sessions.submit_report(session))
    assert captured, "submit_report didn't POST"
    assert "crisis_event_id" not in captured[0]
