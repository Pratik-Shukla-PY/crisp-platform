from datetime import datetime, timezone as _dt_timezone
from typing import List, Optional, Any
from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator
from app.models.report import (
    SourceEnum, SeverityEnum, InfraTypeEnum, MediaTypeEnum,
    ResolutionEnum, SyncStatusEnum, ReportStatusEnum, ClusterStatusEnum,
    DamageClassEnum, CrisisTypeEnum, ServiceStatusEnum
)


# P2.9 — All backend datetimes are UTC (see models: DateTime(timezone=True) on
# every column). SQLite, however, round-trips them as naive. Pydantic's
# default ISO serialization then emits "2026-04-18T10:00:00" without a Z,
# and browsers parse that as LOCAL time — dashboards see reports off by
# hours. This helper stamps naive datetimes as UTC before they leave the
# backend, guaranteeing every wire value ends in Z. tz-aware values pass
# through unchanged (covering Postgres + future migrations).
def _utc_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt_timezone.utc)
    # isoformat always includes the offset when tz-aware; normalize to `Z`.
    s = dt.astimezone(_dt_timezone.utc).isoformat()
    return s.replace("+00:00", "Z")

# Shared Properties
class LocationBase(BaseModel):
    latitude: float
    longitude: float
    device_latitude: Optional[float] = None
    device_longitude: Optional[float] = None
    accuracy_meters: Optional[float] = None
    is_user_corrected: Optional[bool] = False
    user_location_name: Optional[str] = None
    device_location_name: Optional[str] = None

