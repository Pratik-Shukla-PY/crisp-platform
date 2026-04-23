"""Nearby-building suggestions for the Telegram bot.

Apr 2026 UX fix — the bot was asking the reporter to type a building
name freehand, which is slow on Telegram (small keyboard, crisis
stress, low literacy). This module adds a fast-path: immediately after
the reporter drops a location pin, we query OSM Overpass for the
nearest buildings in a 150 m radius and offer the top 5 as inline
buttons. One tap → `building_id = osm:way:<id>` on the session.

Design notes:
  * Overpass is a public best-effort service. Timeouts (8 s) are tight
    so the bot never hangs on a slow query; a miss falls straight
    through to the existing free-text prompt.
  * Ranks by centroid distance so closer buildings come first. The
    user is usually inside or adjacent to the damaged structure; the
    top-1 is almost always the right pick.
  * Deduplicates by name — two OSM ways for a single building (one
    for each wing) collapse into one chip to save screen space.
  * Returns a list of `{id, name, distance_m}` dicts suitable for
    rendering as inline keyboard buttons. `name` is the best label
    available (`name` → `name:en` → amenity type → "Building").
  * Never raises. Errors return an empty list; caller falls back.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_RADIUS_M = 150                                # bounded: quick query, still covers blocks
_TIMEOUT_S = 8.0


def _centroid(way: Dict[str, Any]) -> Optional[tuple[float, float]]:
    geom = way.get("geometry") or []
    if not geom or len(geom) < 3:
        return None
    lat_sum = 0.0
    lon_sum = 0.0
    for pt in geom:
        lat_sum += pt.get("lat", 0.0)
        lon_sum += pt.get("lon", 0.0)
    return (lat_sum / len(geom), lon_sum / len(geom))


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Equirectangular is fine at 150 m; haversine for correctness anyway.
    R = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(a))


def _best_name(tags: Dict[str, Any]) -> Optional[str]:
    if not tags:
        return None
    # Preference order: localised name → english name → amenity → building-type → None.
    for key in ("name", "name:en", "short_name"):
        v = tags.get(key)
        if v:
            return str(v).strip() or None
    amenity = tags.get("amenity")
    if amenity:
        return str(amenity).replace("_", " ").capitalize()
    btype = tags.get("building")
    if btype and btype != "yes":
        return str(btype).replace("_", " ").capitalize()
    return None


async def nearby_buildings(lat: float, lng: float, limit: int = 5) -> List[Dict[str, Any]]:
    """Return up to `limit` nearest buildings. Never raises."""
    if not (isinstance(lat, (int, float)) and isinstance(lng, (int, float))):
        return []

    query = (
        "[out:json][timeout:" + str(int(_TIMEOUT_S)) + "];"
        "(way(around:" + str(_RADIUS_M) + "," + str(lat) + "," + str(lng) + ')["building"];'
        "relation(around:" + str(_RADIUS_M) + "," + str(lat) + "," + str(lng) + ')["building"];'
        ");out body geom;"
    )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            res = await client.post(
                _OVERPASS_URL,
                data={"data": query},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if res.status_code != 200:
                return []
            data = res.json()
    except Exception as e:
        logger.warning("[building_lookup] Overpass fetch failed: %s", e)
        return []

    elems = (data or {}).get("elements") or []
    scored: List[Dict[str, Any]] = []
    seen_names: set = set()
    for el in elems:
        c = _centroid(el)
        if not c:
            continue
        name = _best_name(el.get("tags") or {})
        if name:
            key = name.lower()
            if key in seen_names:
                continue
            seen_names.add(key)
        d = _haversine_m(lat, lng, c[0], c[1])
        osm_type = el.get("type") or "way"
        scored.append({
            "id": f"osm:{osm_type}:{el.get('id')}",
            "name": name or "Unnamed building",
            "distance_m": int(d),
        })

    scored.sort(key=lambda r: r["distance_m"])
    return scored[: max(0, int(limit))]
