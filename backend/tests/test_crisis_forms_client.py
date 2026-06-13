"""Unit tests for the shared GPS-channel operation resolver
(``messaging_bot.crisis_forms_client.resolve_active_event_id``).

Telegram + WhatsApp call this at intake to link a report to its operation when
the reporter shared a precise GPS location. Contract: it must NEVER raise — any
failure (no active zone, non-200, network error, missing coords) returns None so
the caller submits a GLOBAL report unchanged.
"""
import asyncio

from messaging_bot import crisis_forms_client as cfc


class _Resp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


def _client_factory(resp=None, raise_get=False, on_get=None):
    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None, headers=None):
            if on_get is not None:
                on_get(url, params, headers)
            if raise_get:
                raise RuntimeError("network down")
            return resp

    return _FakeClient


def _run(coro):
    return asyncio.run(coro)


def test_active_zone_returns_event_id(monkeypatch):
    resp = _Resp(200, {"active": True, "event_id": "evt-123", "pack_id": "pk-1"})
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(resp))
    assert _run(cfc.resolve_active_event_id(12.97, 77.59)) == "evt-123"


def test_inactive_zone_returns_none(monkeypatch):
    resp = _Resp(200, {"active": False})
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(resp))
    assert _run(cfc.resolve_active_event_id(12.97, 77.59)) is None


def test_active_but_no_event_id_returns_none(monkeypatch):
    resp = _Resp(200, {"active": True})  # malformed — no event_id
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(resp))
    assert _run(cfc.resolve_active_event_id(12.97, 77.59)) is None


def test_non_200_returns_none(monkeypatch):
    resp = _Resp(503, {})
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(resp))
    assert _run(cfc.resolve_active_event_id(12.97, 77.59)) is None


def test_network_error_returns_none(monkeypatch):
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(raise_get=True))
    assert _run(cfc.resolve_active_event_id(12.97, 77.59)) is None


def test_missing_coords_never_calls_network(monkeypatch):
    class _Boom:
        def __init__(self, *a, **k):
            raise AssertionError("must not open a client without coords")

    monkeypatch.setattr(cfc.httpx, "AsyncClient", _Boom)
    assert _run(cfc.resolve_active_event_id(None, None)) is None
    assert _run(cfc.resolve_active_event_id(12.97, None)) is None
    assert _run(cfc.resolve_active_event_id(None, 77.59)) is None


def test_passes_lat_lng_as_query_params(monkeypatch):
    seen = {}

    def _capture(url, params, headers):
        seen["url"] = url
        seen["params"] = params

    resp = _Resp(200, {"active": True, "event_id": "evt-9"})
    monkeypatch.setattr(cfc.httpx, "AsyncClient", _client_factory(resp, on_get=_capture))
    _run(cfc.resolve_active_event_id(1.5, 2.5))
    assert seen["url"].endswith("/api/v1/crisis-forms/active")
    assert seen["params"] == {"lat": 1.5, "lng": 2.5}
