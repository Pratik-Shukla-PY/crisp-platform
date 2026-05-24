"""
CRISP Multi-Layer Geocoder — Converts text location descriptions to lat/lng.

Used by: IVR webhook, SMS webhook, AI extractor.

Multi-layer approach (tries each until success):
  Layer 1: Claude AI fixes mangled transcription → correct place name
           e.g. "bath deep balia" → "Bansdih, Ballia, Uttar Pradesh"
  Layer 2: Mapbox Geocoding API (best fuzzy matching for Indian locations)
  Layer 3: Nominatim fallback (free, no API key, OSM-based)

Prompt caching: The Claude system prompt (place name examples + rules) is
cached with cache_control=ephemeral, saving ~90% on repeated calls within 5 min.

Returns: { latitude, longitude, location_name, confidence, source }
"""
import os
import json
import logging
import hashlib
from datetime import datetime, timedelta, timezone

import httpx
from aiolimiter import AsyncLimiter

logger = logging.getLogger(__name__)

MAPBOX_TOKEN = os.getenv("MAPBOX_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# HC55 (May 2026) — worker-shared rate limiters.
#
# Nominatim's usage policy caps third-party apps at ≤ 1 req/s globally.
# Without a worker-shared token bucket, each FastAPI coroutine in this
# worker would happily fire its own RPS budget and earn the whole
# deployment a 429 ban — exactly what the operator's 2026-05-24 HAR
# captured. `AsyncLimiter(1, 1)` blocks the second concurrent call until
# the per-second budget refreshes. Multi-worker safety still relies on
# the Redis bucket in app/utils/rate_limit.py, but the hot path through
# this module is the one user-facing taps actually exercise.
_NOMINATIM_LIMITER = AsyncLimiter(max_rate=1, time_period=1)

# Mapbox geocoding API allows 600 req/min (~10 RPS) on the free tier.
# The limiter is mostly defensive — runaway code paths (e.g. an infinite
# retry loop) get clamped at the policy limit rather than burning the
# operator's free-tier budget in seconds.
_MAPBOX_LIMITER = AsyncLimiter(max_rate=600, time_period=60)

# Common noise words to strip before geocoding
NOISE_WORDS = [
    "help", "urgent", "emergency", "please", "need", "sos", "rescue",
    "flood", "fire", "accident", "damage", "broken", "collapsed",
    "stuck", "trapped", "water", "road", "hospital", "house", "power",
    "location", "situation", "i am in", "i'm in", "we are in", "near",
    "my village", "my city", "my area", "the area of", "from",
    "thanks for watching", "thank you",
]


def _clean_query(text: str) -> str:
    """Remove noise words and crisis jargon from text for geocoding."""
    query = text.lower()
    for word in NOISE_WORDS:
        query = query.replace(word, " ")
    # Remove extra spaces
    query = " ".join(query.split()).strip()
    return query if len(query) >= 3 else text.strip()


async def _ai_extract_location(text: str) -> str:
    """
    Use Claude to extract the actual place name from garbled transcription.
    Whisper's translate task produces phonetic garbage for Indian names:
      "bath deep balia" → should be "Bansdih, Ballia, Uttar Pradesh"
      "Priyad Raj" → should be "Prayagraj, Uttar Pradesh"
    Claude understands these phonetic approximations.
    """
    if not ANTHROPIC_API_KEY or not text or len(text.strip()) < 3:
        return ""

    try:
        # System prompt is static — cached across all geocoding calls (90% token savings)
        system_prompt = """You are a geographic location extractor for CRISP crisis platform. You fix mangled Whisper transcriptions of Indian place names.

Examples of Whisper mangling:
- "bath deep balia" → Bansdih, Ballia, Uttar Pradesh
- "Priyad Raj" → Prayagraj, Uttar Pradesh
- "Electronic City Bangalore" → Electronic City, Bengaluru, Karnataka
- "cora mangla" → Koramangala, Bengaluru
- "mum buy" → Mumbai, Maharashtra

Rules: Return ONLY the corrected place name (city/village, district, state). If no location found, return "NONE". No explanation."""

        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 100,
                    "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                    "messages": [{"role": "user", "content": f"Text: \"{text}\""}],
                },
            )
            if r.status_code == 200:
                result = r.json()
                place = result.get("content", [{}])[0].get("text", "").strip()
                if place and place.upper() != "NONE" and len(place) > 2:
                    logger.info(f"AI location fix: '{text}' → '{place}'")
                    return place
    except Exception as e:
        logger.warning(f"AI location extraction error: {e}")

    return ""


