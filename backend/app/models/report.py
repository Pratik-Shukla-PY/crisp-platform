import uuid
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, Enum, JSON, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from app.db.session import Base

def gen_uuid():
    return str(uuid.uuid4())

class SourceEnum(str, enum.Enum):
    APP = "APP"
    ANDROID = "ANDROID"
    WHATSAPP = "WHATSAPP"
    TELEGRAM = "TELEGRAM"
    SMS = "SMS"
    IVR = "IVR"

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
    SCHOOL = "SCHOOL"
    TELECOM = "TELECOM"
    GOVERNMENT = "GOVERNMENT"
    OTHER = "OTHER"

class DamageClassEnum(str, enum.Enum):
    NO_DAMAGE = "NO_DAMAGE"
    PARTIAL = "PARTIAL"
    COMPLETE = "COMPLETE"

class CrisisTypeEnum(str, enum.Enum):
    EARTHQUAKE = "EARTHQUAKE"
    FLOOD = "FLOOD"
    CONFLICT = "CONFLICT"
    HURRICANE = "HURRICANE"
    CYCLONE = "CYCLONE"
    WILDFIRE = "WILDFIRE"
    LANDSLIDE = "LANDSLIDE"
    PANDEMIC = "PANDEMIC"
    OTHER = "OTHER"

class ServiceStatusEnum(str, enum.Enum):
    OPERATIONAL = "OPERATIONAL"
    DISRUPTED = "DISRUPTED"
    DESTROYED = "DESTROYED"
    UNKNOWN = "UNKNOWN"

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
    detected_language = Column(String(10), nullable=True)  # ISO language code (en, hi, zh, etc.)
    caller_info = Column(JSON, nullable=True)  # Phone number, network city/state for IVR/SMS/Telegram
    ai_assessment = Column(JSON, nullable=True)  # Cached AI assessment {score, action, summary, details}
    is_auto_submitted = Column(Boolean, default=False, nullable=False)
    expected_media = Column(Integer, default=0, nullable=False)   # How many media files expected
    received_media = Column(Integer, default=0, nullable=False)   # How many received so far
    client_created_at = Column(DateTime(timezone=True))
    server_created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deletion_requested_at = Column(DateTime(timezone=True), nullable=True)
    deletion_grace_minutes = Column(Integer, nullable=True, default=1440)  # 24h default, 30min for mobile
    lives_impacted = Column(Integer, nullable=True)  # How many lives saved/impacted by this report
    # UNDP required fields
    damage_classification = Column(String(20), nullable=True)   # NO_DAMAGE / PARTIAL / COMPLETE
    crisis_type = Column(String(30), nullable=True)             # EARTHQUAKE / FLOOD / CONFLICT / etc.
    infrastructure_name = Column(String(255), nullable=True)    # Specific building/road name
    debris_clearing_needed = Column(Boolean, nullable=True)     # Does this location need debris clearing?
    service_status = Column(JSON, nullable=True)                # {"electricity":"DISRUPTED","water":"OPERATIONAL",...}
    building_id = Column(String(36), nullable=True, index=True) # Links multiple reports about same structure

    device      = relationship("Device", back_populates="reports")
    location    = relationship("Location",    back_populates="report", uselist=False, cascade="all, delete-orphan")
    media       = relationship("Media",       back_populates="report", cascade="all, delete-orphan")
    ai_analysis = relationship("AIAnalysis",  back_populates="report", uselist=False, cascade="all, delete-orphan")
    verification = relationship("SatelliteVerification", back_populates="report", uselist=False, cascade="all, delete-orphan")


class DeletionAuditLog(Base):
    """Audit trail for deleted reports — preserves anonymized metadata for accountability."""
    __tablename__ = "deletion_audit_log"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), nullable=False, index=True)
    device_hash = Column(String(255), nullable=True)
    location_snapshot = Column(JSON, nullable=True)  # {lat, lng, name}
    damage_type = Column(String(50), nullable=True)
    severity = Column(String(20), nullable=True)
    deletion_source = Column(String(50), default="DASHBOARD")  # MOBILE, DASHBOARD, ADMIN
    deleted_at = Column(DateTime(timezone=True), server_default=func.now())


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
    user_location_name = Column(String, nullable=True)   # Place name selected by user (autocomplete / offline)
    device_location_name = Column(String, nullable=True) # Human-readable name of raw device GPS position
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="location")

