"""HC55 (May 2026) — reverse-geocode cascade tests.

Covers the cascade order, rate-limit wiring, Postgres cache hit /
miss / write, response-shape uniformity, and the new HTTP route
contract at ``POST /api/v1/reports/geocode/reverse``.

The cascade itself talks to two upstream services we MUST NOT hit
from a test run (Mapbox costs money, Nominatim is rate-limited).
Every test below patches the upstream call-points so the suite is
hermetic.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

# `messaging_bot` is at the repo root (sibling of `backend/`). conftest.py
# inserts `backend/..` into sys.path for the test session, so we can
# import the geocoder helpers directly. Imports kept inside the test
# body when the module patches its OWN attributes — that matters for
# `_geocode_mapbox_reverse` etc. (patch the live import path).
from messaging_bot.sms import geocoder
from app.models.report import GeocodeCache


# ── 1. Round-trip primitive — coord rounding + cache key shape ──────────────

def test_round_coord_truncates_to_4_decimals():
    assert geocoder._round_coord(12.852765144406774) == 12.8528
    assert geocoder._round_coord(77.67942360560353) == 77.6794
    # Edge: negative.
    assert geocoder._round_coord(-0.123456789) == -0.1235


def test_coords_fallback_returns_uniform_shape():
    out = geocoder._coords_fallback(12.34, 56.78)
    assert out["location_name"] == "12.3400°, 56.7800°"
    assert out["source"] == "fallback"
    assert out["confidence"] == "none"
    assert out["latitude"] == 12.34
    assert out["longitude"] == 56.78


# ── 2. Cascade order — Mapbox first, Nominatim second, fallback last ────────

@pytest.mark.asyncio
async def test_cascade_uses_mapbox_first(db):
    """When Mapbox returns a result, Nominatim is never consulted."""
    mapbox_result = {
        "location_name": "Koramangala, Bengaluru",
        "confidence": "high",
        "source": "mapbox",
        "latitude": 12.852,
        "longitude": 77.679,
    }
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value=mapbox_result)) as mapbox_mock,
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})) as nominatim_mock,
    ):
        result = await geocoder.reverse_geocode_coords(
            12.852, 77.679, language="en", db=db,
        )
    assert mapbox_mock.await_count == 1
    assert nominatim_mock.await_count == 0
    assert result["source"] == "mapbox"
    assert result["location_name"] == "Koramangala, Bengaluru"


@pytest.mark.asyncio
async def test_cascade_falls_through_to_nominatim_when_mapbox_empty(db):
    nominatim_result = {
        "location_name": "Indiranagar, Bengaluru, India",
        "confidence": "medium",
        "source": "nominatim",
        "latitude": 12.97,
        "longitude": 77.64,
    }
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value={})),
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value=nominatim_result)) as nominatim_mock,
    ):
        result = await geocoder.reverse_geocode_coords(
            12.97, 77.64, language="en", db=db,
        )
    assert nominatim_mock.await_count == 1
    assert result["source"] == "nominatim"


@pytest.mark.asyncio
async def test_cascade_falls_through_to_fallback_when_both_empty(db):
    # Use coords no other test has touched, so we don't accidentally
    # hit a prior test's cache row.
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value={})),
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})),
    ):
        result = await geocoder.reverse_geocode_coords(
            45.55, -73.55, language="en", db=db,
        )
    assert result["source"] == "fallback"
    # Synthetic name preserves the response contract (PWA always paints
    # *something*).
    assert result["location_name"] == "45.5500°, -73.5500°"


# ── 3. Cache writes/reads ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mapbox_success_persists_to_cache(db):
    payload = {
        "location_name": "Whitefield, Bengaluru",
        "confidence": "high",
        "source": "mapbox",
        "latitude": 12.97,
        "longitude": 77.74,
    }
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value=payload)),
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})),
    ):
        await geocoder.reverse_geocode_coords(12.97, 77.74, "en", db=db)
    row = (
        db.query(GeocodeCache)
        .filter(GeocodeCache.direction == "reverse",
                GeocodeCache.lat_key == 12.97,
                GeocodeCache.lng_key == 77.74,
                GeocodeCache.language == "en")
        .one()
    )
    assert row.location_name == "Whitefield, Bengaluru"
    assert row.source == "mapbox"
    assert row.expires_at > datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_cache_hit_short_circuits_upstreams(db):
    """A live cache row must serve the request without touching Mapbox
    or Nominatim. This is the entire point of the table."""
    # Seed a row.
    now = datetime.now(timezone.utc)
    db.add(GeocodeCache(
        direction="reverse",
        lat_key=12.5, lng_key=77.5,
        language="en",
        location_name="Cached Place",
        source="mapbox",
        confidence="high",
        latitude=12.5, longitude=77.5,
        expires_at=now + timedelta(days=1),
    ))
    db.commit()
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value={})) as mb,
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})) as nm,
    ):
        result = await geocoder.reverse_geocode_coords(12.5, 77.5, "en", db=db)
    assert mb.await_count == 0
    assert nm.await_count == 0
    assert result["source"] == "cache"
    assert result["location_name"] == "Cached Place"


@pytest.mark.asyncio
async def test_expired_cache_row_is_ignored(db):
    now = datetime.now(timezone.utc)
    db.add(GeocodeCache(
        direction="reverse",
        lat_key=11.1, lng_key=22.2,
        language="en",
        location_name="Stale Entry",
        source="mapbox",
        confidence="high",
        latitude=11.1, longitude=22.2,
        expires_at=now - timedelta(hours=1),
    ))
    db.commit()
    fresh = {
        "location_name": "Fresh Place",
        "confidence": "high",
        "source": "mapbox",
        "latitude": 11.1, "longitude": 22.2,
    }
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value=fresh)),
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})),
    ):
        result = await geocoder.reverse_geocode_coords(11.1, 22.2, "en", db=db)
    assert result["source"] == "mapbox"
    assert result["location_name"] == "Fresh Place"


# ── 4. Input validation on the bare helper ──────────────────────────────────

@pytest.mark.asyncio
async def test_out_of_range_coords_raise_value_error(db):
    with pytest.raises(ValueError):
        await geocoder.reverse_geocode_coords(91.0, 0.0, "en", db=db)
    with pytest.raises(ValueError):
        await geocoder.reverse_geocode_coords(0.0, 181.0, "en", db=db)


# ── 5. HTTP route contract — request validation + uniform response ─────────

def test_route_400_when_lat_missing(client):
    r = client.post("/api/v1/reports/geocode/reverse", json={"lng": 77.6})
    assert r.status_code == 400
    body = r.json()
    assert body["detail"]["code"] == "missing_coords"


def test_route_400_when_coords_out_of_range(client):
    r = client.post("/api/v1/reports/geocode/reverse",
                    json={"lat": 91.0, "lng": 0.0})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_coords_range"


def test_route_400_when_coords_non_numeric(client):
    r = client.post("/api/v1/reports/geocode/reverse",
                    json={"lat": "north", "lng": "east"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_coords_type"


def test_route_returns_fallback_when_both_upstreams_empty(client):
    """End-to-end via TestClient — both upstreams patched to empty so
    the response is the synthetic fallback. Validates the contract
    the PWA depends on. Uses coords no earlier test has populated."""
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value={})),
        patch.object(geocoder, "_geocode_nominatim_reverse",
                     new=AsyncMock(return_value={})),
    ):
        r = client.post(
            "/api/v1/reports/geocode/reverse",
            json={"lat": 65.99, "lng": -149.55, "language": "en"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "fallback"
    assert "65.9900" in body["location_name"]


def test_route_returns_mapbox_payload(client):
    # Coords no earlier test has populated, so we exercise the
    # Mapbox path end-to-end rather than the cache path.
    payload = {
        "location_name": "Reykjavik, Iceland",
        "confidence": "high",
        "source": "mapbox",
        "latitude": 64.13,
        "longitude": -21.93,
    }
    with (
        patch.object(geocoder, "_geocode_mapbox_reverse",
                     new=AsyncMock(return_value=payload)),
    ):
        r = client.post(
            "/api/v1/reports/geocode/reverse",
            json={"lat": 64.13, "lng": -21.93, "language": "en"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "mapbox"
    assert body["location_name"] == "Reykjavik, Iceland"


# ── 6. Rate-limiter is wired (sanity check the import) ──────────────────────

def test_limiters_exist_and_are_configured():
    from aiolimiter import AsyncLimiter
    assert isinstance(geocoder._NOMINATIM_LIMITER, AsyncLimiter)
    assert isinstance(geocoder._MAPBOX_LIMITER, AsyncLimiter)
    # 1 req/s for Nominatim per usage policy.
    assert geocoder._NOMINATIM_LIMITER.max_rate == 1
    assert geocoder._NOMINATIM_LIMITER.time_period == 1
    # 600/min Mapbox free tier ceiling.
    assert geocoder._MAPBOX_LIMITER.max_rate == 600
    assert geocoder._MAPBOX_LIMITER.time_period == 60
