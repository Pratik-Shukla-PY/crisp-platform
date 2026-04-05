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
import httpx

logger = logging.getLogger(__name__)

MAPBOX_TOKEN = os.getenv("MAPBOX_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

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


async def _geocode_mapbox(query: str, country_hint: str = "IN") -> dict:
    """Geocode using Mapbox — excellent fuzzy matching for Indian locations."""
    if not MAPBOX_TOKEN:
        return {}

    try:
        country_code = {"India": "IN", "india": "IN"}.get(country_hint, country_hint or "IN")
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json",
                params={
                    "access_token": MAPBOX_TOKEN,
                    "country": country_code,
                    "limit": 1,
                    "types": "place,locality,neighborhood,address,district,region",
                    "language": "en",
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


async def _geocode_nominatim(query: str, country_hint: str = "India") -> dict:
    """Geocode using Nominatim (free, no API key required)."""
    search_query = f"{query}, {country_hint}" if country_hint else query
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": search_query, "format": "json", "limit": 1, "addressdetails": 1},
                headers={"User-Agent": "CRISP-Platform/1.0", "Accept-Language": "en"},
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


async def geocode_text(location_text: str, country_hint: str = "India") -> dict:
    """
    Geocode a text location description to lat/lng using multi-layer approach:

    1. Clean text → try Mapbox (fuzzy match)
    2. If fail → Claude AI fixes place name → try Mapbox
    3. If fail → try Nominatim with AI-fixed name
    4. If fail → try Nominatim with cleaned text

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
    logger.info(f"Geocoding: raw='{location_text[:80]}' cleaned='{cleaned[:60]}'")

    best = None  # Track best result so far

    # ── Layer 1: Claude AI fixes the place name FIRST ────────────────────────
    # This is critical for voice transcriptions where Whisper mangles names
    ai_place = await _ai_extract_location(location_text)
    if ai_place:
        # Try AI-fixed name on Mapbox (best combo)
        result = await _geocode_mapbox(ai_place)
        if result.get("latitude"):
            if result.get("confidence") in ("high", "medium"):
                return result  # High confidence — use it
            best = result

        # Try AI-fixed name on Nominatim
        result = await _geocode_nominatim(ai_place, country_hint)
        if result.get("latitude"):
            if result.get("confidence") in ("high", "medium"):
                return result
            if not best:
                best = result

    # ── Layer 2: Try Mapbox with cleaned text ────────────────────────────────
    result = await _geocode_mapbox(cleaned, country_hint)
    if result.get("latitude"):
        if result.get("confidence") in ("high", "medium"):
            return result
        if not best:
            best = result

    # ── Layer 3: Nominatim with cleaned text ─────────────────────────────────
    result = await _geocode_nominatim(cleaned, country_hint)
    if result.get("latitude"):
        if result.get("confidence") in ("high", "medium"):
            return result
        if not best:
            best = result

    # ── Layer 4: Nominatim with raw text (last resort) ───────────────────────
    if cleaned != location_text.strip():
        result = await _geocode_nominatim(location_text.strip(), country_hint)
        if result.get("latitude"):
            if not best:
                best = result

    # Return best result we found (even if low confidence), or empty
    if best:
        logger.info(f"Geocoding best result: {best.get('location_name')} (conf={best.get('confidence')}, src={best.get('source')})")
        return best

    logger.warning(f"All geocoding layers failed for: '{location_text[:80]}'")
    return empty