class Media(Base):
    __tablename__ = "media"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum(MediaTypeEnum), nullable=False)
    resolution_tier = Column(Enum(ResolutionEnum), default=ResolutionEnum.LOW, nullable=False)
    url = Column(String, nullable=False, default='')
    file_size_bytes = Column(Integer)
    is_synced = Column(Boolean, default=False)
    # Chunked upload tracking (PRD §3.3/3.4/3.6)
    thumbnail_url = Column(String, nullable=True)           # tiny preview sent before chunks
    chunk_count = Column(Integer, default=0, nullable=False) # total chunks expected
    received_chunks = Column(Integer, default=0, nullable=False)
    completion_pct = Column(Float, default=0.0, nullable=False)
    assembly_status = Column(String(20), default='pending', nullable=False)  # pending|partial|complete
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="media")
    chunks = relationship("MediaChunk", back_populates="media", cascade="all, delete-orphan")


class MediaChunk(Base):
    """Individual ~1KB packet of a media file (PRD §3.3). Assembled into full file when complete."""
    __tablename__ = "media_chunks"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    media_id = Column(String(36), ForeignKey("media.id", ondelete="CASCADE"), nullable=False, index=True)
    seq_num = Column(Integer, nullable=False)
    total_chunks = Column(Integer, nullable=False)
    data_b64 = Column(Text, nullable=False)
    checksum = Column(String(16), nullable=True)
    received_at = Column(DateTime(timezone=True), server_default=func.now())

    media = relationship("Media", back_populates="chunks")

    __table_args__ = (UniqueConstraint('media_id', 'seq_num', name='uq_media_chunk_seq'),)

class AIAnalysis(Base):
    __tablename__ = "ai_analysis"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    damage_score = Column(Float)
    ai_severity = Column(Enum(SeverityEnum))
    transcription = Column(String)        # Raw Whisper transcription (may be rough)
    ai_summary = Column(String)           # Claude AI-cleaned English interpretation
    detected_labels = Column(JSON, default=list)
    processing_time_ms = Column(Integer)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="ai_analysis")


class SatelliteVerification(Base):
    """
    Stores the result of an AI-powered satellite truth-verification run.
    One row per report (unique on report_id). Re-running verification
    overwrites the previous result.
    """
    __tablename__ = "satellite_verifications"

    id                           = Column(String(36), primary_key=True, default=gen_uuid)
    report_id                    = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"),
                                          nullable=False, unique=True, index=True)

    # Composite truth score (0-100)
    total_score                  = Column(Integer, default=0)
    verdict                      = Column(String(50))   # e.g. LIKELY_AUTHENTIC

    # Component breakdown (stored as JSON: {location_authenticity, damage_corroboration, …})
    scores                       = Column(JSON)

    # AI narrative
    reasoning                    = Column(Text)
    key_findings                 = Column(JSON)         # list[str]
    caveats                      = Column(JSON)         # list[str]
    satellite_scene_description  = Column(Text)
    photo_analysis               = Column(Text)

    # Satellite metadata
    satellite_source             = Column(String(120))
    satellite_acquisition_date   = Column(String(50))   # ISO-8601 string
    satellite_cloud_cover_pct    = Column(Float)
    satellite_resolution_m       = Column(Float)
    satellite_days_gap           = Column(Integer)      # negative = post-incident

    # Saved satellite image path (served via /static/)
    satellite_image_url          = Column(String)

    # Alternate satellite source (e.g. Mapbox when Sentinel is primary)
    satellite_image_url_alt      = Column(String)
    satellite_source_alt         = Column(String(120))
    satellite_acquisition_date_alt = Column(String(50))
    satellite_resolution_m_alt   = Column(Float)

    # Error info (if scoring failed)
    error                        = Column(String)

    scored_at                    = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="verification")

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


class ReporterProfile(Base):
    """Gamification: tracks reporter engagement for UNDP incentive requirement."""
    __tablename__ = "reporter_profiles"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_hash = Column(String(255), unique=True, nullable=False, index=True)
    report_count = Column(Integer, default=0)
    verified_count = Column(Integer, default=0)       # reports that got verified/dispatched
    badge_level = Column(String(20), default="NEWCOMER")  # NEWCOMER / HELPER / GUARDIAN / HERO
    impact_score = Column(Integer, default=0)          # cumulative lives_impacted
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
