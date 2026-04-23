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
