import uuid
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, Enum, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from app.db.session import Base

def gen_uuid():
    return str(uuid.uuid4())

class SourceEnum(str, enum.Enum):
    APP = "APP"
    WHATSAPP = "WHATSAPP"
    TELEGRAM = "TELEGRAM"

class SeverityEnum(str, enum.Enum):
    MINOR = "MINOR"
    MODERATE = "MODERATE"
    SEVERE = "SEVERE"
    CRITICAL = "CRITICAL"
    UNKNOWN = "UNKNOWN"

class InfraTypeEnum(str, enum.Enum):
    ROAD = "ROAD"
    HOSPITAL = "HOSPITAL"
    HOUSE = "HOUSE"
    POWER = "POWER"
    WATER = "WATER"
    OTHER = "OTHER"

class MediaTypeEnum(str, enum.Enum):
    IMAGE = "IMAGE"
    AUDIO = "AUDIO"

class ResolutionEnum(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    ORIGINAL = "ORIGINAL"

class SyncStatusEnum(str, enum.Enum):
    PARTIAL = "PARTIAL"
    QUEUED = "QUEUED"
    SYNCED = "SYNCED"
    FAILED = "FAILED"

class ReportStatusEnum(str, enum.Enum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    RESPONDING = "RESPONDING"
    RESOLVED = "RESOLVED"
    REJECTED = "REJECTED"
    FALSE_ALARM = "FALSE_ALARM"

class ClusterStatusEnum(str, enum.Enum):
    ACTIVE = "ACTIVE"
    RESOLVED = "RESOLVED"
    FALSE_ALARM = "FALSE_ALARM"

class Device(Base):
    __tablename__ = "devices"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_hash = Column(String(255), unique=True, nullable=False)
    platform = Column(String(50))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    reports = relationship("Report", back_populates="device")
    sync_logs = relationship("SyncLog", back_populates="device")

class Report(Base):
    __tablename__ = "reports"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    client_report_id = Column(String(36), unique=True, nullable=True, index=True)
    device_id = Column(String(36), ForeignKey("devices.id", ondelete="SET NULL"))
    source = Column(Enum(SourceEnum), default=SourceEnum.APP, nullable=False)
    status = Column(Enum(ReportStatusEnum), default=ReportStatusEnum.PENDING, nullable=False)
    sync_status = Column(Enum(SyncStatusEnum), default=SyncStatusEnum.QUEUED, nullable=False)
    severity = Column(Enum(SeverityEnum), default=SeverityEnum.UNKNOWN, nullable=False)
    infrastructure_type = Column(Enum(InfraTypeEnum), default=InfraTypeEnum.OTHER, nullable=False)
    description = Column(String)
    is_auto_submitted = Column(Boolean, default=False, nullable=False)
    expected_media = Column(Integer, default=0, nullable=False)   # How many media files expected
    received_media = Column(Integer, default=0, nullable=False)   # How many received so far
    client_created_at = Column(DateTime(timezone=True))
    server_created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    device = relationship("Device", back_populates="reports")
    location = relationship("Location", back_populates="report", uselist=False, cascade="all, delete-orphan")
    media = relationship("Media", back_populates="report", cascade="all, delete-orphan")
    ai_analysis = relationship("AIAnalysis", back_populates="report", uselist=False, cascade="all, delete-orphan")

class Location(Base):
    __tablename__ = "locations"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    device_latitude = Column(Float) # Original captured GPS
    device_longitude = Column(Float)
    accuracy_meters = Column(Float)
    is_user_corrected = Column(Boolean, default=False)
    user_location_name = Column(String, nullable=True)  # Place name typed by user when offline
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="location")

class Media(Base):
    __tablename__ = "media"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum(MediaTypeEnum), nullable=False)
    resolution_tier = Column(Enum(ResolutionEnum), default=ResolutionEnum.LOW, nullable=False)
    url = Column(String, nullable=False)
    file_size_bytes = Column(Integer)
    is_synced = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="media")

class AIAnalysis(Base):
    __tablename__ = "ai_analysis"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    damage_score = Column(Float)
    ai_severity = Column(Enum(SeverityEnum))
    transcription = Column(String)
    detected_labels = Column(JSON, default=list)
    processing_time_ms = Column(Integer)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="ai_analysis")

class IncidentCluster(Base):
    __tablename__ = "incident_clusters"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    center_lat = Column(Float, nullable=False)
    center_lng = Column(Float, nullable=False)
    radius_meters = Column(Float, nullable=False, default=50.0)
    confidence_score = Column(Float, default=0.0)
    status = Column(Enum(ClusterStatusEnum), default=ClusterStatusEnum.ACTIVE, nullable=False)
    primary_infrastructure_type = Column(Enum(InfraTypeEnum))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class ClusterReport(Base):
    __tablename__ = "cluster_reports"
    cluster_id = Column(String(36), ForeignKey("incident_clusters.id", ondelete="CASCADE"), primary_key=True)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True)
    added_at = Column(DateTime(timezone=True), server_default=func.now())

class SyncLog(Base):
    __tablename__ = "sync_logs"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_id = Column(String(36), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    synced_report_count = Column(Integer, default=0)
    last_sync_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(Enum(SyncStatusEnum), nullable=False)

    device = relationship("Device", back_populates="sync_logs")