async def _geocode_mapbox(query: str, country_hint: str = "IN", language: str = "en") -> dict:
    """Geocode using Mapbox — excellent fuzzy matching for Indian locations.

    The `language` parameter (UNDP §3.1f.5) accepts a 2-letter ISO 639-1
    code. Passing the requester's locale ensures `place_name` and the
    `text` field per `context` entry come back in that language.
    Without this, an Arabic or Chinese requester would get Latinised
    place names, which looks broken on a UI rendered in AR / ZH.
    """
    if not MAPBOX_TOKEN:
        return {}

    try:
        country_code = {"India": "IN", "india": "IN"}.get(country_hint, country_hint or "IN")
        # HC55 — defensive rate-limit (see _MAPBOX_LIMITER comment at top
        # of file). Mapbox's free tier is 600 req/min; we run a single
        # token bucket so a runaway loop can't blow it.
        async with _MAPBOX_LIMITER, httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json",
                params={
                    "access_token": MAPBOX_TOKEN,
                    "country": country_code,
                    "limit": 1,
                    "types": "place,locality,neighborhood,address,district,region",
                    "language": _normalise_language(language),
                },
            )
            if r.status_code == 200:
                data = r.json()
                features = data.get("features", [])
                if features:
                    feat = features[0]
                    lng, lat = feat["center"]  # Mapbox returns [lng, lat]
                    place_name = feat.get("place_name", "")
                    relevance = feat.get("relevance", 0)

                    # Build clean location name from context
                    context = feat.get("context", [])
                    parts = [feat.get("text", "")]
                    for ctx in context:
                        cid = ctx.get("id", "")
                        if any(t in cid for t in ["district", "region", "place"]):
                            parts.append(ctx.get("text", ""))
                    location_name = ", ".join(parts[:3])

                    confidence = "high" if relevance > 0.8 else "medium" if relevance > 0.5 else "low"
                    logger.info(f"Mapbox geocoded '{query}' → {lat:.4f},{lng:.4f} ({location_name}) relevance={relevance:.2f}")
                    return {
                        "latitude": lat,
                        "longitude": lng,
                        "location_name": location_name,
                        "confidence": confidence,
                        "source": "mapbox",
                    }
    except Exception as e:
        logger.warning(f"Mapbox geocoding error: {e}")

    return {}


async def _geocode_nominatim(query: str, country_hint: str = "India", language: str = "en") -> dict:
    """Geocode using Nominatim (free, no API key required).

    The `language` parameter (UNDP §3.1f.5): Nominatim honours the
    Accept-Language header for `display_name` and `address.*` fields.
    Passing the requester's locale ensures the place name returned to
    an Arabic/Chinese/etc. user is in their script, not transliterated.
    """
    search_query = f"{query}, {country_hint}" if country_hint else query
    try:
        # HC55 — the policy-mandated ≤ 1 RPS gate. Every Nominatim hit
        # in this module (forward + reverse) blocks on _NOMINATIM_LIMITER
        # so the operator's 2026-05-24 429 cascade can't repeat.
        async with _NOMINATIM_LIMITER, httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": search_query, "format": "json", "limit": 1, "addressdetails": 1},
                headers={"User-Agent": "CRISP-Platform/1.0", "Accept-Language": _normalise_language(language)},
            )
            if r.status_code == 200:
                results = r.json()
                if results:
                    result = results[0]
                    lat = float(result["lat"])
                    lng = float(result["lon"])

                    osm_type = result.get("type", "")
                    if osm_type in ("city", "town", "village", "suburb", "neighbourhood"):
                        confidence = "medium"
                    elif osm_type in ("state", "country"):
                        confidence = "low"
                    else:
                        confidence = "medium"

                    addr = result.get("address", {})
                    parts = []
                    local = addr.get("neighbourhood") or addr.get("suburb") or addr.get("village") or addr.get("town") or ""
                    city = addr.get("city") or addr.get("county") or ""
                    state = addr.get("state") or ""
                    if local:
                        parts.append(local)
                    if city and city != local:
                        parts.append(city)
                    if state and state != city:
                        parts.append(state)
                    location_name = ", ".join(parts) if parts else result.get("display_name", "").split(",")[0]

                    logger.info(f"Nominatim geocoded '{query}' → {lat:.4f},{lng:.4f} ({location_name}) conf={confidence}")
                    return {
                        "latitude": lat,
                        "longitude": lng,
                        "location_name": location_name,
                        "confidence": confidence,
                        "source": "nominatim",
                    }
    except Exception as e:
        logger.warning(f"Nominatim geocoding error: {e}")

    return {}


