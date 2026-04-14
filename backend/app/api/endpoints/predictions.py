"""
Prediction API — Zone management + forecast triggering + results retrieval.
Claude-powered multi-signal crisis risk prediction.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.prediction import PredictionZone, PredictionResult
from app.core.deps import require_viewer, require_analyst, require_admin

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class ZoneCreate(BaseModel):
    name: str = Field(..., max_length=255)
    latitude: float
    longitude: float
    radius_km: float = 25.0
    country: Optional[str] = None
    region: Optional[str] = None

class ForecastRequest(BaseModel):
    latitude: float
    longitude: float
    name: str = "Custom Zone"
    radius_km: float = 25.0
    country: Optional[str] = None
    region: Optional[str] = None
    time_window_hours: int = 72


# ── Zone Management ──────────────────────────────────────────────────────────

@router.get("/zones")
def list_zones(user=Depends(require_viewer), db: Session = Depends(get_db)):
    """List all monitored prediction zones with their latest risk score."""
    zones = db.query(PredictionZone).filter(PredictionZone.is_active == True).order_by(PredictionZone.name).all()
    result = []
    for z in zones:
        latest = db.query(PredictionResult).filter(
            PredictionResult.zone_id == z.id
        ).order_by(PredictionResult.created_at.desc()).first()
        result.append({
            "id": z.id, "name": z.name, "latitude": z.latitude, "longitude": z.longitude,
            "radius_km": z.radius_km, "country": z.country, "region": z.region,
            "latest_risk_score": latest.risk_score if latest else None,
            "latest_risk_level": latest.risk_level if latest else None,
            "latest_crisis_type": latest.predicted_crisis_type if latest else None,
            "latest_headline": latest.headline if latest else None,
            "last_updated": str(latest.created_at) if latest else None,
        })
    return result


@router.post("/zones", status_code=201)
def create_zone(req: ZoneCreate, user=Depends(require_admin), db: Session = Depends(get_db)):
    """Create a new monitored prediction zone."""
    zone = PredictionZone(
        name=req.name, latitude=req.latitude, longitude=req.longitude,
        radius_km=req.radius_km, country=req.country, region=req.region,
    )
    db.add(zone)
    db.commit()
    db.refresh(zone)
    logger.info(f"[Prediction] Zone created: {zone.name} ({zone.latitude}, {zone.longitude})")
    return {"id": zone.id, "name": zone.name, "message": "Zone created"}


@router.delete("/zones/{zone_id}")
def delete_zone(zone_id: str, user=Depends(require_admin), db: Session = Depends(get_db)):
    """Delete a prediction zone."""
    zone = db.query(PredictionZone).filter(PredictionZone.id == zone_id).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    db.delete(zone)
    db.commit()
    return {"message": "Zone deleted"}


# ── Forecasting ──────────────────────────────────────────────────────────────

@router.post("/forecast")
async def run_forecast(req: ForecastRequest, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Run a multi-signal prediction for a location. Creates zone if doesn't exist."""
    from app.services.prediction_engine import run_prediction

    # Find or create zone
    zone = db.query(PredictionZone).filter(
        PredictionZone.latitude.between(req.latitude - 0.01, req.latitude + 0.01),
        PredictionZone.longitude.between(req.longitude - 0.01, req.longitude + 0.01),
    ).first()

    if not zone:
        zone = PredictionZone(
            name=req.name, latitude=req.latitude, longitude=req.longitude,
            radius_km=req.radius_km, country=req.country, region=req.region,
        )
        db.add(zone)
        db.commit()
        db.refresh(zone)

    # Run prediction engine
    result = await run_prediction(
        zone.name, zone.latitude, zone.longitude, zone.radius_km,
        zone.country or req.country or "", zone.region or req.region or "",
        req.time_window_hours, db,
    )

    # Save result
    pred = PredictionResult(
        zone_id=zone.id,
        risk_score=result.get("risk_score", 0),
        risk_level=result.get("risk_level", "LOW"),
        predicted_crisis_type=result.get("predicted_crisis_type"),
        time_window_hours=result.get("time_window_hours", req.time_window_hours),
        confidence_score=result.get("confidence_score", 0),
        headline=result.get("headline"),
        contributing_factors=result.get("contributing_factors"),
        signal_breakdown=result.get("signal_breakdown"),
        recommended_action=result.get("recommended_action"),
        reasoning=result.get("reasoning"),
        weather_data=result.get("weather_data"),
        historical_summary=result.get("historical_summary"),
        seismic_data=result.get("seismic_data"),
        geospatial_data=result.get("geospatial_data"),
        conflict_data=result.get("conflict_data"),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=req.time_window_hours),
    )
    db.add(pred)
    db.commit()
    db.refresh(pred)

    return {
        "id": pred.id, "zone_id": zone.id, "zone_name": zone.name,
        "latitude": zone.latitude, "longitude": zone.longitude,
        **{k: v for k, v in result.items() if k not in ("weather_data", "historical_summary", "seismic_data", "geospatial_data", "conflict_data")},
        "created_at": str(pred.created_at),
    }


