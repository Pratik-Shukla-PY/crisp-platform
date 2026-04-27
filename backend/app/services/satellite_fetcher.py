"""
Satellite image fetcher for CRISP truth verification.

Apr 2026 — refactored to a multi-provider open-source chain. The previous
Sentinel Hub OAuth dependency (paid wrapper around free public data) has
been retired. The same Sentinel-2 imagery is available directly from
multiple free sources; we iterate through them in priority order until
one returns successfully:

  1. AWS Open Data Sentinel-2 + Element84 STAC API
       — no auth, no quota, no expiry. Same satellite/imagery as Sentinel
         Hub, just without the paid wrapper. Primary choice.

  2. Microsoft Planetary Computer STAC API
       — free, no auth required for STAC search and rendered_preview
         asset access. Better SLA than Element84; serves as redundancy.

  3. ESA Copernicus Data Space (CDSE) STAC
       — direct from the data source. STAC search is unauthenticated;
         we consume the QUICKLOOK asset which doesn't require OAuth.

  4. Mapbox Static API (existing fallback)
       — rendered satellite-style tile (Maxar imagery). No
         date-specificity but always available when MAPBOX_TOKEN is set.
         Used as last resort or when all Sentinel-2 sources are
         cloud-covered / unreachable.

Each provider gracefully no-ops when its dependencies aren't reachable.
The chain works with ZERO credentials — AWS Sentinel-2 needs none.
Adding the others improves coverage and resilience but is optional.

Return shape (preserved from the previous implementation so the dashboard
+ persistence layer don't change):

  {
    "image_b64":        str,    # base64-encoded image bytes
    "image_media_type": str,    # "image/jpeg" | "image/png"
    "acquisition_date": str,    # ISO-8601 or None
    "cloud_cover_pct":  float,  # 0-100 or None
    "source":           str,    # human-readable provider label
    "resolution_m":     float,  # metres per pixel
    "lat": float, "lon": float,
    "alt": dict | None,         # alternate provider's result (optional)
  }
"""
from __future__ import annotations

import base64
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

import httpx

logger = logging.getLogger(__name__)

# ── STAC API endpoints ──────────────────────────────────────────────────────
_AWS_STAC = "https://earth-search.aws.element84.com/v1/search"
_MPC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
# CDSE has multiple APIs; STAC is the modern one, but its URL has shifted
# during 2024-2025. Try the documented endpoint; if it returns 404 we
# silently skip CDSE and the chain falls through.
_CDSE_STAC = "https://catalogue.dataspace.copernicus.eu/stac/v1/search"


# ── Helpers ─────────────────────────────────────────────────────────────────

def _bbox(lat: float, lon: float, delta: float = 0.005) -> list:
    """Tiny bbox around the point. ~500 m at the equator, smaller toward
    the poles — fine for picking up a single tile that contains the
    incident location. Wider boxes return more candidate scenes but
    slow the STAC query."""
    return [lon - delta, lat - delta, lon + delta, lat + delta]


def _date_range(report_dt: datetime, days: int = 30) -> tuple[str, str]:
    """ISO-8601 datetime range ending at `report_dt`, going back `days`.
    Sentinel-2 has a 5-day global revisit, so a 30-day window almost
    always yields multiple candidate scenes even with cloud filtering."""
    end = report_dt
    start = end - timedelta(days=days)
    return (
        start.strftime("%Y-%m-%dT00:00:00Z"),
        end.strftime("%Y-%m-%dT23:59:59Z"),
    )


async def _fetch_image_bytes(url: str, timeout: float = 20) -> Optional[bytes]:
    """GET raw image bytes from a public URL. Returns None on any
    non-200 / network / timeout error after logging the failure."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(url)
            if r.status_code == 200:
                return r.content
            logger.warning(f"Image fetch {r.status_code}: {url[:120]}")
    except Exception as exc:
        logger.warning(f"Image fetch exception ({type(exc).__name__}): {url[:120]}")
    return None


def _pick_best_scene(features: list) -> Optional[dict]:
    """From a list of STAC features (most-recent-first if pre-sorted),
    pick the first one with cloud cover ≤ 80 %. Falls back to the most
    recent feature regardless of cloud cover, since "cloudy is better
    than nothing" for verification purposes."""
    if not features:
        return None
    for f in features:
        cloud = (f.get("properties", {}) or {}).get("eo:cloud_cover", 100)
        if cloud is not None and cloud <= 80:
            return f
    return features[0]


# ── Provider 1: AWS Open Data Sentinel-2 (Element84 STAC) ──────────────────

