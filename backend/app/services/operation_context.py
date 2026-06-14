"""Operation context - local weather (Open-Meteo) + hazard alerts (GDACS).

Backend proxy for the operation dashboard's "Local conditions" panel. Mirrors the
satellite_fetcher.py house style: async httpx, each provider a graceful no-op on
any failure, a normalized dict out, queried SERVER-SIDE (never client-direct) so:
  * Open-Meteo's CC BY 4.0 attribution + non-commercial posture live in one place;
  * N analysts × refreshes collapse into ONE cached upstream call (45-min TTL);
  * the dashboard never hard-fails - a down provider yields {available: false}.

PII boundary (UNDP must-have #7): the ONLY values that ever leave this process are
the operation's centre coords (rounded ~3 dp) and radius. NEVER any Report /
Location / Reporter / Device data. The function signatures structurally cannot
carry report data - enforced by test_operation_context.py.

Sources (both free, no API key):
  * Open-Meteo /v1/forecast - current + 3-day. FREE tier is NON-COMMERCIAL; CRISP
    (UN/humanitarian, no ads/subscriptions) qualifies. CC BY 4.0 attribution shown.
  * GDACS geteventlist - UN OCHA + EC JRC multi-hazard disaster alerts; haversine-
    filtered to the operation circle (+ buffer, since GDACS events are large-scale).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import httpx

from app.services.nearby_aggregator import haversine_km

logger = logging.getLogger(__name__)

_TTL_SECONDS = 45 * 60          # weather/alerts change slowly; 45-min cache
_cache: dict = {}              # event_id -> (expires_at_epoch, payload)

# WMO weather-interpretation codes → short label (Open-Meteo current.weather_code).
_WMO = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Violent showers",
    85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm",
    96: "Thunderstorm + hail", 99: "Thunderstorm + heavy hail",
}


def cache_get(event_id: str):
    hit = _cache.get(event_id)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def cache_put(event_id: str, payload) -> None:
    _cache[event_id] = (time.time() + _TTL_SECONDS, payload)


async def _open_meteo(lat: float, lng: float) -> Optional[dict]:
    """Current conditions + a 3-day daily forecast. None on any failure."""
    try:
        params = {
            "latitude": round(float(lat), 3), "longitude": round(float(lng), 3),
            "current": "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
            "forecast_days": 3, "timezone": "auto",
        }
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://api.open-meteo.com/v1/forecast", params=params)
        if r.status_code != 200:
            return None
        d = r.json()
        cur = d.get("current") or {}
        daily = d.get("daily") or {}
        days = []
        try:
            for i, day in enumerate(daily.get("time", [])[:3]):
                days.append({
                    "date": day,
                    "t_max_c": (daily.get("temperature_2m_max") or [None] * 3)[i],
                    "t_min_c": (daily.get("temperature_2m_min") or [None] * 3)[i],
                    "precip_mm": (daily.get("precipitation_sum") or [None] * 3)[i],
                    "code": (daily.get("weather_code") or [None] * 3)[i],
                    "summary": _WMO.get((daily.get("weather_code") or [None] * 3)[i], "-"),
                })
        except Exception:
            days = []
        code = cur.get("weather_code")
        return {
            "temperature_c": cur.get("temperature_2m"),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "precipitation_mm": cur.get("precipitation"),
            "wind_kmh": cur.get("wind_speed_10m"),
            "code": code,
            "summary": _WMO.get(code, "-"),
            "daily": days,
            "attribution": "Weather by Open-Meteo.com (CC BY 4.0)",
        }
    except Exception as exc:
        logger.info(f"[op-context] open-meteo failed ({type(exc).__name__})")
        return None


async def _gdacs_alerts(lat: float, lng: float, radius_km: float) -> Optional[list]:
    """Recent GDACS disaster events near the operation circle. None on failure;
    [] when reachable but nothing nearby. Parsing is defensive across GDACS' field
    spellings so a schema tweak degrades to [] rather than raising."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP")
        if r.status_code != 200:
            return None
        d = r.json()
        feats = d.get("features") or []
        # Buffer: GDACS events are large-scale (cyclone tracks, flood basins), so
        # include events whose epicentre is within the op radius + 500 km.
        buffer_km = max(float(radius_km or 0), 0.0) + 500.0
        out = []
        for f in feats:
            try:
                geom = f.get("geometry") or {}
                props = f.get("properties") or {}
                coords = geom.get("coordinates") or []
                if len(coords) < 2:
                    continue
                elng, elat = float(coords[0]), float(coords[1])
                dist = haversine_km(float(lat), float(lng), elat, elng)
                if dist > buffer_km:
                    continue
                url = props.get("url") or {}
                report_url = url.get("report") if isinstance(url, dict) else (url if isinstance(url, str) else None)
                out.append({
                    "type": props.get("eventtype") or props.get("eventtypename"),
                    "name": props.get("name") or props.get("eventname") or props.get("htmldescription"),
                    "alert_level": (props.get("alertlevel") or "").title() or None,
                    "country": props.get("country"),
                    "from_date": props.get("fromdate"),
                    "distance_km": round(dist),
                    "url": report_url,
                })
            except Exception:
                continue
        out.sort(key=lambda x: x.get("distance_km", 1e9))
        return out[:10]
    except Exception as exc:
        logger.info(f"[op-context] gdacs failed ({type(exc).__name__})")
        return None


async def fetch_operation_context(lat: float, lng: float, radius_km: float) -> dict:
    """Fan out weather + hazard alerts concurrently. PII WHITELIST: the only data
    passed onward is lat/lng/radius - never any report/reporter data."""
    weather, alerts = await asyncio.gather(
        _open_meteo(lat, lng),
        _gdacs_alerts(lat, lng, radius_km),
        return_exceptions=False,
    )
    return {
        "available": (weather is not None) or (alerts is not None),
        "weather": weather,
        "alerts": alerts or [],
    }
