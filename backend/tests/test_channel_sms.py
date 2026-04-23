"""SMS webhook tests.

Covers the Exotel/Twilio form-encoded POST path that turns one SMS into
one Report row.

Note: the real ``_process_sms`` coroutine posts to
``{CRISP_BACKEND_URL}/api/v1/reports/meta`` with ``httpx`` — which would
hit a *real* localhost:8000 server, not the test ``TestClient`` with its
overridden DB. We swap ``httpx.AsyncClient`` out for a fake whose
``post`` routes through the same TestClient so reports land in the test
DB. ``geocode_text`` is also stubbed so the suite never calls Mapbox or
Claude.
"""
import os
import time

import pytest

import messaging_bot.sms.webhook as sms_webhook
from app.models.report import Report, Device


SMS_PATH = sms_webhook.SMS_WEBHOOK_SECRET


def _sms_url() -> str:
    return f"/api/v1/sms/webhook/{SMS_PATH}"


def _reset_sms_state():
    sms_webhook._rate_store.clear()
    sms_webhook._recent_messages.clear()


@pytest.fixture(autouse=True)
def _clean_sms():
    _reset_sms_state()
    yield
    _reset_sms_state()


class _FakeResponse:
    """httpx.Response look-alike — just enough for ``_process_sms``."""

    def __init__(self, status_code: int, data):
        self.status_code = status_code
        self._data = data
        self.text = str(data)[:500]

    def json(self):
        return self._data


def _make_asgi_client_class(real_async_client_cls, real_asgi_transport):
    """Build an ``httpx.AsyncClient`` replacement backed by
    ``httpx.ASGITransport`` against the real FastAPI app. This routes
    the webhook's in-process ``httpx.AsyncClient().post(...)`` calls
    directly into the app (same process, same DB override) **without**
    deadlocking the running event loop — unlike a sync TestClient call
    from inside a coroutine, which is forbidden.

    The two class args are the *original* httpx classes captured before
    monkeypatching — otherwise the wrapper would recurse into itself.
    """
    from app.main import app

    class _AsgiAsyncClient:
        _base_url = "http://testserver"

        def __init__(self, *_args, **_kwargs):
            # Use the captured real httpx classes so we don't recurse
            # into the monkey-patched AsyncClient.
            self._client = real_async_client_cls(
                transport=real_asgi_transport(app=app),
                base_url=self._base_url,
                timeout=10,
            )

        async def __aenter__(self):
            await self._client.__aenter__()
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return await self._client.__aexit__(exc_type, exc, tb)

        async def post(self, url, json=None, data=None, auth=None, **_kwargs):
            path = _strip_backend_prefix(url)
            r = await self._client.post(path, json=json, data=data)
            try:
                body = r.json()
            except Exception:
                body = {}
            return _FakeResponse(r.status_code, body)

        async def get(self, url, *_args, **_kwargs):
            # Most GETs in the SMS path are gateway reply sends —
            # return a benign 200 so the code paths don't error.
            return _FakeResponse(200, {})

    return _AsgiAsyncClient


def _strip_backend_prefix(url: str) -> str:
    for prefix in (sms_webhook.BACKEND_URL, "http://localhost:8000", "http://localhost"):
        if url.startswith(prefix):
            return url[len(prefix):] or "/"
    return url


async def _fake_geocode(text, country_hint="India"):
    return {
        "latitude": 12.9352,
        "longitude": 77.6245,
        "location_name": "Koramangala, Bengaluru, Karnataka",
        "confidence": "high",
        "source": "mapbox",
    }


@pytest.fixture
def sms_patches(client, monkeypatch):
    """Install the httpx + geocode stubs.

    Patch targets:
      - ``httpx.AsyncClient`` globally: the webhook's ``_process_sms``
        does ``import httpx`` at call-time, so this catches every code
        path (report POST, reply SMS send). The replacement dispatches
        in-process via ``httpx.ASGITransport`` so it's event-loop safe
        (Starlette's ``TestClient`` would deadlock from inside a
        BackgroundTask coroutine).
      - ``messaging_bot.sms.webhook.geocode_text``: the webhook did
        ``from .geocoder import geocode_text`` at module import, so the
        name lives on the webhook module itself — patching the
        geocoder-module attribute would miss it.
    """
    import httpx as _httpx
    real_async_client = _httpx.AsyncClient
    real_asgi_transport = _httpx.ASGITransport
    fake_cls = _make_asgi_client_class(real_async_client, real_asgi_transport)
    monkeypatch.setattr(_httpx, "AsyncClient", fake_cls)
    monkeypatch.setattr("messaging_bot.sms.webhook.geocode_text", _fake_geocode)
    import messaging_bot.sms.geocoder as geo
    monkeypatch.setattr(geo, "geocode_text", _fake_geocode)
    yield


