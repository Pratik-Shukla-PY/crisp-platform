"""
Satellite image fetcher for CRISP Truth Verification.  # reloaded 2026-04-01b

Primary:  Sentinel Hub (ESA Copernicus) — Sentinel-2 L2A, 10m resolution,
          5-day global revisit, free tier, provides exact acquisition date
          and cloud-cover metadata critical for scoring.

Fallback: Mapbox Static API — Maxar imagery, sub-meter in cities,
          always available, no acquisition-date metadata.
"""
import base64
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── Sentinel Hub API endpoints ────────────────────────────────────────────────
_SH_TOKEN_URL   = "https://services.sentinel-hub.com/oauth/token"
_SH_PROCESS_URL = "https://services.sentinel-hub.com/api/v1/process"
_SH_CATALOG_URL = "https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search"

# Sentinel-2 true-colour RGB evalscript (bands B04/B03/B02 = R/G/B)
# Brightness boost (×3.5) makes the image look natural at 10m resolution.
_EVALSCRIPT_TRUE_COLOR = """
//VERSION=3
function setup() {
    return { input: [{ bands: ["B04", "B03", "B02"] }], output: { bands: 3 } };
}
function evaluatePixel(sample) {
    return [3.5 * sample.B04, 3.5 * sample.B03, 3.5 * sample.B02];
}
"""