# UNDP §3.1f.5. Maps any input locale string to a 2-letter
# ISO 639-1 code that BOTH Mapbox and Nominatim accept. Falls back to
# "en" for anything we don't recognise so we never break geocoding when
# a caller passes a weird value (e.g. "en-US-x-icu").
_SUPPORTED_LANGUAGE_CODES = {"en", "fr", "es", "ar", "ru", "zh"}


def _normalise_language(language: str) -> str:
    if not language:
        return "en"
    code = language.strip().lower().split("-")[0].split("_")[0]
    return code if code in _SUPPORTED_LANGUAGE_CODES else "en"


async def geocode_text(location_text: str, country_hint: str = "India", language: str = "en") -> dict:
    """
    Geocode a text location description to lat/lng using multi-layer approach:

    1. Clean text → try Mapbox (fuzzy match)
    2. If fail → Claude AI fixes place name → try Mapbox
    3. If fail → try Nominatim with AI-fixed name
    4. If fail → try Nominatim with cleaned text

    The `language` parameter (UNDP §3.1f.5) threads down to Mapbox's
    `language=` query param and Nominatim's `Accept-Language` header
    so the returned place names match the requester's UI locale.
    Default "en" matches existing behaviour.

    Returns:
        {
            "latitude": float or None,
            "longitude": float or None,
            "location_name": str,
            "confidence": "low" | "medium" | "high",
            "source": str,
        }
    """
    empty = {"latitude": None, "longitude": None, "location_name": "", "confidence": "low", "source": "text_geocoding"}

    if not location_text or len(location_text.strip()) < 3:
        return empty

    cleaned = _clean_query(location_text)
    logger.info(f"Geocoding: raw='{location_text[:80]}' cleaned='{cleaned[:60]}' lang='{language}'")

    best = None  # Track best result so far

    # ── Layer 1: Claude AI fixes the place name FIRST ────────────────────────
    # This is critical for voice transcriptions where Whisper mangles names
    ai_place = await _ai_extract_location(location_text)
    if ai_place:
        # Try AI-fixed name on Mapbox (best combo)
        result = await _geocode_mapbox(ai_place, language=language)
        if result.get("latitude"):
            if result.get("confidence") in ("high", "medium"):
                return result  # High confidence — use it
            best = result

        # Try AI-fixed name on Nominatim
        result = await _geocode_nominatim(ai_place, country_hint, language=language)
        if result.get("latitude"):
            if result.get("confidence") in ("high", "medium"):
                return result
            if not best:
                best = result

    # ── Layer 2: Try Mapbox with cleaned text ────────────────────────────────
    result = await _geocode_mapbox(cleaned, country_hint, language=language)
    if result.get("latitude"):
        if result.get("confidence") in ("high", "medium"):
            return result
        if not best:
            best = result

    # ── Layer 3: Nominatim with cleaned text ─────────────────────────────────
    result = await _geocode_nominatim(cleaned, country_hint, language=language)
    if result.get("latitude"):
        if result.get("confidence") in ("high", "medium"):
            return result
        if not best:
            best = result

    # ── Layer 4: Nominatim with raw text (last resort) ───────────────────────
    if cleaned != location_text.strip():
        result = await _geocode_nominatim(location_text.strip(), country_hint, language=language)
        if result.get("latitude"):
            if not best:
                best = result

    # Return best result we found (even if low confidence), or empty
    if best:
        logger.info(f"Geocoding best result: {best.get('location_name')} (conf={best.get('confidence')}, src={best.get('source')})")
        return best

    logger.warning(f"All geocoding layers failed for: '{location_text[:80]}'")
    return empty


# ── HC55 (May 2026) — Reverse geocoding (coords → place name) ────────────────
#
# Replaces the 3 inline browser → Nominatim calls in mobile-app/src/app.js
# (lines 3305, 5386, 5598) that the operator's 2026-05-24 HAR caught
# returning 429 from Nominatim's Varnish edge. PWA now POSTs lat/lng to
# /api/v1/reports/geocode/reverse; that route calls reverse_geocode_coords
# below, which fans through cache → Mapbox → rate-limited Nominatim →
# coords-only fallback.

# Coord rounding precision. 4 decimal places ≈ 11 m on the equator — finer
# than Nominatim's neighbourhood resolution, so two reporters in the same
# city block hit the same cache row.
_COORD_PRECISION = 4

# Default TTL for cached geocodes (7 days). Place names rarely change
# faster than this; the OSM-side updates that DO matter (new road, new
# building) will percolate into Mapbox on a similar cadence.
_CACHE_TTL = timedelta(days=7)