async def _aws_sentinel2(lat: float, lon: float, report_dt: datetime) -> Optional[dict]:
    """Query the AWS Open Data Sentinel-2 archive via Element84's STAC API.

    The STAC item's `thumbnail` asset is a pre-rendered ~250×250 JPEG
    showing the scene's true-colour RGB at the small bbox we asked
    about — exactly what the dashboard renders. No auth required.
    """
    from_str, to_str = _date_range(report_dt)
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": _bbox(lat, lon),
        "datetime": f"{from_str}/{to_str}",
        "limit": 10,
        # Element84 supports `sortby` per STAC spec; descending datetime
        # so we get the most recent scenes first.
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(_AWS_STAC, json=body)
            if r.status_code != 200:
                logger.info(f"AWS STAC search {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
    except Exception as exc:
        logger.info(f"AWS STAC exception ({type(exc).__name__}): {exc}")
        return None

    chosen = _pick_best_scene(data.get("features", []))
    if chosen is None:
        logger.info(f"AWS Sentinel-2: no scenes for {lat:.4f},{lon:.4f}")
        return None

    props = chosen.get("properties", {}) or {}
    assets = chosen.get("assets", {}) or {}
    thumb_url = (assets.get("thumbnail") or {}).get("href")
    if not thumb_url:
        logger.info(f"AWS Sentinel-2: scene has no thumbnail; id={chosen.get('id', '?')[:40]}")
        return None

    img_bytes = await _fetch_image_bytes(thumb_url)
    if not img_bytes:
        return None

    cloud = props.get("eo:cloud_cover", 0) or 0
    acq = props.get("datetime", "")
    logger.info(
        f"AWS Sentinel-2 fetched: {len(img_bytes):,} bytes, "
        f"cloud={cloud:.1f}%, acq={acq}, id={(chosen.get('id') or '')[:30]}"
    )
    return {
        "image_b64": base64.b64encode(img_bytes).decode(),
        "image_media_type": "image/jpeg",  # Element84 thumbnails are JPEG
        "acquisition_date": acq,
        "cloud_cover_pct": round(float(cloud), 1),
        "source": "Sentinel-2 L2A via AWS Open Data (Element84 STAC)",
        "resolution_m": 10,
        "lat": lat, "lon": lon,
    }


# ── Provider 2: Microsoft Planetary Computer ───────────────────────────────

async def _mpc_sentinel2(lat: float, lon: float, report_dt: datetime) -> Optional[dict]:
    """Query Microsoft Planetary Computer's Sentinel-2 collection.

    MPC's `rendered_preview` asset is auto-signed and pre-rendered as
    RGB PNG, so we don't need MPC_API_KEY for a thumbnail-grade image.
    For full COG asset downloads (large GeoTIFFs) the SAS-signing API
    would be needed; not in scope for verification thumbnails.
    """
    from_str, to_str = _date_range(report_dt)
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": _bbox(lat, lon),
        "datetime": f"{from_str}/{to_str}",
        "limit": 10,
        # MPC honours STAC `query` for cloud-cover filtering at the API.
        "query": {"eo:cloud_cover": {"lt": 80}},
    }
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(_MPC_STAC, json=body)
            if r.status_code != 200:
                logger.info(f"MPC STAC search {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
    except Exception as exc:
        logger.info(f"MPC STAC exception ({type(exc).__name__}): {exc}")
        return None

    features = data.get("features", []) or []
    # MPC doesn't always sort response by date; do it ourselves.
    features.sort(
        key=lambda f: (f.get("properties") or {}).get("datetime", ""),
        reverse=True,
    )
    chosen = _pick_best_scene(features)
    if chosen is None:
        logger.info(f"MPC Sentinel-2: no scenes for {lat:.4f},{lon:.4f}")
        return None

    props = chosen.get("properties", {}) or {}
    assets = chosen.get("assets", {}) or {}
    # Try `rendered_preview` (best — pre-rendered RGB PNG), then `preview`,
    # then `thumbnail` as last resort.
    preview_url = (
        (assets.get("rendered_preview") or {}).get("href")
        or (assets.get("preview") or {}).get("href")
        or (assets.get("thumbnail") or {}).get("href")
    )
    if not preview_url:
        logger.info("MPC Sentinel-2: scene has no preview/thumbnail asset")
        return None

    img_bytes = await _fetch_image_bytes(preview_url)
    if not img_bytes:
        return None

    cloud = props.get("eo:cloud_cover", 0) or 0
    acq = props.get("datetime", "")
    logger.info(
        f"MPC Sentinel-2 fetched: {len(img_bytes):,} bytes, "
        f"cloud={cloud:.1f}%, acq={acq}"
    )
    # The rendered_preview is PNG; previews/thumbnails may be JPEG. Detect
    # by looking at the URL extension; default to PNG for rendered_preview.
    is_png = ".png" in preview_url.lower() or "rendered_preview" in preview_url.lower()
    return {
        "image_b64": base64.b64encode(img_bytes).decode(),
        "image_media_type": "image/png" if is_png else "image/jpeg",
        "acquisition_date": acq,
        "cloud_cover_pct": round(float(cloud), 1),
        "source": "Sentinel-2 L2A via Microsoft Planetary Computer",
        "resolution_m": 10,
        "lat": lat, "lon": lon,
    }


# ── Provider 3: ESA Copernicus Data Space ──────────────────────────────────

async def _cdse_sentinel2(lat: float, lon: float, report_dt: datetime) -> Optional[dict]:
    """Query ESA's Copernicus Data Space STAC API.

    Direct from the data source (ESA), the most authoritative origin
    for Sentinel-2. STAC search is open; the QUICKLOOK asset URL is
    a pre-rendered preview that doesn't require OAuth.

    CDSE migrated APIs in 2024-2025 and the STAC endpoint has shifted
    location at least once; we tolerate 404/other failures gracefully
    so the chain falls through to the next provider.
    """
    from_str, to_str = _date_range(report_dt)
    # CDSE collection naming: try common variants. STAC implementations
    # have used both lowercase ("sentinel-2-l2a") and all-caps
    # ("SENTINEL-2") at different stages. We try the lowercase form first
    # since it's the STAC convention; if no results, try the legacy form.
    for collection_name in ("sentinel-2-l2a", "SENTINEL-2"):
        body = {
            "collections": [collection_name],
            "bbox": _bbox(lat, lon),
            "datetime": f"{from_str}/{to_str}",
            "limit": 10,
        }
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(_CDSE_STAC, json=body)
                if r.status_code == 404:
                    # Endpoint may have moved; not worth shouting about.
                    logger.info(
                        f"CDSE STAC 404 for collection={collection_name} — endpoint may have moved"
                    )
                    return None
                if r.status_code != 200:
                    logger.info(
                        f"CDSE STAC search {r.status_code} (collection={collection_name}): {r.text[:200]}"
                    )
                    continue
                data = r.json()
        except Exception as exc:
            logger.info(f"CDSE STAC exception ({type(exc).__name__}): {exc}")
            continue

        features = data.get("features", []) or []
        if features:
            features.sort(
                key=lambda f: (f.get("properties") or {}).get("datetime", ""),
                reverse=True,
            )
            chosen = _pick_best_scene(features)
            if chosen is None:
                continue

            props = chosen.get("properties", {}) or {}
            assets = chosen.get("assets", {}) or {}
            # CDSE uses "QUICKLOOK" (uppercase); fall back to "thumbnail".
            quicklook_url = (
                (assets.get("QUICKLOOK") or {}).get("href")
                or (assets.get("thumbnail") or {}).get("href")
            )
            if not quicklook_url:
                logger.info("CDSE Sentinel-2: scene has no QUICKLOOK / thumbnail")
                continue

            img_bytes = await _fetch_image_bytes(quicklook_url)
            if not img_bytes:
                continue

            cloud = props.get("eo:cloud_cover", 0) or 0
            acq = props.get("datetime", "")
            logger.info(
                f"CDSE Sentinel-2 fetched: {len(img_bytes):,} bytes, "
                f"cloud={cloud:.1f}%, acq={acq}"
            )
            return {
                "image_b64": base64.b64encode(img_bytes).decode(),
                "image_media_type": "image/jpeg",
                "acquisition_date": acq,
                "cloud_cover_pct": round(float(cloud), 1),
                "source": "Sentinel-2 via ESA Copernicus Data Space",
                "resolution_m": 10,
                "lat": lat, "lon": lon,
            }

    logger.info(f"CDSE Sentinel-2: no scenes for {lat:.4f},{lon:.4f}")
    return None


# ── Provider 4: Mapbox Static API (rendered fallback) ──────────────────────

async def _mapbox_satellite(lat: float, lon: float, report_dt: datetime) -> Optional[dict]:
    """Mapbox satellite-v9 static tile — Maxar imagery.

    No date specificity (always shows the latest mosaic), but useful as
    a guaranteed fallback when Sentinel-2 sources are unreachable or
    when cloud cover is so persistent that no clear scene exists in
    the date window.
    """
    token = os.getenv("MAPBOX_TOKEN", "")
    if not token:
        logger.info("MAPBOX_TOKEN not set — Mapbox fallback skipped")
        return None
    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
        f"{lon},{lat},17/512x512"
        f"?access_token={token}"
    )
    img_bytes = await _fetch_image_bytes(url)
    if not img_bytes:
        return None
    logger.info(f"Mapbox satellite fetched: {len(img_bytes):,} bytes")
    return {
        "image_b64": base64.b64encode(img_bytes).decode(),
        "image_media_type": "image/jpeg",
        "acquisition_date": None,
        "cloud_cover_pct": None,
        "source": "Mapbox Satellite (Maxar)",
        "resolution_m": 0.5,
        "lat": lat, "lon": lon,
    }