class SatelliteFetcher:
    """Fetch the most recent cloud-free satellite image for a lat/lon point."""

    def __init__(self):
        self._client_id     = os.getenv("SENTINEL_HUB_CLIENT_ID", "")
        self._client_secret = os.getenv("SENTINEL_HUB_CLIENT_SECRET", "")
        self._mapbox_token  = os.getenv("MAPBOX_TOKEN", "")
        self._sh_token: Optional[str]      = None
        self._sh_token_expiry: Optional[datetime] = None

    # ── Sentinel Hub OAuth2 ───────────────────────────────────────────────────

    async def _get_sh_token(self) -> Optional[str]:
        """Return a valid OAuth2 bearer token, refreshing when near expiry."""
        now = datetime.now(timezone.utc)
        if self._sh_token and self._sh_token_expiry and now < self._sh_token_expiry:
            return self._sh_token
        if not (self._client_id and self._client_secret):
            logger.warning("SENTINEL_HUB_CLIENT_ID / SECRET not set — Sentinel Hub disabled")
            return None
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(
                    _SH_TOKEN_URL,
                    data={
                        "grant_type":    "client_credentials",
                        "client_id":     self._client_id,
                        "client_secret": self._client_secret,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                r.raise_for_status()
                payload = r.json()
                self._sh_token = payload["access_token"]
                # Expire 60 s early to avoid using stale token
                expires_in = payload.get("expires_in", 3600)
                self._sh_token_expiry = now + timedelta(seconds=max(expires_in - 60, 0))
                logger.info("Sentinel Hub token refreshed")
                return self._sh_token
        except Exception as exc:
            logger.error(f"Sentinel Hub token fetch failed: {exc}")
            return None

    # ── Sentinel Catalog (metadata only) ─────────────────────────────────────

    async def _catalog_query(
        self, lat: float, lon: float,
        from_str: str, to_str: str,
        token: str,
    ) -> dict:
        """
        Query the Sentinel STAC catalog for the most recent scene covering
        the point. Returns acquisition_date, cloud_cover, scene_id.
        """
        delta = 0.005  # ~500 m buffer around the point
        bbox  = [lon - delta, lat - delta, lon + delta, lat + delta]
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(
                    _SH_CATALOG_URL,
                    json={
                        "collections": ["sentinel-2-l2a"],
                        "bbox":         bbox,
                        "datetime":     f"{from_str}/{to_str}",
                        "filter": {
                            "op":   "lte",
                            "args": [{"property": "eo:cloud_cover"}, 80],
                        },
                        "limit":   1,
                    },
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type":  "application/json",
                    },
                )
                r.raise_for_status()
                features = r.json().get("features", [])
                if features:
                    props = features[0].get("properties", {})
                    return {
                        "acquisition_date": props.get("datetime", ""),
                        "cloud_cover":      props.get("eo:cloud_cover", 0),
                        "scene_id":         features[0].get("id", ""),
                    }
        except Exception as exc:
            logger.warning(f"Sentinel catalog query error: {exc}")
        return {}

    # ── Sentinel Process API (actual image) ──────────────────────────────────

    async def _sentinel_image(
        self, lat: float, lon: float,
        from_str: str, to_str: str,
        token: str,
    ) -> Optional[bytes]:
        """Return raw PNG bytes from Sentinel-2 Process API."""
        delta = 0.005
        bbox  = [lon - delta, lat - delta, lon + delta, lat + delta]
        try:
            async with httpx.AsyncClient(timeout=40) as c:
                r = await c.post(
                    _SH_PROCESS_URL,
                    json={
                        "input": {
                            "bounds": {
                                "bbox":       bbox,
                                "properties": {
                                    "crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
                                },
                            },
                            "data": [{
                                "type": "sentinel-2-l2a",
                                "dataFilter": {
                                    "timeRange": {
                                        "from": from_str,
                                        "to":   to_str,
                                    },
                                    "maxCloudCoverage": 80,
                                },
                            }],
                        },
                        "output": {
                            "width":  512,
                            "height": 512,
                            "responses": [{
                                "identifier": "default",
                                "format":     {"type": "image/png"},
                            }],
                        },
                        "evalscript": _EVALSCRIPT_TRUE_COLOR,
                    },
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type":  "application/json",
                    },
                )
                if r.status_code == 200:
                    return r.content
                logger.warning(
                    f"Sentinel Process API {r.status_code}: {r.text[:300]}"
                )
        except Exception as exc:
            logger.error(f"Sentinel image fetch error: {exc}")
        return None

    # ── Mapbox fallback ───────────────────────────────────────────────────────

    async def _mapbox_image(self, lat: float, lon: float) -> Optional[dict]:
        """
        Fetch a 512×512 satellite tile from Mapbox (Maxar imagery).
        No acquisition-date metadata — used only when Sentinel is unavailable
        or cloud-covered.
        """
        if not self._mapbox_token:
            logger.warning("MAPBOX_TOKEN not set — Mapbox fallback disabled")
            return None
        url = (
            f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
            f"{lon},{lat},17/512x512"
            f"?access_token={self._mapbox_token}"
        )
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(url)
                if r.status_code == 200:
                    return {
                        "image_b64":        base64.b64encode(r.content).decode(),
                        "image_media_type": "image/jpeg",
                        "acquisition_date": None,
                        "cloud_cover_pct":  None,
                        "source":           "Mapbox Satellite (Maxar)",
                        "resolution_m":     0.5,
                        "lat": lat, "lon": lon,
                    }
                logger.warning(f"Mapbox {r.status_code}")
        except Exception as exc:
            logger.error(f"Mapbox fallback error: {exc}")
        return None

    # ── Public entry point ────────────────────────────────────────────────────

    async def fetch(
        self,
        lat: float,
        lon: float,
        report_dt: Optional[datetime] = None,
    ) -> Optional[dict]:
        """
        Return the best available satellite image + metadata dict:
        {
            image_b64, image_media_type,
            acquisition_date,   # ISO-8601 string or None
            cloud_cover_pct,    # 0-100 float or None
            source,             # human-readable label
            resolution_m,       # metres per pixel
            lat, lon,
        }
        Strategy:
        1. Try Sentinel Hub (best metadata, 10 m resolution).
        2. If Sentinel fails or cloud cover > 80 %, fall back to Mapbox.
        """
        if not report_dt:
            report_dt = datetime.now(timezone.utc)
        if report_dt.tzinfo is None:
            report_dt = report_dt.replace(tzinfo=timezone.utc)

        # 30-day search window ending at report timestamp
        end_dt   = report_dt
        start_dt = end_dt - timedelta(days=30)
        from_str = start_dt.strftime("%Y-%m-%dT00:00:00Z")
        to_str   = end_dt.strftime("%Y-%m-%dT23:59:59Z")

        token = await self._get_sh_token()
        if token:
            catalog = await self._catalog_query(lat, lon, from_str, to_str, token)
            cloud   = catalog.get("cloud_cover", 0) or 0

            if cloud <= 80:
                img_bytes = await self._sentinel_image(
                    lat, lon, from_str, to_str, token
                )
                if img_bytes:
                    logger.info(
                        f"Sentinel image fetched: {len(img_bytes):,} bytes, "
                        f"cloud={cloud}%, acq={catalog.get('acquisition_date', 'unknown')}"
                    )
                    primary = {
                        "image_b64":        base64.b64encode(img_bytes).decode(),
                        "image_media_type": "image/png",
                        "acquisition_date": catalog.get("acquisition_date", ""),
                        "cloud_cover_pct":  round(cloud, 1),
                        "source":           "Sentinel-2 L2A (ESA Copernicus)",
                        "resolution_m":     10,
                        "lat": lat, "lon": lon,
                    }
                    # Also fetch Mapbox as alternate source for comparison
                    try:
                        alt = await self._mapbox_image(lat, lon)
                        if alt:
                            primary["alt"] = alt
                    except Exception:
                        pass
                    return primary
            else:
                logger.info(f"Sentinel cloud cover {cloud}% > 80 — switching to Mapbox")

        # Fallback — Mapbox only (no alt available)
        logger.info("Using Mapbox satellite fallback")
        return await self._mapbox_image(lat, lon)


# Singleton
satellite_fetcher = SatelliteFetcher()
