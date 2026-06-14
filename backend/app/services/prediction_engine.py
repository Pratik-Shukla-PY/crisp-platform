"""
Prediction Engine - Multi-signal intelligence gathering + Claude-powered risk forecasting.
Gathers: historical CRISP data, weather forecasts, seismic activity, geospatial risk, conflict signals.
"""
import os
import json
import logging
from datetime import datetime, timedelta, timezone
from math import radians, cos, sin, sqrt, atan2
from typing import Optional

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENWEATHER_KEY = os.getenv("OPENWEATHER_API_KEY", "")


def _haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1-a))


# ── Signal 1: Historical CRISP Data ──────────────────────────────────────────

def gather_historical(lat: float, lng: float, radius_km: float, db: Session) -> dict:
    """Aggregate past reports within radius over 90 days."""
    from app.models.report import Report, Location, ReportStatusEnum
    now = datetime.now(timezone.utc)
    cutoff_90 = now - timedelta(days=90)

    nearby = db.query(Report).join(Location).filter(
        Report.deletion_requested_at.is_(None),
        Report.server_created_at >= cutoff_90,
        Location.latitude.between(lat - (radius_km / 111), lat + (radius_km / 111)),
        Location.longitude.between(lng - (radius_km / 111), lng + (radius_km / 111)),
    ).all()

    # Filter by actual distance
    reports = [r for r in nearby if r.location and _haversine_km(lat, lng, r.location.latitude, r.location.longitude) <= radius_km]
    now_dt = now
    reports_30d = [r for r in reports if r.server_created_at and (now_dt - r.server_created_at.replace(tzinfo=timezone.utc) if r.server_created_at.tzinfo is None else r.server_created_at).days <= 30]

    # Crisis type distribution
    crisis_dist = {}
    severity_dist = {}
    damage_dist = {}
    for r in reports:
        ct = r.crisis_type or "UNKNOWN"
        crisis_dist[ct] = crisis_dist.get(ct, 0) + 1
        sv = r.severity.value if r.severity else "UNKNOWN"
        severity_dist[sv] = severity_dist.get(sv, 0) + 1
        dc = r.damage_classification or "UNKNOWN"
        damage_dist[dc] = damage_dist.get(dc, 0) + 1

    sev_scores = {"CRITICAL": 10, "SEVERE": 7, "MODERATE": 4, "MINOR": 2, "UNKNOWN": 1}
    avg_sev = sum(sev_scores.get(r.severity.value, 1) for r in reports) / max(len(reports), 1)

    false_count = sum(1 for r in reports if r.status == ReportStatusEnum.FALSE_ALARM)

    # Trend: compare first half vs second half of 90 days
    mid = now - timedelta(days=45)
    first_half = sum(1 for r in reports if r.server_created_at and r.server_created_at.replace(tzinfo=timezone.utc) < mid)
    second_half = len(reports) - first_half
    if second_half > first_half * 1.3:
        trending = "increasing"
    elif first_half > second_half * 1.3:
        trending = "decreasing"
    else:
        trending = "stable"

    return {
        "total_reports_30d": len(reports_30d),
        "total_reports_90d": len(reports),
        "crisis_type_distribution": crisis_dist,
        "severity_distribution": severity_dist,
        "damage_distribution": damage_dist,
        "avg_severity_score": round(avg_sev, 1),
        "false_alarm_rate": round((false_count / max(len(reports), 1)) * 100, 1),
        "trending": trending,
    }


# ── Signal 2: Weather Forecast ───────────────────────────────────────────────

