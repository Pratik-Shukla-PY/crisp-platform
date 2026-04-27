"""Tests for the multi-provider satellite fetcher.

We don't make real outbound calls (those would be flaky and slow);
each provider is exercised by monkeypatching the underlying
`httpx.AsyncClient.post` / `httpx.AsyncClient.get` to return canned
JSON / image bytes. The orchestrator then drives them in priority
order and we assert on (a) which provider fired, (b) the return
shape, and (c) graceful skip behaviour when a provider's API errors.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services import satellite_fetcher as sf


# ── Fixtures ───────────────────────────────────────────────────────────────

PNG_TEST_BYTES = base64.b64decode(
    # 1×1 transparent PNG, ~70 bytes — small but valid
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)

JPEG_TEST_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 16  # minimal JPEG SOI + filler


def _stac_feature(
    *,
    cloud: float = 5.0,
    acq: str = "2026-04-15T10:00:00Z",
    feature_id: str = "S2A_TEST_TILE_20260415",
    thumb_url: str = "https://example.com/thumb.jpg",
    asset_key: str = "thumbnail",
) -> dict:
    return {
        "id": feature_id,
        "type": "Feature",
        "properties": {
            "datetime": acq,
            "eo:cloud_cover": cloud,
        },
        "assets": {
            asset_key: {"href": thumb_url, "type": "image/jpeg"},
        },
    }


def _stac_response(features: list) -> dict:
    return {"type": "FeatureCollection", "features": features}


def _mock_async_post(json_response: Any, status: int = 200):
    """Build a side_effect that makes httpx.AsyncClient.post return a
    response with the given JSON body + status."""
    async def _post(self, url, *args, **kwargs):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = status
        resp.json = MagicMock(return_value=json_response)
        resp.text = str(json_response)[:500]
        return resp
    return _post


def _mock_async_get(content: bytes, status: int = 200):
    """Build a side_effect for httpx.AsyncClient.get returning bytes."""
    async def _get(self, url, *args, **kwargs):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = status
        resp.content = content
        resp.text = ""
        return resp
    return _get


# ── _aws_sentinel2 ─────────────────────────────────────────────────────────

class TestAwsSentinel2:
    @pytest.mark.asyncio
    async def test_returns_dict_with_thumbnail_on_success(self, monkeypatch):
        features = [_stac_feature(cloud=5.0, thumb_url="https://aws-test/thumb.jpg")]
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response(features)))
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(JPEG_TEST_BYTES))

        out = await sf._aws_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is not None
        assert "image_b64" in out
        assert out["image_media_type"] == "image/jpeg"
        assert out["cloud_cover_pct"] == 5.0
        assert out["resolution_m"] == 10
        assert "AWS Open Data" in out["source"]
        assert out["lat"] == 12.97 and out["lon"] == 77.59

    @pytest.mark.asyncio
    async def test_returns_none_when_stac_returns_no_features(self, monkeypatch):
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response([])))
        out = await sf._aws_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is None

    @pytest.mark.asyncio
    async def test_returns_none_on_500_from_stac(self, monkeypatch):
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post({}, status=500))
        out = await sf._aws_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is None

    @pytest.mark.asyncio
    async def test_picks_low_cloud_scene_over_first(self, monkeypatch):
        features = [
            _stac_feature(cloud=95.0, feature_id="cloudy"),
            _stac_feature(cloud=10.0, feature_id="clear", thumb_url="https://aws-test/clear.jpg"),
        ]
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response(features)))
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(JPEG_TEST_BYTES))
        out = await sf._aws_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out["cloud_cover_pct"] == 10.0


# ── _mpc_sentinel2 ─────────────────────────────────────────────────────────

class TestMpcSentinel2:
    @pytest.mark.asyncio
    async def test_returns_dict_with_rendered_preview(self, monkeypatch):
        features = [
            _stac_feature(
                cloud=15.0,
                thumb_url="https://mpc-test/rendered_preview.png",
                asset_key="rendered_preview",
            )
        ]
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response(features)))
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(PNG_TEST_BYTES))

        out = await sf._mpc_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is not None
        assert out["image_media_type"] == "image/png"
        assert "Microsoft Planetary Computer" in out["source"]
        assert out["cloud_cover_pct"] == 15.0

    @pytest.mark.asyncio
    async def test_falls_back_to_thumbnail_when_no_rendered_preview(self, monkeypatch):
        features = [
            _stac_feature(
                cloud=15.0,
                thumb_url="https://mpc-test/thumb.jpg",
                asset_key="thumbnail",
            )
        ]
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response(features)))
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(JPEG_TEST_BYTES))

        out = await sf._mpc_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is not None
        # No rendered_preview → media type is JPEG (URL has .jpg)
        assert out["image_media_type"] == "image/jpeg"


# ── _cdse_sentinel2 ────────────────────────────────────────────────────────

class TestCdseSentinel2:
    @pytest.mark.asyncio
    async def test_returns_none_on_404_endpoint_moved(self, monkeypatch):
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post({}, status=404))
        out = await sf._cdse_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is None

    @pytest.mark.asyncio
    async def test_returns_dict_when_quicklook_present(self, monkeypatch):
        features = [
            _stac_feature(
                cloud=20.0,
                thumb_url="https://cdse-test/quicklook.jpg",
                asset_key="QUICKLOOK",
            )
        ]
        monkeypatch.setattr(httpx.AsyncClient, "post", _mock_async_post(_stac_response(features)))
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(JPEG_TEST_BYTES))

        out = await sf._cdse_sentinel2(12.97, 77.59, datetime.now(timezone.utc))
        assert out is not None
        assert "ESA Copernicus" in out["source"]


# ── _mapbox_satellite ──────────────────────────────────────────────────────

class TestMapboxSatellite:
    @pytest.mark.asyncio
    async def test_returns_none_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("MAPBOX_TOKEN", raising=False)
        out = await sf._mapbox_satellite(12.97, 77.59, datetime.now(timezone.utc))
        assert out is None

    @pytest.mark.asyncio
    async def test_returns_dict_with_token(self, monkeypatch):
        monkeypatch.setenv("MAPBOX_TOKEN", "pk.test.token")
        monkeypatch.setattr(httpx.AsyncClient, "get", _mock_async_get(JPEG_TEST_BYTES))
        out = await sf._mapbox_satellite(12.97, 77.59, datetime.now(timezone.utc))
        assert out is not None
        assert "Mapbox" in out["source"]
        assert out["acquisition_date"] is None  # Mapbox has no date metadata


# ── Orchestrator (chain) ───────────────────────────────────────────────────

class TestSatelliteFetcherFanOut:
    """The fan-out orchestrator queries all providers in parallel and
    returns every successful result in `images: [...]`. Compared with
    the chain version, key differences pinned by these tests:
        - All providers are CALLED on every fetch (even after one
          succeeds), because we want their images for the grid.
        - The primary (top-level fields) is the first non-Mapbox
          provider that returned successfully.
        - The `images` list contains every successful result in
          provider-priority order.
    """

    @pytest.mark.asyncio
    async def test_all_4_providers_succeed_returns_4_images(self, monkeypatch):
        async def _ok(name):
            async def _fn(lat, lon, dt):
                return {"image_b64": "x", "image_media_type": "image/jpeg",
                        "acquisition_date": "2026-04-15T10:00Z",
                        "cloud_cover_pct": 5.0,
                        "source": f"{name} test", "resolution_m": 10,
                        "lat": lat, "lon": lon}
            return _fn

        aws = await _ok("AWS")
        mpc = await _ok("MPC")
        cdse = await _ok("CDSE")
        mapbox = await _ok("Mapbox")
        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS Sentinel-2 (Element84 STAC)", aws),
            ("Microsoft Planetary Computer", mpc),
            ("ESA Copernicus Data Space", cdse),
            ("Mapbox Satellite", mapbox),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out is not None
        assert "images" in out and isinstance(out["images"], list)
        assert len(out["images"]) == 4
        # Primary is the first non-Mapbox.
        assert "AWS" in out["source"]

    @pytest.mark.asyncio
    async def test_aws_only_succeeds_returns_one_image(self, monkeypatch):
        async def _aws(lat, lon, dt):
            return {"image_b64": "x", "image_media_type": "image/jpeg",
                    "acquisition_date": "2026-04-15T10:00Z",
                    "cloud_cover_pct": 5.0,
                    "source": "AWS test", "resolution_m": 10,
                    "lat": lat, "lon": lon}

        async def _none(lat, lon, dt):
            return None

        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS", _aws),
            ("MPC", _none),
            ("CDSE", _none),
            ("Mapbox", _none),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out is not None
        assert len(out["images"]) == 1
        assert out["images"][0]["source"] == "AWS test"

    @pytest.mark.asyncio
    async def test_only_mapbox_succeeds_promoted_to_primary(self, monkeypatch):
        """If only Mapbox returns, it's still the primary — the chain
        no longer 'prefers Sentinel-2 only', because some Sentinel-2
        coverage may be cloudy or missing for a given lat/lon."""
        async def _none(lat, lon, dt):
            return None

        async def _mapbox(lat, lon, dt):
            return {"image_b64": "y", "image_media_type": "image/jpeg",
                    "acquisition_date": None, "cloud_cover_pct": None,
                    "source": "Mapbox test", "resolution_m": 0.5,
                    "lat": lat, "lon": lon}

        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS", _none),
            ("MPC", _none),
            ("CDSE", _none),
            ("Mapbox Satellite", _mapbox),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out is not None
        assert out["source"] == "Mapbox test"
        assert len(out["images"]) == 1

    @pytest.mark.asyncio
    async def test_returns_none_when_all_providers_fail(self, monkeypatch):
        async def _none(lat, lon, dt):
            return None

        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS", _none),
            ("MPC", _none),
            ("CDSE", _none),
            ("Mapbox", _none),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out is None

    @pytest.mark.asyncio
    async def test_provider_exception_does_not_break_fan_out(self, monkeypatch):
        async def _aws_explodes(lat, lon, dt):
            raise RuntimeError("simulated provider crash")

        async def _mpc(lat, lon, dt):
            return {"image_b64": "x", "image_media_type": "image/png",
                    "acquisition_date": "2026-04-15T10:00Z",
                    "cloud_cover_pct": 0.0,
                    "source": "MPC test", "resolution_m": 10,
                    "lat": lat, "lon": lon}

        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS", _aws_explodes),
            ("MPC", _mpc),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out is not None
        assert out["source"] == "MPC test"
        assert len(out["images"]) == 1

    @pytest.mark.asyncio
    async def test_legacy_alt_field_populated_with_first_mapbox(self, monkeypatch):
        """Backward compat: the `alt` field is the first Mapbox result
        if any, so older frontend code that reads `verification.alt`
        still works."""
        async def _aws(lat, lon, dt):
            return {"image_b64": "x", "image_media_type": "image/jpeg",
                    "acquisition_date": "2026-04-15T10:00Z",
                    "cloud_cover_pct": 0.0,
                    "source": "AWS test", "resolution_m": 10,
                    "lat": lat, "lon": lon}

        async def _mapbox(lat, lon, dt):
            return {"image_b64": "y", "image_media_type": "image/jpeg",
                    "acquisition_date": None, "cloud_cover_pct": None,
                    "source": "Mapbox test", "resolution_m": 0.5,
                    "lat": lat, "lon": lon}

        monkeypatch.setattr(sf, "_PROVIDERS", [
            ("AWS", _aws),
            ("Mapbox Satellite", _mapbox),
        ])

        out = await sf.SatelliteFetcher().fetch(12.97, 77.59)
        assert out["source"] == "AWS test"
        assert "alt" in out
        assert out["alt"]["source"] == "Mapbox test"
        # And both are in the new images list.
        assert len(out["images"]) == 2