# ── Results Retrieval ────────────────────────────────────────────────────────

@router.get("/latest")
def get_latest_predictions(user=Depends(require_viewer), db: Session = Depends(get_db)):
    """Get the latest prediction for each active zone."""
    zones = db.query(PredictionZone).filter(PredictionZone.is_active == True).all()
    results = []
    for z in zones:
        latest = db.query(PredictionResult).filter(
            PredictionResult.zone_id == z.id
        ).order_by(PredictionResult.created_at.desc()).first()
        if latest:
            results.append({
                "zone_id": z.id, "zone_name": z.name,
                "latitude": z.latitude, "longitude": z.longitude,
                "risk_score": latest.risk_score, "risk_level": latest.risk_level,
                "predicted_crisis_type": latest.predicted_crisis_type,
                "time_window_hours": latest.time_window_hours,
                "confidence_score": latest.confidence_score,
                "headline": latest.headline,
                "contributing_factors": latest.contributing_factors,
                "signal_breakdown": latest.signal_breakdown,
                "recommended_action": latest.recommended_action,
                "reasoning": latest.reasoning,
                "created_at": str(latest.created_at),
            })
    return results


@router.get("/heatmap")
def get_prediction_heatmap(user=Depends(require_viewer), db: Session = Depends(get_db)):
    """Get [lat, lng, risk_score] array for map heatmap overlay."""
    zones = db.query(PredictionZone).filter(PredictionZone.is_active == True).all()
    points = []
    for z in zones:
        latest = db.query(PredictionResult).filter(
            PredictionResult.zone_id == z.id
        ).order_by(PredictionResult.created_at.desc()).first()
        if latest:
            points.append([z.latitude, z.longitude, latest.risk_score / 100])
    return points


@router.get("/{zone_id}/history")
def get_zone_history(zone_id: str, user=Depends(require_viewer), db: Session = Depends(get_db)):
    """Get prediction history for a zone (trend analysis)."""
    zone = db.query(PredictionZone).filter(PredictionZone.id == zone_id).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")

    history = db.query(PredictionResult).filter(
        PredictionResult.zone_id == zone_id
    ).order_by(PredictionResult.created_at.desc()).limit(50).all()

    return {
        "zone": {"id": zone.id, "name": zone.name, "latitude": zone.latitude, "longitude": zone.longitude},
        "predictions": [{
            "id": p.id, "risk_score": p.risk_score, "risk_level": p.risk_level,
            "predicted_crisis_type": p.predicted_crisis_type,
            "time_window_hours": p.time_window_hours,
            "confidence_score": p.confidence_score,
            "headline": p.headline, "contributing_factors": p.contributing_factors,
            "signal_breakdown": p.signal_breakdown,
            "recommended_action": p.recommended_action,
            "created_at": str(p.created_at),
        } for p in history],
    }