async def gather_weather(lat: float, lng: float) -> dict:
    """Fetch 5-day weather forecast from OpenWeatherMap."""
    if not OPENWEATHER_KEY:
        logger.warning("[Prediction] No OPENWEATHER_API_KEY - using mock weather data")
        return {"next_24h": {"rain_mm": 0, "wind_kmh": 10, "temp_c": 28, "humidity": 65, "description": "Clear sky"},
                "next_72h": {"rain_mm": 5, "wind_kmh": 15}, "next_7d": {"rain_mm": 15},
                "alerts": [], "anomaly": None, "source": "mock"}

    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"https://api.openweathermap.org/data/2.5/forecast",
                           params={"lat": lat, "lon": lng, "appid": OPENWEATHER_KEY, "units": "metric"})
            if r.status_code != 200:
                logger.warning(f"[Prediction] Weather API error: {r.status_code}")
                return {"error": f"API {r.status_code}", "source": "openweathermap"}

            data = r.json()
            forecasts = data.get("list", [])

            # Aggregate by time windows
            rain_24h = sum(f.get("rain", {}).get("3h", 0) for f in forecasts[:8])
            rain_72h = sum(f.get("rain", {}).get("3h", 0) for f in forecasts[:24])
            rain_7d = sum(f.get("rain", {}).get("3h", 0) for f in forecasts)
            wind_max = max((f.get("wind", {}).get("speed", 0) * 3.6 for f in forecasts[:8]), default=0)
            temp = forecasts[0].get("main", {}).get("temp", 0) if forecasts else 0
            humidity = forecasts[0].get("main", {}).get("humidity", 0) if forecasts else 0
            desc = forecasts[0].get("weather", [{}])[0].get("description", "") if forecasts else ""

            # Check for anomalies
            anomaly = None
            if rain_24h > 50:
                anomaly = f"Heavy rainfall: {rain_24h:.0f}mm in 24h"
            elif wind_max > 80:
                anomaly = f"Severe wind: {wind_max:.0f}km/h"

            alerts = []
            if rain_24h > 30:
                alerts.append(f"Rain warning: {rain_24h:.0f}mm expected in 24h")
            if wind_max > 60:
                alerts.append(f"Wind warning: {wind_max:.0f}km/h gusts")

            return {
                "next_24h": {"rain_mm": round(rain_24h, 1), "wind_kmh": round(wind_max, 1),
                             "temp_c": round(temp, 1), "humidity": humidity, "description": desc},
                "next_72h": {"rain_mm": round(rain_72h, 1), "wind_kmh": round(wind_max, 1)},
                "next_7d": {"rain_mm": round(rain_7d, 1)},
                "alerts": alerts, "anomaly": anomaly, "source": "openweathermap",
            }
    except Exception as e:
        logger.warning(f"[Prediction] Weather fetch error: {e}")
        return {"error": str(e), "source": "openweathermap"}


# ── Signal 3: Seismic Activity ───────────────────────────────────────────────

async def gather_seismic(lat: float, lng: float, radius_km: int = 200) -> dict:
    """Fetch recent earthquake data from USGS (free, no API key)."""
    try:
        now = datetime.now(timezone.utc)
        start_7d = (now - timedelta(days=7)).strftime("%Y-%m-%d")
        start_30d = (now - timedelta(days=30)).strftime("%Y-%m-%d")

        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://earthquake.usgs.gov/fdsnws/event/1/query", params={
                "format": "geojson", "latitude": lat, "longitude": lng,
                "maxradiuskm": radius_km, "starttime": start_30d, "minmagnitude": 2.0,
            })
            if r.status_code != 200:
                return {"recent_quakes_7d": 0, "max_magnitude_30d": 0, "source": "usgs", "error": f"{r.status_code}"}

            data = r.json()
            features = data.get("features", [])
            quakes_7d = [f for f in features if f["properties"]["time"] > (now - timedelta(days=7)).timestamp() * 1000]
            mags = [f["properties"]["mag"] for f in features if f["properties"]["mag"]]
            depths = [f["geometry"]["coordinates"][2] for f in features if len(f["geometry"]["coordinates"]) > 2]

            return {
                "recent_quakes_7d": len(quakes_7d),
                "total_quakes_30d": len(features),
                "max_magnitude_30d": round(max(mags, default=0), 1),
                "avg_depth_km": round(sum(depths) / max(len(depths), 1), 1),
                "source": "usgs",
            }
    except Exception as e:
        logger.warning(f"[Prediction] Seismic fetch error: {e}")
        return {"recent_quakes_7d": 0, "max_magnitude_30d": 0, "source": "usgs", "error": str(e)}


# ── Signal 4: Geospatial Risk ────────────────────────────────────────────────

