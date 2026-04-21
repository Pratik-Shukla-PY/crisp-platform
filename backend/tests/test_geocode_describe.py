"""API tests for the landmark/what3words fallback endpoint.

Real geocoder calls hit Mapbox + Nominatim + Claude — we don't want
the test suite making outbound HTTP, so we monkey-patch
``messaging_bot.sms.geocoder.geocode_text`` with a fake that returns a
stable payload. That lets us exercise the endpoint-level behaviour
(validation, w3w gating, HTTP shape) without flakiness.
"""
import pytest


async def _fake_geocode(text, country_hint="India"):
    """Return a canned result as if Mapbox matched."""
    return {
        "latitude": 12.9352,
        "longitude": 77.6245,
        "location_name": "Koramangala, Bengaluru, Karnataka",
        "confidence": "high",
        "source": "mapbox",
    }


async def _fake_empty_geocode(text, country_hint="India"):
    return {
        "latitude": None, "longitude": None,
        "location_name": "", "confidence": "low", "source": "text_geocoding",
    }


class TestGeocodeDescribe:
    def test_rejects_short_text(self, client):
        res = client.post("/api/v1/reports/geocode/describe", json={"text": "a"})
        assert res.status_code == 400
        assert "text_too_short" in res.text

    def test_rejects_missing_text(self, client):
        res = client.post("/api/v1/reports/geocode/describe", json={})
        assert res.status_code == 400

    def test_resolves_free_text(self, client, monkeypatch):
        # Patch the geocoder where app.api.endpoints.reports pulls it from
        import messaging_bot.sms.geocoder as geocoder_mod
        monkeypatch.setattr(geocoder_mod, "geocode_text", _fake_geocode)
        res = client.post("/api/v1/reports/geocode/describe", json={
            "text": "near the big mosque in Koramangala 5th block",
        })
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["latitude"] == pytest.approx(12.9352, abs=1e-4)
        assert body["longitude"] == pytest.approx(77.6245, abs=1e-4)
        assert "Koramangala" in body["location_name"]
        assert body["confidence"] == "high"
        assert body["source"] == "mapbox"
        # w3w off by default
        assert body["w3w"] is None

    def test_empty_geocode_still_200(self, client, monkeypatch):
        import messaging_bot.sms.geocoder as geocoder_mod
        monkeypatch.setattr(geocoder_mod, "geocode_text", _fake_empty_geocode)
        res = client.post("/api/v1/reports/geocode/describe", json={
            "text": "somewhere unresolvable",
        })
        assert res.status_code == 200
        body = res.json()
        assert body["latitude"] is None
        assert body["w3w"] is None

    def test_w3w_opt_in_without_api_key(self, client, monkeypatch):
        """include_w3w=true but no W3W_API_KEY → the endpoint returns
        null for w3w (doesn't leak the text to a third-party API without
        explicit operator opt-in)."""
        import messaging_bot.sms.geocoder as geocoder_mod
        monkeypatch.setattr(geocoder_mod, "geocode_text", _fake_geocode)
        monkeypatch.delenv("W3W_API_KEY", raising=False)
        res = client.post("/api/v1/reports/geocode/describe", json={
            "text": "near the big mosque",
            "include_w3w": True,
        })
        assert res.status_code == 200
        assert res.json()["w3w"] is None