class MediaBase(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str
    file_size_bytes: Optional[int] = None

# Chunked upload: tiny thumbnail sent before chunks (PRD §3.4)
class ThumbnailPayload(BaseModel):
    media_id: str
    thumbnail_data: str  # full data:image/jpeg;base64,... URL (≤20KB)

# Chunked upload: adaptive packets 1KB-512KB (network-aware)
class MediaChunkPayload(BaseModel):
    media_id: str
    type: MediaTypeEnum
    seq_num: int = Field(..., ge=0, le=10_000)
    # P1.7 — cap total_chunks at 10,000. At 512 KB max per chunk that allows
    # a ~5 GB upload; well beyond any legitimate mobile capture. Previously
    # an attacker could submit total_chunks=999_999_999 to force premature
    # assembly after one chunk or exhaust DB storage with empty MediaChunk
    # rows.
    total_chunks: int = Field(..., ge=1, le=10_000)
    data: str = Field(..., max_length=1048576)  # max 1MB chars (512KB base64 + overhead)
    checksum: Optional[str] = None  # djb2 hex for integrity (PRD §3.7)
    # Guaranteed-delivery pipeline. The client tags each chunk with which
    # variant it's building (SMALL=LOW, MEDIUM=MEDIUM, LARGE=HIGH) and a
    # shared photo_group_id linking the three variants of one captured photo.
    # Both default such that legacy single-variant clients keep working
    # (the chunk handler used to hard-code `MEDIUM` on new media rows — we
    # drop that hard-coding and trust this field instead).
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    photo_group_id: Optional[str] = Field(None, max_length=36)
    # Apr 2026: when `true`, the client has already run its PII blur (face
    # redaction via BlazeFace on PWA / similar on RN) against the original
    # image before chunking. The server-side blur_pii() pass is then skipped
    # on assembly — avoiding a second lossy pass over already-redacted bytes.
    # Default false so legacy clients continue to get server-side blur.
    client_blur_applied: bool = False

# API Request Payloads
class ReportCreate(BaseModel):
    device_hash: str = Field(..., max_length=255)
    client_report_id: Optional[str] = Field(None, max_length=64)
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = Field(None, max_length=5000)
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: LocationBase
    media: Optional[List[MediaBase]] = []
    expected_media: Optional[int] = 0
    # UNDP required fields
    damage_classification: Optional[str] = None
    crisis_type: Optional[str] = None
    infrastructure_name: Optional[str] = Field(None, max_length=255)
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None

# Lightweight metadata-only payload (Stage 1 — tiny, instant)
class ReportMetaCreate(BaseModel):
    device_hash: str = Field(..., max_length=255)
    client_report_id: str = Field(..., max_length=64)
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = Field(None, max_length=5000)
    caller_info: Optional[Any] = None
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: Optional[LocationBase] = None
    expected_media: int = Field(0, ge=0, le=50)
    # UNDP required fields — P2.10 validation: accept only canonical enum
    # values. Clients that still send stringly-typed legacy values get a clear
    # 422 now instead of silently writing garbage to the DB.
    damage_classification: Optional[DamageClassEnum] = None
    crisis_type: Optional[CrisisTypeEnum] = None
    infrastructure_name: Optional[str] = Field(None, max_length=255)
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None
    # Building-footprint selection (UNDP Appendix). Client submits the
    # composite OSM identifier it rendered from (e.g. ``osm:way:123456``)
    # — the auto-assign logic in `_auto_assign_building_id` runs first
    # but an explicit pick overrides the coarse match.
    building_id: Optional[str] = Field(None, max_length=64)
    # Phase 1 progressive-upload stack (Apr 2026). Blurhash encodes a
    # ~4x3 DCT of the main photo into a short string (~25-35 chars); the
    # dashboard decodes it into a blurred colour impression and renders
    # it as a placeholder the instant the meta POST lands, BEFORE any
    # media chunk arrives. Closes the "time-to-first-visual" gap from
    # ~2 s (first SMALL chunk) down to ~200 ms (meta RTT). The string is
    # tiny enough to fit comfortably in the meta body even on a 2 Kbps
    # link (25 bytes ≈ 100 ms at 2 Kbps).
    # Length cap is generous — blurhash can go up to ~9x9 DCT (≈ 83
    # chars) but our encoder uses 4x3, which yields ~30 chars.
    blurhash: Optional[str] = Field(None, max_length=96)

# Single media attachment (Stage 2/3 — one file at a time)
class MediaAttach(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str  # base64 data URL
    file_size_bytes: Optional[int] = None

class MediaUpload(BaseModel):
    report_id: str
    media_data: MediaBase  # For progressive upload sync

# Single text update (Stage 2 — description/transcript)
class ReportDescriptionUpdate(BaseModel):
    description: str

# API Response Payloads
class LocationResponse(LocationBase):
    id: str
    model_config = ConfigDict(from_attributes=True)

class MediaResponse(MediaBase):
    id: str
    is_synced: bool
    thumbnail_url: Optional[str] = None
    completion_pct: float = 0.0
    assembly_status: str = 'pending'
    # Guaranteed-delivery: dashboard groups media by this id and picks the
    # best-available complete variant (LARGE > MEDIUM > SMALL > partial).
    photo_group_id: Optional[str] = None
    # Apr 2026 — server-side PII-blur outcome. Dashboard MUST warn/flag
    # any row where this is 'skipped' or 'failed' — the file is on disk
    # and may contain unredacted PII. 'not_needed' = client handled it,
    # 'complete' = server-side pass succeeded, 'pending' = blur
    # in flight, NULL = legacy row (pre-tracking).
    pii_blur_status: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

class AIAnalysisResponse(BaseModel):
    id: str
    damage_score: Optional[float] = None
    ai_severity: Optional[SeverityEnum] = None
    transcription: Optional[str] = None
    ai_summary: Optional[str] = None
    detected_labels: Optional[List[Any]] = []
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def model_validate(cls, obj, *args, **kwargs):
        # Coerce None detected_labels (stored as NULL in older DB rows) to []
        if hasattr(obj, 'detected_labels') and obj.detected_labels is None:
            obj.detected_labels = []
        return super().model_validate(obj, *args, **kwargs)


class VerificationResponse(BaseModel):
    """Response schema for a satellite truth-verification result."""
    id: str
    report_id: str
    total_score: int = 0
    verdict: Optional[str] = None
    scores: Optional[Any] = None                      # {location_authenticity, …}
    reasoning: Optional[str] = None
    key_findings: Optional[List[str]] = []
    caveats: Optional[List[str]] = []
    satellite_scene_description: Optional[str] = None
    photo_analysis: Optional[str] = None
    satellite_source: Optional[str] = None
    satellite_acquisition_date: Optional[str] = None
    satellite_cloud_cover_pct: Optional[float] = None
    satellite_resolution_m: Optional[float] = None
    satellite_days_gap: Optional[int] = None
    satellite_image_url: Optional[str] = None
    satellite_image_url_alt: Optional[str] = None
    satellite_source_alt: Optional[str] = None
    satellite_acquisition_date_alt: Optional[str] = None
    satellite_resolution_m_alt: Optional[float] = None
    error: Optional[str] = None
    scored_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)

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
    detected_language: Optional[str] = None
    caller_info: Optional[Any] = None
    ai_assessment: Optional[Any] = None
    is_auto_submitted: bool = False
    expected_media: int = 0
    received_media: int = 0
    server_created_at: datetime
    deletion_requested_at: Optional[datetime] = None
    lives_impacted: Optional[int] = None

    @field_serializer("server_created_at", "deletion_requested_at", when_used="json")
    def _serialize_dt(self, v: Optional[datetime]) -> Optional[str]:
        # P2.9 — emit UTC-with-Z so dashboard JS `new Date(...)` parses it correctly.
        return _utc_iso(v)

    # UNDP required fields
    damage_classification: Optional[str] = None     # MINIMAL / PARTIAL / COMPLETE (UNDP-aligned)
    crisis_type: Optional[str] = None               # see CrisisTypeEnum for the full UNDP list
    crisis_category: Optional[str] = None           # NATURAL / TECHNOLOGICAL / HUMAN_MADE / OTHER
    infrastructure_sub_type: Optional[str] = None   # original UI chip (ROAD, HOSPITAL, ...) for drill-down
    infrastructure_name: Optional[str] = None
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None
    building_id: Optional[str] = None
    # Blurhash placeholder — see ReportMetaCreate.blurhash for design. The
    # dashboard renders this via the blurhash-decode path while waiting for
    # the first SMALL variant to arrive. Nullable because legacy reports
    # submitted before Phase-1 won't have one.
    blurhash: Optional[str] = None

    # Phase 5 (Apr 2026) — reviewer workflow surface.
    # `response_time_seconds` is COMPUTED at read time from
    # help_arrived_at (or help_dispatched_at) minus reviewed_at. Not stored
    # to avoid two-source-of-truth drift.
    reviewed_at: Optional[datetime] = None
    reviewer_verdict: str = "NOT_REVIEWED"
    action_taken: Optional[str] = None
    help_dispatched_at: Optional[datetime] = None
    help_arrived_at: Optional[datetime] = None
    response_time_seconds: Optional[int] = None

    @field_serializer("reviewed_at", "help_dispatched_at", "help_arrived_at", when_used="json")
    def _serialize_reviewer_dt(self, v: Optional[datetime]) -> Optional[str]:
        return _utc_iso(v)

    location: Optional[LocationResponse] = None
    media: List[MediaResponse] = []
    ai_analysis: Optional[AIAnalysisResponse] = None
    verification: Optional[VerificationResponse] = None

    model_config = ConfigDict(from_attributes=True)

    # Apr 2026: use model_validator(mode='after') — the previous
    # `model_validate` classmethod override fired on direct calls but was
    # skipped by FastAPI's list-response serialisation path (which uses a
    # TypeAdapter under the hood). `model_validator(after)` runs on EVERY
    # validated instance regardless of entry point. Caught by e2e test
    # tests/dashboard/03-reviewer-workflow.spec.ts.
    @model_validator(mode='after')
    def _compute_response_time(self):
        """Compute `response_time_seconds` from the reviewer + responder
        timestamps. Derived, not stored — avoids two-source-of-truth drift."""
        if self.reviewed_at and (self.help_arrived_at or self.help_dispatched_at):
            end = self.help_arrived_at or self.help_dispatched_at
            try:
                from datetime import timezone as _tz
                a = self.reviewed_at if self.reviewed_at.tzinfo else self.reviewed_at.replace(tzinfo=_tz.utc)
                b = end if end.tzinfo else end.replace(tzinfo=_tz.utc)
                delta = int((b - a).total_seconds())
                if delta >= 0:
                    self.response_time_seconds = delta
            except Exception:
                pass
        return self

class ClusterResponse(BaseModel):
    id: str
    center_lat: float
    center_lng: float
    radius_meters: float
    confidence_score: float
    status: ClusterStatusEnum
    primary_infrastructure_type: Optional[InfraTypeEnum] = None
    
    model_config = ConfigDict(from_attributes=True)