# ── Provider chain (priority order) ────────────────────────────────────────

# Each entry is (display_name, async fn). The orchestrator iterates in
# order and returns the first non-None result. Renaming/reordering this
# list is the only thing needed to add a new provider.
_PROVIDERS: list[tuple[str, Callable[[float, float, datetime], Awaitable[Optional[dict]]]]] = [
    ("AWS Sentinel-2 (Element84 STAC)", _aws_sentinel2),
    ("Microsoft Planetary Computer", _mpc_sentinel2),
    ("ESA Copernicus Data Space", _cdse_sentinel2),
    ("Mapbox Satellite", _mapbox_satellite),
]


# ── Public API ─────────────────────────────────────────────────────────────

class SatelliteFetcher:
    """Fetch satellite imagery for a lat/lon point from all available providers.

    Apr 2026 second pass — refactored from a fallback CHAIN to a parallel
    FAN-OUT. All providers are queried simultaneously via asyncio.gather;
    every successful result is returned as part of an `images` list so
    the dashboard can render a side-by-side comparison view.

    Why fan-out for this use case:
      * UNDP demo benefits from visual proof of multi-source redundancy.
      * 3 of the 4 Sentinel-2 mirrors return ~identical imagery, but
        seeing all 3 confirms "they all agree" — a stronger truth signal
        for the analyst than "we trust this one source."
      * Mapbox shows different imagery (Maxar high-res) — genuinely
        complementary to the Sentinel-2 trio, not redundant.
      * Latency cost is bounded: gather waits for the slowest provider,
        which in practice is ~2 s vs ~500 ms for chain. Acceptable for
        a click-driven verify action.
      * Cost cost is one additional API call to each provider per verify
        — well within all four free tiers.

    Return shape (superset of the chain version, backward compatible):

        {
          "image_b64":        primary's bytes (legacy callers),
          "image_media_type": ...,
          "acquisition_date": ...,
          "cloud_cover_pct":  ...,
          "source":           ...,
          "resolution_m":     ...,
          "lat": ..., "lon": ...,
          "alt": {...} or None,           # legacy: first Mapbox result

          # NEW: every provider's result, in priority order.
          "images": [
            {image_b64, image_media_type, acquisition_date,
             cloud_cover_pct, source, resolution_m},
            ...
          ],
        }

    The "primary" (top-level fields) is the first non-Mapbox provider
    that returned successfully — typically AWS Sentinel-2. AI scoring
    in the verify endpoint uses the primary; the dashboard renders all
    images in a 2×2 grid.
    """

    async def fetch(
        self,
        lat: float,
        lon: float,
        report_dt: Optional[datetime] = None,
    ) -> Optional[dict]:
        if report_dt is None:
            report_dt = datetime.now(timezone.utc)
        if report_dt.tzinfo is None:
            report_dt = report_dt.replace(tzinfo=timezone.utc)

        # Fan out to all providers in parallel. asyncio.gather with
        # return_exceptions=True ensures one provider raising can't
        # cancel the others — we collect every outcome separately.
        import asyncio
        results = await asyncio.gather(
            *[fn(lat, lon, report_dt) for _, fn in _PROVIDERS],
            return_exceptions=True,
        )

        # Pair each result back with its provider name + filter to
        # successful (dict) results only. Exceptions are logged.
        ordered: list[tuple[str, dict]] = []
        for (name, _fn), outcome in zip(_PROVIDERS, results):
            if isinstance(outcome, Exception):
                logger.warning(
                    f"Provider {name!r} raised {type(outcome).__name__}: {outcome}"
                )
                continue
            if isinstance(outcome, dict):
                ordered.append((name, outcome))

        if not ordered:
            logger.warning(f"All satellite providers failed for {lat:.4f},{lon:.4f}")
            return None

        # Pick the primary: first non-Mapbox result (Sentinel-2 quality
        # is what AI scoring needs). If only Mapbox succeeded, that's
        # the primary too.
        primary_pair = next(
            ((n, r) for n, r in ordered if n != "Mapbox Satellite"),
            ordered[0],
        )
        primary_name, primary = primary_pair
        result_dict: dict = dict(primary)  # shallow copy

        # NEW: surface every successful provider so the dashboard can
        # render the 2×2 grid.
        result_dict["images"] = [r for _n, r in ordered]

        # LEGACY: `alt` field — first Mapbox result if any. Kept so older
        # frontend code that reads response.alt still works.
        for n, r in ordered:
            if n == "Mapbox Satellite":
                result_dict["alt"] = r
                break

        logger.info(
            f"Satellite fetch fan-out: {len(ordered)}/{len(_PROVIDERS)} providers "
            f"returned (primary={primary_name})"
        )
        return result_dict


# Module-level singleton (preserved name for import-compatibility).
satellite_fetcher = SatelliteFetcher()