def _round_coord(value: float) -> float:
    """Round a lat/lng to the cache-key precision."""
    return round(float(value), _COORD_PRECISION)


def _stable_text_hash(text: str) -> float:
    """Stable int hash of a query string, fits in a Float column.

    Used only for forward-direction cache rows (lng_key = 0, lat_key =
    this hash). MD5 → 12 hex chars → int → float-safe (≤ 2^48).
    """
    h = hashlib.md5(text.strip().lower().encode("utf-8")).hexdigest()[:12]
    return float(int(h, 16))


async def _geocode_mapbox_reverse(lat: float, lng: float, language: str = "en") -> dict:
    """Mapbox reverse-geocode tier. Returns the place name closest to
    the given coords, or {} on failure.

    Mapbox expects ``{lng},{lat}`` in the URL path (NOT {lat},{lng} —
    that's a common bug). The `language` query param honours
    UNDP §3.1f.5 so AR/ZH users get native-script place names.
    """
    if not MAPBOX_TOKEN:
        return {}

    try:
        async with _MAPBOX_LIMITER, httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json",
                params={
                    "access_token": MAPBOX_TOKEN,
                    "limit": 1,
                    "types": "neighborhood,locality,place",
                    "language": _normalise_language(language),
                },
            )
            if r.status_code == 200:
                data = r.json()
                features = data.get("features", [])
                if features:
                    feat = features[0]
                    place_name = feat.get("place_name", "")
                    relevance = feat.get("relevance", 0)
                    parts = [feat.get("text", "")]
                    for ctx in feat.get("context", []):
                        cid = ctx.get("id", "")
                        if any(t in cid for t in ["place", "district", "region"]):
                            parts.append(ctx.get("text", ""))
                    location_name = ", ".join([p for p in parts[:3] if p])
                    confidence = ("high" if relevance > 0.8
                                  else "medium" if relevance > 0.5 else "low")
                    logger.info(
                        "Mapbox-reverse %.4f,%.4f → %s (rel=%.2f)",
                        lat, lng, location_name, relevance,
                    )
                    return {
                        "location_name": location_name or place_name,
                        "confidence": confidence,
                        "source": "mapbox",
                        "latitude": lat,
                        "longitude": lng,
                    }
            elif r.status_code == 429:
                logger.warning("Mapbox reverse 429 — falling through to Nominatim")
    except Exception as exc:
        logger.warning(f"Mapbox reverse-geocode error: {exc}")
    return {}


async def _geocode_nominatim_reverse(lat: float, lng: float, language: str = "en") -> dict:
    """Nominatim reverse-geocode tier. Rate-limited to 1 RPS via
    _NOMINATIM_LIMITER. Identifies CRISP via the User-Agent header
    (Nominatim policy requirement).
    """
    try:
        async with _NOMINATIM_LIMITER, httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "lat": lat, "lon": lng, "format": "json",
                    "zoom": 16, "addressdetails": 1,
                },
                headers={
                    "User-Agent": "CRISP-Platform/1.0",
                    "Accept-Language": _normalise_language(language),
                },
            )
            if r.status_code == 200:
                data = r.json() or {}
                addr = data.get("address") or {}
                parts = []
                local = (addr.get("neighbourhood") or addr.get("suburb")
                         or addr.get("hamlet") or addr.get("village")
                         or addr.get("town") or "")
                city = (addr.get("city") or addr.get("county")
                        or addr.get("state_district") or addr.get("state") or "")
                if local:
                    parts.append(local)
                if city and city != local:
                    parts.append(city)
                if addr.get("country"):
                    parts.append(addr["country"])
                location_name = ", ".join(parts) if parts else (data.get("display_name") or "")
                if location_name:
                    logger.info(
                        "Nominatim-reverse %.4f,%.4f → %s",
                        lat, lng, location_name,
                    )
                    return {
                        "location_name": location_name,
                        "confidence": "medium",
                        "source": "nominatim",
                        "latitude": lat,
                        "longitude": lng,
                    }
            elif r.status_code == 429:
                logger.warning(
                    "Nominatim reverse 429 — rate-limit shouldn't fire under "
                    "_NOMINATIM_LIMITER, investigate if recurring"
                )
    except Exception as exc:
        logger.warning(f"Nominatim reverse-geocode error: {exc}")
    return {}


def _coords_fallback(lat: float, lng: float) -> dict:
    """Last-resort response shape — used when both Mapbox and Nominatim
    return empty. The PWA's client-side renderer keeps showing raw
    coordinates rather than blanking the location pill, so the response
    contract stays uniform.
    """
    return {
        "location_name": f"{lat:.4f}°, {lng:.4f}°",
        "confidence": "none",
        "source": "fallback",
        "latitude": lat,
        "longitude": lng,
    }


