"""P4 — operation weather/hazard-alert context (Open-Meteo + GDACS).

All upstream HTTP is MOCKED — the suite makes no live network calls. Covers the
normalized shape, the GDACS distance filter, graceful degradation, the endpoint's
404 + 45-min cache, and the PII boundary (only coords/radius leave the process).
"""
import asyncio
import uuid

import httpx

from tests.conftest import auth_header
from app.models.report import CrisisEvent
import app.services.operation_context as opctx


OPEN_METEO = {
    "current": {"temperature_2m": 31.2, "relative_humidity_2m": 70,
                "precipitation": 0.0, "weather_code": 95, "wind_speed_10m": 12.0},
    "daily": {"time": ["2026-06-14", "2026-06-15", "2026-06-16"],
              "temperature_2m_max": [33, 34, 32], "temperature_2m_min": [26, 27, 25],
              "precipitation_sum": [2, 0, 5], "weather_code": [95, 2, 61]},
}
GDACS = {"features": [
    {"geometry": {"coordinates": [85.1, 25.6]},
     "properties": {"eventtype": "FL", "name": "Bihar flood", "alertlevel": "Orange",
                    "country": "India", "fromdate": "2026-06-13",
                    "url": {"report": "https://gdacs/x"}}},
    {"geometry": {"coordinates": [-70.0, -40.0]},   # ~16,000 km away → filtered out
     "properties": {"eventtype": "EQ", "name": "Far quake", "alertlevel": "Green"}},
]}


class _Resp:
    def __init__(self, code, payload):
        self.status_code = code
        self._p = payload

    def json(self):
        return self._p


def _fake_client(meteo=OPEN_METEO, gdacs=GDACS, fail=False):
    requests = []

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            requests.append({"url": url, "params": params})
            if fail:
                raise httpx.ConnectError("boom")
            if "open-meteo" in url:
                return _Resp(200, meteo)
            if "gdacs" in url:
                return _Resp(200, gdacs)
            return _Resp(404, {})

    return FakeClient, requests


def test_context_normalizes_and_filters_and_no_pii(monkeypatch):
    Fake, reqs = _fake_client()
    monkeypatch.setattr(opctx.httpx, "AsyncClient", Fake)
    ctx = asyncio.run(opctx.fetch_operation_context(25.6, 85.1, 22.0))
    assert ctx["available"] is True
    assert ctx["weather"]["temperature_c"] == 31.2
    assert ctx["weather"]["summary"] == "Thunderstorm"
    assert "Open-Meteo" in ctx["weather"]["attribution"]
    assert len(ctx["weather"]["daily"]) == 3
    # GDACS: the near (Bihar) event survives; the far event is distance-filtered.
    names = [a["name"] for a in ctx["alerts"]]
    assert "Bihar flood" in names and "Far quake" not in names
    # PII boundary — the ONLY outbound data is coords/forecast params, no report data.
    for r in reqs:
        if r["params"]:
            assert set(r["params"].keys()) <= {
                "latitude", "longitude", "current", "daily", "forecast_days", "timezone"}
            assert r["params"]["latitude"] == 25.6 and r["params"]["longitude"] == 85.1
        blob = str(r).lower()
        assert "device" not in blob and "reporter" not in blob and "report_id" not in blob


def test_context_graceful_when_providers_down(monkeypatch):
    Fake, _ = _fake_client(fail=True)
    monkeypatch.setattr(opctx.httpx, "AsyncClient", Fake)
    ctx = asyncio.run(opctx.fetch_operation_context(1.0, 1.0, 10.0))
    assert ctx == {"available": False, "weather": None, "alerts": []}


def test_weather_endpoint_404_and_caches(client, db, admin_token, monkeypatch):
    # Unknown operation → 404 (not a 5xx).
    assert client.get("/api/v1/operations/nope-id/weather",
                      headers=auth_header(admin_token)).status_code == 404
    ev = CrisisEvent(name="W-" + uuid.uuid4().hex[:6], crisis_type="FLOOD", status="LIVE",
                     is_active=True, center_lat=25.6, center_lng=85.1, radius_km=20.0)
    db.add(ev); db.commit(); db.refresh(ev)
    calls = {"n": 0}

    async def fake_fetch(lat, lng, radius):
        calls["n"] += 1
        return {"available": True, "weather": {"summary": "Clear sky"}, "alerts": []}

    monkeypatch.setattr(opctx, "fetch_operation_context", fake_fetch)
    opctx._cache.clear()
    try:
        r1 = client.get(f"/api/v1/operations/{ev.id}/weather", headers=auth_header(admin_token))
        assert r1.status_code == 200 and r1.json()["available"] is True
        r2 = client.get(f"/api/v1/operations/{ev.id}/weather", headers=auth_header(admin_token))
        assert r2.status_code == 200
        assert calls["n"] == 1     # second request served from the 45-min cache
    finally:
        opctx._cache.clear()
        db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
        db.commit()