def gather_geospatial(lat: float, lng: float) -> dict:
    """Heuristic geospatial risk assessment based on coordinates."""
    # Coastal proximity (simplified: distance from nearest major coastline point)
    # Rough heuristic: if latitude is between tropics and near known coastal zones
    coastal_risk = "LOW"
    coastal_km = 500  # default far from coast

    # Known flood-prone river basins (simplified)
    flood_zones = [
        (23.8, 90.4, "Dhaka/Ganges Delta"), (25.6, 85.1, "Bihar/Ganges"),
        (19.1, 72.9, "Mumbai Coastal"), (13.1, 80.3, "Chennai Coastal"),
        (18.5, -72.3, "Port-au-Prince"), (30.0, 31.2, "Nile Delta"),
        (-6.2, 106.8, "Jakarta"), (14.6, 121.0, "Manila"),
    ]
    in_flood_zone = False
    for fz_lat, fz_lng, fz_name in flood_zones:
        if _haversine_km(lat, lng, fz_lat, fz_lng) < 100:
            in_flood_zone = True
            break

    # Elevation heuristic
    elevation_risk = "MEDIUM"
    if abs(lat) < 10 and not in_flood_zone:
        elevation_risk = "LOW"

    # Landslide risk (mountainous regions)
    landslide_risk = "LOW"
    mountain_zones = [(28.0, 84.0), (35.0, 75.0), (27.0, 88.0), (-2.0, 29.0), (15.0, -90.0)]
    for mz_lat, mz_lng in mountain_zones:
        if _haversine_km(lat, lng, mz_lat, mz_lng) < 200:
            landslide_risk = "HIGH"
            break

    return {
        "elevation_risk": elevation_risk,
        "coastal_proximity_km": coastal_km,
        "flood_zone": in_flood_zone,
        "landslide_risk": landslide_risk,
    }


# ── Signal 5: Conflict Signals ───────────────────────────────────────────────

def gather_conflict(lat: float, lng: float, radius_km: float, db: Session) -> dict:
    """Use CRISP conflict-type reports as proxy for conflict intelligence."""
    from app.models.report import Report, Location
    now = datetime.now(timezone.utc)
    cutoff_30 = now - timedelta(days=30)

    conflict_reports = db.query(Report).join(Location).filter(
        Report.deletion_requested_at.is_(None),
        Report.crisis_type == "CONFLICT",
        Report.server_created_at >= cutoff_30,
        Location.latitude.between(lat - (radius_km / 111), lat + (radius_km / 111)),
        Location.longitude.between(lng - (radius_km / 111), lng + (radius_km / 111)),
    ).all()

    count = len(conflict_reports)
    intensity = "LOW" if count < 2 else "MEDIUM" if count < 5 else "HIGH"

    return {
        "conflict_reports_30d": count,
        "conflict_intensity": intensity,
        "trending": "stable",
    }


# ── Main Prediction Function ─────────────────────────────────────────────────