def _cache_lookup(db, *, direction: str, lat_key: float, lng_key: float,
                  language: str) -> dict | None:
    """Return a cached geocode dict, or None if no live row exists.

    Lazy eviction — only rows whose expires_at is still in the future
    are returned. The hourly sweep (separate follow-up) reclaims old
    rows in bulk.
    """
    from app.models.report import GeocodeCache  # local import: avoid cycles
    now = datetime.now(timezone.utc)
    row = (
        db.query(GeocodeCache)
        .filter(
            GeocodeCache.direction == direction,
            GeocodeCache.lat_key == lat_key,
            GeocodeCache.lng_key == lng_key,
            GeocodeCache.language == language,
            GeocodeCache.expires_at > now,
        )
        .first()
    )
    if not row:
        return None
    return {
        "location_name": row.location_name,
        "confidence": row.confidence or "medium",
        "source": "cache",
        "latitude": row.latitude,
        "longitude": row.longitude,
    }


def _cache_write(db, *, direction: str, lat_key: float, lng_key: float,
                 language: str, payload: dict) -> None:
    """Persist a geocode result. Idempotent: if a row already exists
    (race between two coroutines for the same coord), the second writer
    wins — same payload, just a fresher expires_at.
    """
    from app.models.report import GeocodeCache  # local import
    if payload.get("source") in ("fallback", "cache"):
        return  # Never persist the synthetic shapes.
    now = datetime.now(timezone.utc)
    existing = (
        db.query(GeocodeCache)
        .filter(
            GeocodeCache.direction == direction,
            GeocodeCache.lat_key == lat_key,
            GeocodeCache.lng_key == lng_key,
            GeocodeCache.language == language,
        )
        .first()
    )
    if existing:
        existing.location_name = payload.get("location_name") or existing.location_name
        existing.source = payload.get("source") or existing.source
        existing.confidence = payload.get("confidence")
        existing.latitude = payload.get("latitude")
        existing.longitude = payload.get("longitude")
        existing.expires_at = now + _CACHE_TTL
    else:
        db.add(GeocodeCache(
            direction=direction,
            lat_key=lat_key,
            lng_key=lng_key,
            language=language,
            location_name=payload.get("location_name", ""),
            source=payload.get("source", "unknown"),
            confidence=payload.get("confidence"),
            latitude=payload.get("latitude"),
            longitude=payload.get("longitude"),
            expires_at=now + _CACHE_TTL,
        ))
    try:
        db.commit()
    except Exception as exc:
        # Cache failures are non-blocking — the live response still
        # ships. Roll back so the surrounding request transaction
        # isn't poisoned by a unique-constraint race.
        logger.warning(f"Geocode cache write failed: {exc}")
        db.rollback()


async def reverse_geocode_coords(
    lat: float, lng: float, language: str = "en", db=None,
) -> dict:
    """coords → {location_name, confidence, source, latitude, longitude}.

    Cascade order:
      1. Postgres cache (when ``db`` provided)
      2. Mapbox reverse-geocode
      3. Nominatim reverse-geocode (rate-limited to 1 RPS)
      4. ``_coords_fallback`` — raw "lat°, lng°" string

    Always returns a non-empty dict so the caller can paint *something*
    on the location pill — the operator's pre-HC55 experience of seeing
    raw lat/lng was actually the implicit fallback from a null return.
    Now the contract is explicit.
    """
    lat = float(lat)
    lng = float(lng)
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        raise ValueError(f"Coords out of range: lat={lat}, lng={lng}")

    norm_lang = _normalise_language(language)
    lat_key = _round_coord(lat)
    lng_key = _round_coord(lng)

    # 1. Cache hit?
    if db is not None:
        cached = _cache_lookup(
            db, direction="reverse",
            lat_key=lat_key, lng_key=lng_key, language=norm_lang,
        )
        if cached:
            logger.debug("geocode cache HIT reverse %.4f,%.4f", lat_key, lng_key)
            return cached

    # 2. Mapbox.
    result = await _geocode_mapbox_reverse(lat, lng, norm_lang)
    if not result:
        # 3. Nominatim fallback.
        result = await _geocode_nominatim_reverse(lat, lng, norm_lang)

    if not result:
        result = _coords_fallback(lat, lng)

    # 4. Persist if real.
    if db is not None and result.get("source") not in ("fallback", "cache"):
        _cache_write(
            db, direction="reverse",
            lat_key=lat_key, lng_key=lng_key, language=norm_lang,
            payload=result,
        )

    return result
