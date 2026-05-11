"""Telegram webhook tests.

Covers the Bot-API update receive path plus the header-secret,
rate-limit, payload-type routing, and /webhook-url info endpoint.
"""
import os
from unittest.mock import patch

import pytest

import messaging_bot.telegram.webhook as tg_webhook
import app.main as app_main


# Live-registered path (evaluated at import, see ``@router.post(f"/webhook/{SECRET}")``).
TG_PATH = tg_webhook.WEBHOOK_SECRET_PATH


def _tg_url() -> str:
    return f"/api/v1/telegram/webhook/{TG_PATH}"


def _reset_tg_state():
    # main.py's shared rate bucket — key is ``tg_webhook:<ip>``.
    app_main._rate_limits.clear()


@pytest.fixture(autouse=True)
def _clean_tg():
    _reset_tg_state()
    # Make sure TELEGRAM_WEBHOOK_SECRET_TOKEN is unset for tests that
    # don't opt in — otherwise a value leaked from an earlier test
    # makes innocent POSTs fail.
    os.environ.pop("TELEGRAM_WEBHOOK_SECRET_TOKEN", None)
    yield
    os.environ.pop("TELEGRAM_WEBHOOK_SECRET_TOKEN", None)
    _reset_tg_state()


def test_webhook_accepts_valid_update_and_creates_report(client, monkeypatch):
    """POST a plausible Telegram update → 200 {"ok": true} and the
    dispatcher is invoked.

    The Telegram handler is a multi-step conversation machine (language
    → consent → photo → location → …) so a single text update never
    lands a Report row on its own. The webhook's contract is
    "acknowledge + queue" — this test asserts exactly that.
    """
    captured = []

    async def _fake_handle_update(update):
        captured.append(update)

    monkeypatch.setattr(tg_webhook, "handle_update", _fake_handle_update)

    update = {
        "update_id": 1000001,
        "message": {
            "message_id": 1,
            "from": {"id": 42, "first_name": "Alice", "language_code": "en"},
            "chat": {"id": 42, "type": "private"},
            "text": "flood here please help",
        },
    }
    res = client.post(_tg_url(), json=update)
    assert res.status_code == 200, res.text
    assert res.json() == {"ok": True}
    assert len(captured) == 1
    assert captured[0]["update_id"] == 1000001


def test_webhook_rejects_wrong_secret_token_header(client, monkeypatch):
    """When TELEGRAM_WEBHOOK_SECRET_TOKEN is configured, any POST missing
    or sending a mismatched ``X-Telegram-Bot-Api-Secret-Token`` is 403.
    """
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "super-secret-header")

    update = {"update_id": 5, "message": {"message_id": 1, "chat": {"id": 1}, "text": "x"}}
    res = client.post(
        _tg_url(),
        json=update,
        headers={"X-Telegram-Bot-Api-Secret-Token": "wrong-value"},
    )
    assert res.status_code == 403


def test_webhook_rate_limits_same_ip(client, monkeypatch):
    """61st POST from the same client IP in a 60s window → 429.

    The limit is ``max_requests=60, window=60``. We stub handle_update
    so the test doesn't pay the cost of real processing.
    """
    async def _noop(update):
        return None

    monkeypatch.setattr(tg_webhook, "handle_update", _noop)

    update = {"update_id": 1, "message": {"message_id": 1, "chat": {"id": 1}, "text": "x"}}
    saw_429 = False
    for i in range(65):
        update["update_id"] = i + 1
        r = client.post(_tg_url(), json=update)
        if r.status_code == 429:
            saw_429 = True
            break
    assert saw_429, "expected 429 within 65 requests (cap is 60/min per IP)"


def test_webhook_handles_photo_message_with_file_id(client, monkeypatch):
    """Photo-type update with ``photo[].file_id`` — webhook must still
    200 + dispatch. Any Telegram Bot-API fetch inside the handler is
    mocked so the test never hits the network.
    """
    captured = []

    async def _fake_handle_update(update):
        captured.append(update)

    monkeypatch.setattr(tg_webhook, "handle_update", _fake_handle_update)
    # Defensive — if handler WAS real, these would prevent outbound HTTP.
    with patch("httpx.AsyncClient.get") as _m1, patch("httpx.AsyncClient.post") as _m2:
        update = {
            "update_id": 7,
            "message": {
                "message_id": 9,
                "from": {"id": 1, "first_name": "P", "language_code": "en"},
                "chat": {"id": 1, "type": "private"},
                "photo": [
                    {"file_id": "AgACAgEAAx-small", "width": 90, "height": 90, "file_size": 1024},
                    {"file_id": "AgACAgEAAx-big", "width": 800, "height": 600, "file_size": 200_000},
                ],
            },
        }
        res = client.post(_tg_url(), json=update)
    assert res.status_code == 200
    assert len(captured) == 1
    assert captured[0]["message"]["photo"][-1]["file_id"] == "AgACAgEAAx-big"