async def run_prediction(zone_name: str, lat: float, lng: float, radius_km: float,
                         country: str, region: str, time_window_hours: int, db: Session) -> dict:
    """Run full multi-signal prediction for a zone. Returns Claude's assessment."""

    # Gather all signals
    historical = gather_historical(lat, lng, radius_km, db)
    weather = await gather_weather(lat, lng)
    seismic = await gather_seismic(lat, lng)
    geospatial = gather_geospatial(lat, lng)
    conflict = gather_conflict(lat, lng, radius_km, db)

    # Build intelligence briefing for Claude
    system_prompt = """You are a crisis prediction analyst for CRISP, a UN disaster response platform. You analyze multi-source intelligence signals to predict the probability and type of future crises in specific geographic zones.

Your predictions directly inform pre-positioning of rescue teams and resources. ACCURACY AND CALIBRATION ARE CRITICAL.

SCORING FRAMEWORK:
- 0-20: LOW risk - normal conditions, no action needed
- 21-50: MEDIUM risk - elevated signals, monitor closely
- 51-75: HIGH risk - significant threat indicators, prepare response
- 76-100: CRITICAL risk - imminent crisis likely, pre-deploy resources

CALIBRATION RULES:
- Weather alone (even severe) without historical precedent = max 60
- Historical pattern + weather confirmation = 70-90
- Multiple independent signals converging = 80-100
- Single data source = max 50 (insufficient confidence)
- Missing data reduces confidence, not risk score
- Consider seasonal patterns and geographic context

RESPONSE FORMAT - Return ONLY valid JSON:
{
  "risk_score": 0-100,
  "risk_level": "LOW|MEDIUM|HIGH|CRITICAL",
  "predicted_crisis_type": "FLOOD|EARTHQUAKE|CONFLICT|HURRICANE|CYCLONE|WILDFIRE|LANDSLIDE|PANDEMIC|OTHER|NONE",
  "time_window_hours": 24|72|168,
  "confidence_score": 0-100,
  "headline": "One-line summary for dispatch commanders",
  "contributing_factors": ["Factor 1 with specific data", "Factor 2", "Factor 3", "Factor 4", "Factor 5"],
  "signal_breakdown": {
    "historical_weight": 0-100,
    "weather_weight": 0-100,
    "seismic_weight": 0-100,
    "geospatial_weight": 0-100,
    "conflict_weight": 0-100
  },
  "recommended_action": "Specific actionable recommendation",
  "reasoning": "3-5 line detailed analysis explaining how signals were weighed"
}"""

    w24 = weather.get("next_24h", {})
    w72 = weather.get("next_72h", {})
    w7d = weather.get("next_7d", {})

    dossier = f"""═══ PREDICTION INTELLIGENCE BRIEFING ═══
Zone: {zone_name} ({lat}, {lng}) - {country or 'Unknown'}, {region or 'Unknown'}
Analysis period: Next {time_window_hours} hours

── SIGNAL 1: HISTORICAL CRISP DATA ──
Reports (30d): {historical['total_reports_30d']} | Reports (90d): {historical['total_reports_90d']}
Crisis distribution: {json.dumps(historical['crisis_type_distribution'])}
Severity avg: {historical['avg_severity_score']} | Trend: {historical['trending']}
Damage: {json.dumps(historical['damage_distribution'])}
False alarm rate: {historical['false_alarm_rate']}%

── SIGNAL 2: WEATHER FORECAST ──
Next 24h: {w24.get('rain_mm', 0)}mm rain, {w24.get('wind_kmh', 0)}km/h wind, {w24.get('temp_c', 0)}°C, {w24.get('description', 'N/A')}
Next 72h: {w72.get('rain_mm', 0)}mm rain total
Next 7d: {w7d.get('rain_mm', 0)}mm rain total
Alerts: {', '.join(weather.get('alerts', [])) or 'None'}
Anomaly: {weather.get('anomaly') or 'None'}

── SIGNAL 3: SEISMIC ACTIVITY ──
Quakes (7d, 200km): {seismic.get('recent_quakes_7d', 0)}
Total quakes (30d): {seismic.get('total_quakes_30d', 0)}
Max magnitude (30d): {seismic.get('max_magnitude_30d', 0)}
Avg depth: {seismic.get('avg_depth_km', 0)}km

── SIGNAL 4: GEOSPATIAL RISK ──
Elevation risk: {geospatial['elevation_risk']}
Coastal proximity: {geospatial['coastal_proximity_km']}km
Flood zone: {'YES' if geospatial['flood_zone'] else 'No'}
Landslide risk: {geospatial['landslide_risk']}

── SIGNAL 5: CONFLICT SIGNALS ──
Conflict reports (30d): {conflict['conflict_reports_30d']}
Intensity: {conflict['conflict_intensity']} | Trend: {conflict['trending']}

Generate prediction with full signal breakdown and specific contributing factors."""

    if not ANTHROPIC_KEY:
        logger.warning("[Prediction] No ANTHROPIC_API_KEY - returning mock prediction")
        return {
            "risk_score": 35, "risk_level": "MEDIUM", "predicted_crisis_type": "FLOOD",
            "time_window_hours": time_window_hours, "confidence_score": 40,
            "headline": f"Moderate flood risk in {zone_name} - monitoring recommended",
            "contributing_factors": ["Historical flood reports in area", "Seasonal rainfall pattern"],
            "signal_breakdown": {"historical_weight": 40, "weather_weight": 30, "seismic_weight": 5, "geospatial_weight": 20, "conflict_weight": 5},
            "recommended_action": "Monitor weather updates and maintain readiness",
            "reasoning": "Mock prediction - configure ANTHROPIC_API_KEY for real analysis",
            "weather_data": weather, "historical_summary": historical,
            "seismic_data": seismic, "geospatial_data": geospatial, "conflict_data": conflict,
        }

    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 1000,
                    "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                    "messages": [{"role": "user", "content": dossier}],
                })

            if r.status_code == 200:
                text = r.json().get("content", [{}])[0].get("text", "{}")
                try:
                    start = text.index('{')
                    end = text.rindex('}') + 1
                    result = json.loads(text[start:end])
                except (ValueError, json.JSONDecodeError):
                    result = {"risk_score": 30, "risk_level": "MEDIUM", "headline": text[:200],
                              "reasoning": text, "confidence_score": 20}

                # Attach raw signal data
                result["weather_data"] = weather
                result["historical_summary"] = historical
                result["seismic_data"] = seismic
                result["geospatial_data"] = geospatial
                result["conflict_data"] = conflict

                logger.info(f"[Prediction] {zone_name}: risk={result.get('risk_score')} type={result.get('predicted_crisis_type')}")
                return result
            else:
                logger.error(f"[Prediction] Claude API error: {r.status_code}")
                return {"error": f"API error {r.status_code}", "risk_score": 0, "risk_level": "LOW"}

    except Exception as e:
        logger.error(f"[Prediction] Engine error: {e}")
        return {"error": str(e), "risk_score": 0, "risk_level": "LOW"}
