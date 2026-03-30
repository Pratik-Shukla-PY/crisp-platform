from datetime import datetime
from typing import List, Optional, Any
from pydantic import BaseModel, ConfigDict
from app.models.report import (
    SourceEnum, SeverityEnum, InfraTypeEnum, MediaTypeEnum, 
    ResolutionEnum, SyncStatusEnum, ReportStatusEnum, ClusterStatusEnum
)

# Shared Properties
class LocationBase(BaseModel):
    latitude: float
    longitude: float
    device_latitude: Optional[float] = None
    device_longitude: Optional[float] = None
    accuracy_meters: Optional[float] = None
    is_user_corrected: Optional[bool] = False
    user_location_name: Optional[str] = None

class MediaBase(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str
    file_size_bytes: Optional[int] = None

# API Request Payloads
class ReportCreate(BaseModel):
    device_hash: str
    client_report_id: Optional[str] = None
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = None
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: LocationBase
    media: Optional[List[MediaBase]] = []
    expected_media: Optional[int] = 0  # How many media files client intends to send

# Lightweight metadata-only payload (Stage 1 — tiny, instant)
class ReportMetaCreate(BaseModel):
    device_hash: str
    client_report_id: str
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = None
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: Optional[LocationBase] = None
    expected_media: int = 0  # photo + audio = 2, photo only = 1, etc.

# Single media attachment (Stage 2/3 — one file at a time)
class MediaAttach(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str  # base64 data URL
    file_size_bytes: Optional[int] = None

class MediaUpload(BaseModel):
    report_id: str
    media_data: MediaBase  # For progressive upload sync

# API Response Payloads
class LocationResponse(LocationBase):
    id: str
    model_config = ConfigDict(from_attributes=True)

class MediaResponse(MediaBase):
    id: str
    is_synced: bool
    model_config = ConfigDict(from_attributes=True)

class AIAnalysisResponse(BaseModel):
    id: str
    damage_score: Optional[float] = None
    ai_severity: Optional[SeverityEnum] = None
    transcription: Optional[str] = None
    detected_labels: Optional[List[Any]] = []
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def model_validate(cls, obj, *args, **kwargs):
        # Coerce None detected_labels (stored as NULL in older DB rows) to []
        if hasattr(obj, 'detected_labels') and obj.detected_labels is None:
            obj.detected_labels = []
        return super().model_validate(obj, *args, **kwargs)

class ReportResponse(BaseModel):
    id: str
    client_report_id: Optional[str] = None
    device_id: str
    source: SourceEnum
    status: ReportStatusEnum
    sync_status: SyncStatusEnum
    severity: SeverityEnum
    infrastructure_type: InfraTypeEnum
    description: Optional[str] = None
    is_auto_submitted: bool = False
    expected_media: int = 0
    received_media: int = 0
    server_created_at: datetime
    location: Optional[LocationResponse] = None
    media: List[MediaResponse] = []
    ai_analysis: Optional[AIAnalysisResponse] = None

    model_config = ConfigDict(from_attributes=True)

class ClusterResponse(BaseModel):
    id: str
    center_lat: float
    center_lng: float
    radius_meters: float
    confidence_score: float
    status: ClusterStatusEnum
    primary_infrastructure_type: Optional[InfraTypeEnum] = None
    
    model_config = ConfigDict(from_attributes=True)
