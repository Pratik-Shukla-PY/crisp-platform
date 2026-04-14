"""
Prediction Models — PredictionZone + PredictionResult
Stores monitored geographic zones and Claude-powered risk forecasts.
"""
import uuid
import enum
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, JSON, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.session import Base


def gen_uuid():
    return str(uuid.uuid4())


class RiskLevelEnum(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class PredictionZone(Base):
    """Geographic area being monitored for crisis prediction."""
    __tablename__ = "prediction_zones"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    name = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    radius_km = Column(Float, default=25.0)
    country = Column(String(100), nullable=True)
    region = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    predictions = relationship("PredictionResult", back_populates="zone", cascade="all, delete-orphan",
                               order_by="PredictionResult.created_at.desc()")


class PredictionResult(Base):
    """Single prediction run — risk forecast for a zone at a point in time."""
    __tablename__ = "prediction_results"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    zone_id = Column(String(36), ForeignKey("prediction_zones.id", ondelete="CASCADE"), nullable=False, index=True)

    # Core prediction output
    risk_score = Column(Float, nullable=False)          # 0-100
    risk_level = Column(String(20), nullable=False)     # LOW, MEDIUM, HIGH, CRITICAL
    predicted_crisis_type = Column(String(30), nullable=True)  # FLOOD, EARTHQUAKE, etc.
    time_window_hours = Column(Integer, default=72)     # 24, 72, 168
    confidence_score = Column(Float, default=50.0)      # 0-100
    headline = Column(String(500), nullable=True)       # One-line summary

    # Explainability
    contributing_factors = Column(JSON, nullable=True)   # ["Heavy rainfall...", ...]
    signal_breakdown = Column(JSON, nullable=True)       # {historical: 35, weather: 45, ...}
    recommended_action = Column(String(500), nullable=True)
    reasoning = Column(Text, nullable=True)              # Full Claude reasoning

    # Cached input signals
    weather_data = Column(JSON, nullable=True)
    historical_summary = Column(JSON, nullable=True)
    seismic_data = Column(JSON, nullable=True)
    geospatial_data = Column(JSON, nullable=True)
    conflict_data = Column(JSON, nullable=True)

    # Validity
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    zone = relationship("PredictionZone", back_populates="predictions")