def test_webhook_ignores_non_message_update_types(client, monkeypatch):
    """``edited_message`` / ``channel_post`` / ``callback_query`` updates
    must still be acknowledged (200 ok:true) — Telegram retries anything
    non-2xx and we'd pile up a queue.

    The real ``handle_update`` exits early when there's no ``message``
    key, so there's no Report side-effect to assert; we just verify the
    webhook swallows the update cleanly.
    """
    called_with = []

    async def _fake_handle_update(update):
        called_with.append(update)

    monkeypatch.setattr(tg_webhook, "handle_update", _fake_handle_update)

    update = {
        "update_id": 123,
        "edited_message": {
            "message_id": 4,
            "from": {"id": 1},
            "chat": {"id": 1, "type": "private"},
            "text": "edited text",
            "edit_date": 1700000000,
        },
    }
    res = client.post(_tg_url(), json=update)
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    # handle_update is still *invoked* — it's the handler's job to ignore
    # the update shape, not the webhook's. We just assert the webhook
    # passes it through rather than erroring.
    assert len(called_with) == 1


def test_webhook_url_exposes_configured_secret_suffix():
    """GET /webhook-url (localhost-only) returns the full path including
    the non-guessable secret — operators need this to configure the
    Telegram setWebhook call.

    Uses a fresh TestClient with ``client=("127.0.0.1", ...)`` because
    the handler's allow-list checks ``request.client.host`` and the
    default TestClient host is ``testclient``, which would trip the 403
    guard. We're not testing the guard here — we're testing the
    response shape when the guard passes.
    """
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.session import get_db
    from tests.conftest import override_get_db

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app, client=("127.0.0.1", 54321)) as c:
            res = c.get("/api/v1/telegram/webhook-url")
    finally:
        app.dependency_overrides.clear()

    assert res.status_code == 200
    body = res.json()
    assert "webhook_url" in body
    assert f"/api/v1/telegram/webhook/{TG_PATH}" in body["webhook_url"]


# ── Phase 23 — /start <token> device-hash linking ──────────────────────────


def test_telegram_start_token_decoder():
    """Unit test the pure decoder. The bot accepts:
      • 32 lowercase hex → `PWA-<lower>`
      • 32 uppercase / mixed-case hex → `PWA-<lower>` (case-insensitive)
      • benign analytics tags ('crisp_web', 'crisp') → None
      • anything else / missing → None
    """
    from messaging_bot.telegram.handlers import _decode_start_token

    # Canonical PWA device-hash (32 hex chars) → canonical PWA- prefix.
    assert _decode_start_token("3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1") == (
        "PWA-3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1"
    )
    # Case-insensitive on the way in, lowercased on the way out.
    assert _decode_start_token("3A8F29C7E5D3A1B2C4F6E8D0A9B7C5F1") == (
        "PWA-3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1"
    )
    # Whitespace tolerated.
    assert _decode_start_token("  3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1  ") == (
        "PWA-3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1"
    )
    # Benign analytics tags → no device-hash linkage, but no crash.
    assert _decode_start_token("crisp_web") is None
    assert _decode_start_token("crisp") is None
    # Malformed → None (length wrong, non-hex chars, empty).
    assert _decode_start_token("") is None
    assert _decode_start_token(None) is None
    assert _decode_start_token("foobar") is None
    assert _decode_start_token("3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1aa") is None
    assert _decode_start_token("3a8f29c7e5d3a1b2c4f6e8d0a9b7c5fz") is None