def test_sms_webhook_creates_report_from_twilio_payload(client, db, sms_patches):
    """End-to-end: POST Twilio-style form → webhook 200 → Report row
    with ``source = SMS`` persisted in the test DB."""
    res = client.post(
        _sms_url(),
        data={
            "From": "+919999900010",
            "To": "+14150001234",
            "Body": "There is a flood near Koramangala, please send help",
            "MessageSid": "SM-test-001",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "accepted"

    # TestClient waited for the background task to run. The API commit
    # is on a different Session — expire ours to re-fetch from Postgres.
    db.expire_all()
    device_hash = sms_webhook._hash_phone("+919999900010")
    report = db.query(Report).filter(Report.device_id == db.query(Device.id).filter(Device.device_hash == device_hash).scalar_subquery()).first()
    assert report is not None, "expected a Report row for the SMS device"
    assert report.source.value == "SMS"
    assert "flood" in (report.description or "").lower()


def test_sms_webhook_rejects_empty_body(client, sms_patches):
    """Empty Body → handler returns 200 with ``status=ignored`` (the
    webhook never raises — Twilio would retry on 4xx/5xx, and an empty
    SMS isn't a transport failure). Document the actual behaviour."""
    res = client.post(
        _sms_url(),
        data={"From": "+911111111111", "Body": ""},
    )
    assert res.status_code == 200
    body = res.json()
    assert body.get("status") == "ignored"
    assert body.get("reason") == "empty"


def test_sms_webhook_creates_device_on_first_submit(client, db, sms_patches):
    """A first-time phone number → a new Device row with
    ``device_hash = SMS-<sha256-prefix>``.

    BUG FOUND + FIXED while authoring this test:
        ``_process_sms`` passed ``damage_classification=""`` to
        ``/reports/meta``, which the Pydantic schema rejects as an
        invalid enum value (422). Every SMS whose text didn't match a
        ``_DAMAGE_KEYWORDS`` keyword was silently dropped in
        production. Fix: coerce empty-string to ``None`` (same for
        ``crisis_type``) in ``messaging_bot/sms/webhook.py::_process_sms``
        so the schema accepts the absence as "unknown" instead of
        treating it as an invalid value.
    """
    phone = "+919000099999"
    device_hash = sms_webhook._hash_phone(phone)

    # Precondition: no device yet.
    db.expire_all()
    pre = db.query(Device).filter(Device.device_hash == device_hash).first()
    assert pre is None

    res = client.post(
        _sms_url(),
        data={
            "From": phone,
            "Body": "earthquake at Sector 7 Delhi — rescue needed",
            "MessageSid": "SM-new-device-001",
        },
    )
    assert res.status_code == 200, res.text

    db.expire_all()
    device = db.query(Device).filter(Device.device_hash == device_hash).first()
    assert device is not None, "Device row should be created on first SMS submit"
    assert device.device_hash.startswith("SMS-")


def test_sms_webhook_returns_twiml_or_200(client, sms_patches):
    """The handler returns a plain JSON ``{"status": "accepted"}`` (not
    TwiML). Twilio happily accepts a 200 with any body, so no XML is
    necessary. Lock in the current contract."""
    # Use a fresh phone so we don't collide with the dedup cache from
    # the previous test.
    res = client.post(
        _sms_url(),
        data={
            "From": f"+91700000{int(time.time()) % 10000:04d}",
            "Body": "power pole down on main street",
            "MessageSid": f"SM-contract-{time.time()}",
        },
    )
    assert res.status_code == 200
    ctype = res.headers.get("content-type", "")
    # Today's contract: JSON, not TwiML.
    assert "application/json" in ctype
    assert res.json() == {"status": "accepted"}