def test_telegram_start_token_links_pwa_device_hash(client, monkeypatch):
    """Send a Telegram webhook update with `/start <32-hex>` →
    the handler decodes the token, the session's `pwa_device_hash` is
    populated, and the next Report created via create_report_early
    uses that hash as `meta['device_hash']` (instead of the TG-prefixed
    fallback)."""
    import asyncio
    from messaging_bot.telegram import handlers as tg_handlers
    from messaging_bot.telegram import session_manager as tg_sessions

    # Reset session store so any leftover from another test doesn't
    # interfere with our user_id-keyed lookup.
    tg_sessions._sessions.clear()

    user_id = 555_001
    chat_id = 555_001
    pwa_hash_hex = "3a8f29c7e5d3a1b2c4f6e8d0a9b7c5f1"
    expected = "PWA-" + pwa_hash_hex

    # Stub the bot's outbound reply so we don't hit the real Telegram
    # API during the test. The handler invokes send_welcome which goes
    # through bot_replies.send_text → httpx — we patch the lowest layer.
    async def _noop(*_args, **_kwargs):
        return None
    monkeypatch.setattr(tg_handlers, "send_welcome", _noop)

    update = {
        "update_id": 9_999_999,
        "message": {
            "message_id": 1,
            "date": 1_700_000_000,
            "from": {"id": user_id, "first_name": "Test", "language_code": "en"},
            "chat": {"id": chat_id, "type": "private"},
            "text": f"/start {pwa_hash_hex}",
        },
    }

    # The webhook dispatcher accepts the update and async-fires the
    # handler. We invoke it directly so we can await the result and
    # then inspect the session.
    asyncio.run(tg_handlers.handle_update(update))

    # The handler stored the decoded PWA device-hash on the session
    # so subsequent steps (create_report_early) can attribute the
    # eventual Report row to the same anonymous user as the PWA.
    user_hash = tg_sessions.hash_user(user_id)
    session = tg_sessions._sessions.get(user_hash)
    assert session is not None, "session was not created for the test user"
    assert session.pwa_device_hash == expected, (
        f"expected session.pwa_device_hash={expected!r}, got "
        f"{session.pwa_device_hash!r}"
    )

    # Pre-populate enough state for create_report_early to attempt a
    # POST, then stub httpx so we can capture the meta payload.
    session.severity = "UNKNOWN"
    session.infra_type = "OTHER"
    session.text = "test"

    captured = []

    class _FakeResp:
        status_code = 201
        def json(self):
            return {"id": "report-tg-fake"}
        text = "fake"

    class _FakeClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def post(self, _url, json=None, **_kw):
            captured.append(json)
            return _FakeResp()

    # session_manager imports httpx inside the function — patch the
    # live AsyncClient on the httpx module so the in-function import
    # picks up our fake.
    import httpx as _httpx
    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)

    asyncio.run(tg_sessions.create_report_early(session))
    assert captured, "create_report_early didn't POST to /api/v1/reports"
    meta = captured[0]
    assert meta["device_hash"] == expected, (
        f"create_report_early should prefer session.pwa_device_hash "
        f"({expected!r}) over session.user_hash ({session.user_hash!r}); "
        f"got meta['device_hash']={meta['device_hash']!r}"
    )
    assert meta["source"] == "TELEGRAM"


def test_telegram_start_without_token_keeps_user_hash(client, monkeypatch):
    """A bare `/start` (no payload) should NOT set pwa_device_hash;
    the Report falls back to the Telegram-derived `user_hash` as
    before. This protects the regression path where a user opens the
    bot from a non-PWA entry point."""
    import asyncio
    from messaging_bot.telegram import handlers as tg_handlers
    from messaging_bot.telegram import session_manager as tg_sessions

    tg_sessions._sessions.clear()
    user_id = 555_002
    chat_id = 555_002

    async def _noop(*_args, **_kwargs):
        return None
    monkeypatch.setattr(tg_handlers, "send_welcome", _noop)

    update = {
        "update_id": 9_999_998,
        "message": {
            "message_id": 1,
            "date": 1_700_000_000,
            "from": {"id": user_id, "first_name": "Test", "language_code": "en"},
            "chat": {"id": chat_id, "type": "private"},
            "text": "/start",
        },
    }
    asyncio.run(tg_handlers.handle_update(update))

    user_hash = tg_sessions.hash_user(user_id)
    session = tg_sessions._sessions.get(user_hash)
    assert session is not None
    assert session.pwa_device_hash is None, (
        f"bare /start must not set pwa_device_hash, got "
        f"{session.pwa_device_hash!r}"
    )
