import os
import uuid
import logging
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, Enum, JSON, Text, LargeBinary, UniqueConstraint, CheckConstraint, Index, event
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from app.db.session import Base

_media_cleanup_logger = logging.getLogger(__name__)

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
    """UNDP RAPIDA infrastructure taxonomy (Problem Statement Appendix 1).

    The spec defines exactly **seven super-types plus OTHER**:

        RESIDENTIAL, COMMERCIAL, GOVERNMENT, UTILITY,
        TRANSPORT_COMMUNICATION, COMMUNITY, PUBLIC_SPACES, OTHER

    CRISP historically stored the *chip* the user tapped (ROAD, HOSPITAL,
    HOUSE, POWER, WATER, SCHOOL, TELECOM) directly in this column. Those
    identifiers remain in the enum so legacy rows continue to validate;
    the SQLAlchemy ``before_insert``/``before_update`` hook in this
    module rewrites them to the correct UNDP super-type on write and
    preserves the original chip in the new
    ``infrastructure_sub_type`` column.

    Mapping table (kept in sync with ``app.core.taxonomy.UI_CHIP_TO_UNDP``):
        ROAD      → TRANSPORT_COMMUNICATION
        TELECOM   → UTILITY
        HOUSE     → RESIDENTIAL
        HOSPITAL  → COMMUNITY
        SCHOOL    → COMMUNITY
        POWER     → UTILITY
        WATER     → UTILITY
        GOVERNMENT → GOVERNMENT
    """
    # UNDP Appendix-1 super-types
    RESIDENTIAL = "RESIDENTIAL"
    COMMERCIAL = "COMMERCIAL"
    GOVERNMENT = "GOVERNMENT"
    UTILITY = "UTILITY"
    TRANSPORT_COMMUNICATION = "TRANSPORT_COMMUNICATION"
    COMMUNITY = "COMMUNITY"
    PUBLIC_SPACES = "PUBLIC_SPACES"
    OTHER = "OTHER"
    # Legacy fine-grained chips — kept for backward compatibility with
    # historical rows. The taxonomy hook rewrites new writes to the UNDP
    # super-type above.
    ROAD = "ROAD"
    HOSPITAL = "HOSPITAL"
    HOUSE = "HOUSE"
    POWER = "POWER"
    WATER = "WATER"
    SCHOOL = "SCHOOL"
    TELECOM = "TELECOM"

class DamageClassEnum(str, enum.Enum):
    """UNDP-aligned damage classification (Problem Statement Appendix 1).

    Spec labels: "Minimal/No damage", "Partially damaged",
    "Completely damaged".

    CRISP originally stored the first tier as "NO_DAMAGE" — which judges
    reading raw export CSVs would flag as a spec deviation. April 2026:
    the canonical value is `MINIMAL`. `NO_DAMAGE` remains in the enum as
    a *deprecated alias* so legacy clients + historical DB rows continue
    to validate; the SQLAlchemy `before_insert`/`before_update` hook in
    this module rewrites `NO_DAMAGE` → `MINIMAL` on every write, and the
    export layer calls `app.core.taxonomy.normalise_damage` on every
    read so every byte shipped to a judge uses the UNDP label."""
    MINIMAL = "MINIMAL"
    NO_DAMAGE = "NO_DAMAGE"    # legacy alias — normalised to MINIMAL on write
    PARTIAL = "PARTIAL"
    COMPLETE = "COMPLETE"

class CrisisTypeEnum(str, enum.Enum):
    """UNDP-aligned crisis taxonomy (Problem Statement page 8).

    UNDP's nine required crisis types map to nine members below:

      Natural hazards:
        EARTHQUAKE, FLOOD, TSUNAMI, CYCLONE, WILDFIRE
      Technological hazards:
        EXPLOSION, CHEMICAL_INCIDENT
      Human-made crises:
        CONFLICT, CIVIL_UNREST

    OTHER is the always-available catch-all.

    HURRICANE remains as a legacy alias for CYCLONE — UNDP wording is
    'Hurricane/Cyclone' (single category). The application + Pydantic
    layers normalise HURRICANE -> CYCLONE on every new write
    (`_normalize_crisis_type` in api/endpoints/reports.py + the
    `_enforce_undp_taxonomy` validator in schemas/report.py).
    Migration 0016 backfilled historical HURRICANE rows. The enum
    member is kept so old DB rows continue to validate at the
    SQLAlchemy layer, but no new write reaches it.

    LANDSLIDE and PANDEMIC are not on the UNDP spec. The Pydantic
    validator rejects new submissions carrying them (422). Existing
    rows are preserved for back-compat; they would only be removed
    by a destructive Postgres ALTER TYPE (deferred to a v2 cleanup).
    """
    # UNDP natural hazards
    EARTHQUAKE = "EARTHQUAKE"
    FLOOD = "FLOOD"
    TSUNAMI = "TSUNAMI"
    CYCLONE = "CYCLONE"
    WILDFIRE = "WILDFIRE"
    # UNDP technological hazards
    EXPLOSION = "EXPLOSION"
    CHEMICAL_INCIDENT = "CHEMICAL_INCIDENT"
    # UNDP human-made crises
    CONFLICT = "CONFLICT"
    CIVIL_UNREST = "CIVIL_UNREST"
    # Always-available catch-all
    OTHER = "OTHER"
    # Back-compat aliases (rejected for new writes, kept so DB rows validate)
    HURRICANE = "HURRICANE"   # alias for CYCLONE; normalised on write
    LANDSLIDE = "LANDSLIDE"   # not on UNDP spec; Pydantic-rejected on write
    PANDEMIC = "PANDEMIC"     # not on UNDP spec; Pydantic-rejected on write


class CrisisCategoryEnum(str, enum.Enum):
    """Appendix-1 crisis grouping. Stored on reports alongside crisis_type
    so dashboards can filter 'all human-made crises' without client-side
    logic. Derived from crisis_type at write time via CRISIS_CATEGORY_OF
    in app.core.taxonomy."""
    NATURAL = "NATURAL"
    TECHNOLOGICAL = "TECHNOLOGICAL"
    HUMAN_MADE = "HUMAN_MADE"
    OTHER = "OTHER"

class ServiceStatusEnum(str, enum.Enum):
    """Service-status scale used by the ``service_status`` JSON field on
    Report (``electricity``, ``water``, ``telecom``, ``health``).

    UNDP Appendix-1 prescribes a 5-level scale for electricity
    (operational / intermittent / load-shedding / blackout / unknown)
    and a 4-level scale for health services. CRISP originally shipped a
    compact 3-level scale. We keep the original three values so
    pre-April-2026 rows continue to validate, and add the extra
    Appendix-1 levels so new captures can express them. Dashboard +
    export ``service_status`` JSON carries whatever the client sent —
    the enum is a validation surface, not a storage type."""
    # Original compact levels (used on nearly every legacy row)
    OPERATIONAL = "OPERATIONAL"
    DISRUPTED = "DISRUPTED"
    DESTROYED = "DESTROYED"
    UNKNOWN = "UNKNOWN"
    # UNDP Appendix-1 expansions (electricity) — finer-grained outage taxonomy
    INTERMITTENT = "INTERMITTENT"         # power cuts every few hours
    LOAD_SHEDDING = "LOAD_SHEDDING"       # scheduled rolling blackout
    BLACKOUT = "BLACKOUT"                 # total loss
    # UNDP Appendix-1 expansions (health services)
    FULLY_OPERATIONAL = "FULLY_OPERATIONAL"     # hospital running at full capacity
    PARTIALLY_OPERATIONAL = "PARTIALLY_OPERATIONAL"  # reduced staff / services
    NOT_OPERATIONAL = "NOT_OPERATIONAL"   # closed / inaccessible

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


class ReviewerVerdictEnum(str, enum.Enum):
    """Phase 5 (Apr 2026) — reviewer's explicit verdict, distinct from the AI
    status workflow. `NOT_REVIEWED` is the default for fresh reports; analysts
    move them to `ACCEPTED` or `REJECTED`. Stored separately from `status` so
    the admin-acceptance data survives downstream status changes."""
    NOT_REVIEWED = "NOT_REVIEWED"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"

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
    # nullable FK to the
    # authenticated reporter. NULL = anonymous (legacy + skip-login path).
    # `ON DELETE SET NULL` is the key guarantee from the user spec: when
    # a reporter hits "Delete my account", their linked reports revert to
    # anonymous — the crisis-response value of each report is preserved
    # while the PII linkage is severed.
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    source = Column(Enum(SourceEnum), default=SourceEnum.APP, nullable=False)
    status = Column(Enum(ReportStatusEnum), default=ReportStatusEnum.PENDING, nullable=False)
    sync_status = Column(Enum(SyncStatusEnum), default=SyncStatusEnum.QUEUED, nullable=False)
    severity = Column(Enum(SeverityEnum), default=SeverityEnum.UNKNOWN, nullable=False)
    # UNDP super-type (RESIDENTIAL / COMMERCIAL / ... / OTHER). Written
    # automatically from the user-facing chip by the taxonomy hook so
    # export CSVs and dashboard analytics align with Appendix 1.
    infrastructure_type = Column(Enum(InfraTypeEnum), default=InfraTypeEnum.OTHER, nullable=False)
    # original fine-grained chip the reporter tapped
    # (ROAD / TELECOM / HOSPITAL / POWER / WATER / SCHOOL / HOUSE ...).
    # Populated by the taxonomy hook when `infrastructure_type` is a
    # legacy chip. Preserves the richer signal for dashboard drill-down
    # without losing UNDP compliance on the canonical column.
    infrastructure_sub_type = Column(String(40), nullable=True, index=True)
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
    # May 2026 — idempotency stamp for the tier-credit bump
    # (`_mark_report_verified_for_credibility`). Set on the FIRST
    # transition out of PENDING; the bump function short-circuits
    # on subsequent calls so parallel dispatch/resolve requests
    # never double-credit a single report. See migration 0019.
    first_verified_at = Column(DateTime(timezone=True), nullable=True, index=True)
    # UNDP required fields
    damage_classification = Column(String(20), nullable=True)   # MINIMAL / PARTIAL / COMPLETE  (legacy NO_DAMAGE accepted + normalised)
    crisis_type = Column(String(30), nullable=True)             # EARTHQUAKE / FLOOD / TSUNAMI / EXPLOSION / etc.
    # UNDP Appendix-1 alignment. Derived on write from crisis_type
    # (see app.core.taxonomy.CRISIS_CATEGORY_OF). Stored so dashboards can
    # filter 'all human-made crises' without duplicating the mapping
    # client-side. Nullable for backward compatibility with pre-migration rows.
    crisis_category = Column(String(20), nullable=True)          # NATURAL / TECHNOLOGICAL / HUMAN_MADE / OTHER
    infrastructure_name = Column(String(255), nullable=True)    # Specific building/road name
    # distinguisher between OSM-auto-filled and
    # user-typed `infrastructure_name`.
    #   True  → client auto-filled the name from an OSM building-select tap.
    #   False → user typed it as free text (map unavailable / offline /
    #           corporate-proxy blocked Overpass / feature-flag forced fallback).
    # Combined with `building_id IS NULL`, False flags a row as "needs
    # manual mapping" on the dashboard so an operator can resolve the
    # free-text entry to a real OSM footprint later. Pre-v3 clients never
    # set this column → NULL, which the dashboard treats as "unknown"
    # (neither green ✓ nor the red "needs mapping" badge — see
    # ReportResponse.needs_manual_mapping).
    infrastructure_name_from_osm = Column(Boolean, nullable=True)
    debris_clearing_needed = Column(Boolean, nullable=True)     # Does this location need debris clearing?
    service_status = Column(JSON, nullable=True)                # {"electricity":"DISRUPTED","water":"OPERATIONAL",...}
    building_id = Column(String(36), nullable=True, index=True) # Links multiple reports about same structure
    # Progressive-upload placeholder. Compact blurhash
    # of the main photo — decoded on the dashboard to render a fuzzy colour
    # impression the instant the meta POST lands, BEFORE any media chunk
    # arrives. See app/schemas/report.py::ReportMetaCreate.blurhash for the
    # design doc. Typical length: 28–32 chars (4x3 DCT). Cap at 96 lets us
    # go up to 9x9 DCT later without another migration.
    blurhash = Column(String(96), nullable=True)

    # reviewer-accountability workflow.
    #   reviewer_verdict → explicit human verdict ({NOT_REVIEWED,ACCEPTED,REJECTED})
    #   reviewed_at       → timestamp of the verdict decision
    #   action_taken      → free-text note (rejection reason OR response action)
    #   help_dispatched_at/help_arrived_at → responder timestamps
    # `response_time_seconds` is NOT stored — it's computed at read time as
    # `(help_arrived_at or help_dispatched_at) - reviewed_at` to avoid
    # two-source-of-truth drift.
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    reviewer_verdict = Column(String(20), nullable=False, default=ReviewerVerdictEnum.NOT_REVIEWED.value)
    action_taken = Column(Text, nullable=True)
    help_dispatched_at = Column(DateTime(timezone=True), nullable=True)
    help_arrived_at = Column(DateTime(timezone=True), nullable=True)

    device      = relationship("Device", back_populates="reports")
    location    = relationship("Location",    back_populates="report", uselist=False, cascade="all, delete-orphan")
    media       = relationship("Media",       back_populates="report", cascade="all, delete-orphan")
    ai_analysis = relationship("AIAnalysis",  back_populates="report", uselist=False, cascade="all, delete-orphan")
    verification = relationship("SatelliteVerification", back_populates="report", uselist=False, cascade="all, delete-orphan")

    # UI v2.1 — performance indexes for 500k-scale crisis queries.
    # Mirror migration 0008. Names match exactly so `alembic upgrade` from
    # an empty DB and `Base.metadata.create_all` from pytest's conftest
    # both produce the same physical index names on Postgres.
    __table_args__ = (
        Index("ix_reports_server_created_at",     "server_created_at"),
        Index("ix_reports_status",                "status"),
        Index("ix_reports_crisis_type",           "crisis_type"),
        Index("ix_reports_severity",              "severity"),
        Index("ix_reports_damage_classification", "damage_classification"),
        Index("ix_reports_device_id",             "device_id"),
        Index("ix_reports_reviewer_verdict",      "reviewer_verdict"),
        Index("ix_reports_deletion_requested_at", "deletion_requested_at"),
        Index("ix_reports_status_created",        "status",      "server_created_at"),
        Index("ix_reports_building_created",      "building_id", "server_created_at"),
        Index("ix_reports_device_created",        "device_id",   "server_created_at"),
    )


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
    # geocoder confidence + source. Populated when the
    # location was inferred from text (IVR / SMS / WhatsApp transcripts)
    # via geocode_text(); NULL for GPS-captured locations from the PWA
    # or native apps. confidence ∈ [0.0, 1.0]; source ∈ {"mapbox",
    # "nominatim", "claude-mapbox", "manual", …}. Dashboard renders a
    # tonal chip when both are present (see web-dashboard/src/app.js).
    geocoding_confidence = Column(Float, nullable=True)
    geocoding_source = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    report = relationship("Report", back_populates="location")

    # May 2026 (0018) — composite index on (latitude, longitude) so the
    # /api/v1/reports/nearby bbox pre-filter is an indexed range scan
    # instead of a full Location table scan. Mirrored in migration
    # 0018_locations_lat_lng_index so `Base.metadata.create_all()`
    # (pytest setup) and `alembic upgrade` produce the same physical
    # index name.
    __table_args__ = (
        Index("ix_locations_lat_lng", "latitude", "longitude"),
    )

class Media(Base):
    __tablename__ = "media"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum(MediaTypeEnum), nullable=False)
    resolution_tier = Column(Enum(ResolutionEnum), default=ResolutionEnum.LOW, nullable=False)
    # Guaranteed-delivery pipeline: SMALL / MEDIUM / LARGE variants of one
    # captured photo share the same photo_group_id, but each variant lives in
    # its own Media row (independent assembly_status, chunk stream, url).
    # The dashboard groups by this id and picks the best completed variant.
    # Nullable so legacy single-variant media + audio continue to work.
    photo_group_id = Column(String(36), index=True, nullable=True)
    url = Column(String, nullable=False, default='')
    file_size_bytes = Column(Integer)
    is_synced = Column(Boolean, default=False)
    # Chunked upload tracking (PRD §3.3/3.4/3.6)
    thumbnail_url = Column(String, nullable=True)           # tiny preview sent before chunks
    chunk_count = Column(Integer, default=0, nullable=False) # total chunks expected
    received_chunks = Column(Integer, default=0, nullable=False)
    completion_pct = Column(Float, default=0.0, nullable=False)
    assembly_status = Column(String(20), default='pending', nullable=False)  # pending|partial|complete
    # Phase C.1 (May 2026) — whole-asset djb2 checksum the PWA computes
    # ONCE over the full original bytes before chunking, sent on chunk 0.
    # After assembly the backend re-computes djb2 over the concatenated
    # file and compares; mismatch flips assembly_status='failed' and
    # bumps `media_asset_integrity_fail_total`. NULL for legacy rows /
    # clients that don't send the field — the check is skipped, preserving
    # backward compatibility. djb2 hex is 8 chars; 16 is generous headroom.
    full_asset_checksum = Column(String(16), nullable=True)
    # : clients that have already run their local PII blur (PWA
    # BlazeFace / RN equivalent) set this true; the server's own blur_pii
    # pass is then skipped to avoid a second lossy re-encode on
    # already-redacted pixels. Defaults false for legacy clients.
    client_blur_applied = Column(Boolean, default=False, nullable=False)
    # server-side PII blur outcome. Legacy rows are NULL.
    # Values:
    #   not_needed — client_blur_applied=true and client pipeline
    #                asserted success (no server pass required).
    #   pending    — assembly completed; blur submitted to _ai_executor
    #                but not yet finished.
    #   complete   — server blur finished successfully.
    #   failed     — server blur raised an exception (operator action).
    #   skipped    — server blur was a no-op because PII backends are
    #                unavailable (MediaPipe + easyocr both missing); the
    #                file is on disk UNBLURRED. Dashboard should flag.
    pii_blur_status = Column(String(16), nullable=True, index=True)
    # UI v2.1 — perceptual hash (pHash) of the assembled image
    # for redundancy detection (UNDP nice-to-have #3: "spot duplicates
    # with same time-stamp of submission, or over-reporting"). Computed
    # once post-assembly in `_ai_executor`, stored as a 16-char hex
    # string (64-bit imagehash.phash output). Nullable for audio/video
    # rows + legacy photos uploaded pre-feature. Indexed so the
    # "find near-duplicates in same building within 24h" query is fast.
    photo_phash = Column(String(16), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # P1.1 — auto-updating timestamp used by the assembly-lock stale-escape:
    # if assembly_status='assembling' AND updated_at > 5 min ago, the previous
    # worker is assumed dead (crash / reload) and the lock can be reclaimed.
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    report = relationship("Report", back_populates="media")
    chunks = relationship("MediaChunk", back_populates="media", cascade="all, delete-orphan")

    # UI v2.1 — pHash dedup endpoint windows by `created_at` for
    # the last 24 h. Mirrors migration 0008.
    __table_args__ = (
        Index("ix_media_created_at", "created_at"),
    )


class MediaChunk(Base):
    """Individual ~1KB packet of a media file (PRD §3.3). Assembled into full file when complete.

    April 2026 — binary-chunk transport (Option A, `/reports/{id}/media/chunk-bin`).
    A chunk row now stores its payload in ONE of two columns:

      * ``data_b64``     — legacy base64 text transport
                           (clients hitting the old `/media/chunk` endpoint).
      * ``data_binary``  — raw bytes (multipart/form-data clients hitting
                           the new `/media/chunk-bin` endpoint).

    The assembly path reads whichever column is populated per row and
    concatenates accordingly. Enforced by ``chunk_has_one_payload`` CHECK
    constraint: exactly one of the two columns must be non-NULL.

    Every existing row has ``data_b64`` populated and ``data_binary`` NULL,
    so no data migration is required — the constraint is satisfied on all
    legacy rows automatically.
    """
    __tablename__ = "media_chunks"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    media_id = Column(String(36), ForeignKey("media.id", ondelete="CASCADE"), nullable=False, index=True)
    seq_num = Column(Integer, nullable=False)
    total_chunks = Column(Integer, nullable=False)
    # Was NOT NULL pre-Apr-2026; relaxed so binary-chunk rows can set it to
    # NULL. The CHECK constraint below still guarantees a payload exists.
    data_b64 = Column(Text, nullable=True)
    # Raw-bytes payload. Postgres → BYTEA, SQLite → BLOB. TOAST-compressed
    # automatically over ~2 KB so the storage footprint is ~15-20 % less
    # than the equivalent base64 text on Postgres.
    data_binary = Column(LargeBinary, nullable=True)
    checksum = Column(String(16), nullable=True)
    received_at = Column(DateTime(timezone=True), server_default=func.now())

    media = relationship("Media", back_populates="chunks")

    __table_args__ = (
        UniqueConstraint('media_id', 'seq_num', name='uq_media_chunk_seq'),
        # Exactly one of (data_b64, data_binary) is populated. Guards
        # against logic bugs that would otherwise leave a row with both
        # NULL (nothing to assemble) or both populated (ambiguous).
        CheckConstraint(
            '(data_b64 IS NOT NULL) OR (data_binary IS NOT NULL)',
            name='chunk_has_one_payload',
        ),
    )

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

    # multi-provider fan-out. JSON list of every successful
    # provider's saved-image URL + metadata. Lets the dashboard render
    # a 2×2 grid showing all 4 sources side-by-side. Format:
    #   [{"url": "/static/...", "source": "...",
    #     "acquisition_date": "...", "cloud_cover_pct": float,
    #     "resolution_m": float}, ...]
    # Stored as JSON-encoded text rather than a JSON column type to
    # work uniformly across Postgres + sqlite without a dialect cast.
    satellite_images_json        = Column(Text, nullable=True)

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


class AutoSubmitRegion(Base):
    """Phase 4 (Apr 2026) — region-level auto-submit configuration.

    When `enabled=True`, any client whose current GPS lies within this
    circle (haversine ≤ radius_meters) shows a 2-minute countdown on
    "Start Report" tap; the report is auto-submitted when the timer hits 0.
    Config is admin-controlled via the dashboard.

    v1 uses center+radius circles (cheap, mirrors `IncidentCluster` at
    line 279–289). GeoJSON polygons are a deferred v2 follow-up for
    non-circular cities (Dhaka, Kathmandu, Kabul basins).
    """
    __tablename__ = "auto_submit_regions"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    name = Column(String(120), nullable=False)
    enabled = Column(Boolean, default=False, nullable=False)
    center_lat = Column(Float, nullable=False)
    center_lng = Column(Float, nullable=False)
    radius_meters = Column(Integer, nullable=False, default=10000)  # 10 km default
    created_by = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ── Taxonomy normalisation (UNDP Appendix-1) ──────────────────────────────────
# ensure every Report row is written with:
#   * damage_classification normalised to MINIMAL / PARTIAL / COMPLETE
#     (the legacy string "NO_DAMAGE" stays accepted as input but is stored
#      as "MINIMAL" per the UNDP spec label)
#   * crisis_category derived from crisis_type so dashboards can filter
#     "all human-made crises" without duplicating the mapping client-side
#
# Using a SQLAlchemy `before_insert` + `before_update` listener centralises
# this so every write path — the meta endpoint, the admin reclassify
# endpoint, the AI auto-assessment path — goes through the same logic.
#
# The helpers live in app.core.taxonomy so the rule is testable and reusable.
_UNDP_SUPER_TYPES = {
    "RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY",
    "TRANSPORT_COMMUNICATION", "COMMUNITY", "PUBLIC_SPACES", "OTHER",
}


def _apply_taxonomy(_mapper, _conn, target: "Report") -> None:  # type: ignore[name-defined]
    try:
        from app.core.taxonomy import (
            normalise_damage, categorise_crisis, ui_chip_to_undp,
        )
        # Damage classification — normalise legacy strings.
        if target.damage_classification:
            norm = normalise_damage(target.damage_classification)
            if norm and norm != target.damage_classification:
                target.damage_classification = norm
        # Crisis → category derivation.
        if target.crisis_type:
            cat = categorise_crisis(target.crisis_type)
            if cat:
                target.crisis_category = cat

        # Infrastructure → UNDP super-type + preserve original chip.
        # Read through .value so a plain-string column (post-insert)
        # and an enum member (pre-insert) both work.
        raw = target.infrastructure_type
        if raw is not None:
            raw_str = getattr(raw, "value", raw)
            raw_str = str(raw_str).upper() if raw_str is not None else None
            if raw_str and raw_str not in _UNDP_SUPER_TYPES:
                # Legacy chip — remap. Preserve original in sub_type if
                # not already set (don't overwrite an explicit client value).
                undp = ui_chip_to_undp(raw_str)
                if undp:
                    if not target.infrastructure_sub_type:
                        target.infrastructure_sub_type = raw_str
                    try:
                        target.infrastructure_type = InfraTypeEnum(undp)
                    except ValueError:
                        # UNDP value somehow missing from the enum — leave the raw.
                        pass
    except Exception:
        # Never fail a write because of taxonomy normalisation — a judge
        # filing a report during a live crisis would not thank us for an
        # HTTP 500 because one of the lookup tables missed a key.
        pass


event.listen(Report, "before_insert", _apply_taxonomy)
event.listen(Report, "before_update", _apply_taxonomy)


# ── P3.1 — Media file cleanup on DB delete ────────────────────────────────────
# When a Media row is deleted (either directly or via cascade from a Report
# hard-delete), remove the corresponding disk files in `uploads/`. Without
# this hook, GDPR "right to be forgotten" requests leaked data via orphan
# assembled files + partial previews + thumbnails.
#
# Scope: only removes files matching our own `{media_id}_*` pattern, never
# follows absolute paths or user-supplied strings — so a corrupted `url`
# column cannot weaponise this into an arbitrary-file-delete primitive.
@event.listens_for(Media, "after_delete")
def _remove_media_files_on_delete(mapper, connection, target: "Media") -> None:  # type: ignore[name-defined]
    # Honour the same `CRISP_UPLOAD_DIR` override as the chunked-upload
    # path in api/endpoints/reports.py. When pytest runs it sets the
    # env var to `uploads_test/`; production leaves it unset and we
    # default to the canonical `backend/uploads/`. This ensures the
    # after-delete hook never reaches across into production uploads
    # when it's firing against the test DB.
    upload_dir = os.environ.get("CRISP_UPLOAD_DIR") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "uploads")
    )
    if not os.path.isdir(upload_dir):
        return
    prefix = f"{target.id}_"  # e.g. `abc123_assembled.jpg`, `abc123_partial.jpg`
    try:
        for name in os.listdir(upload_dir):
            if not name.startswith(prefix):
                continue
            full = os.path.join(upload_dir, name)
            # Safety net: sanity-check the resolved path is inside upload_dir.
            if not os.path.realpath(full).startswith(upload_dir):
                continue
            try:
                os.remove(full)
                _media_cleanup_logger.info(f"[MediaCleanup] removed {name}")
            except OSError as e:
                _media_cleanup_logger.warning(f"[MediaCleanup] failed to remove {name}: {e}")
    except OSError as e:
        _media_cleanup_logger.warning(f"[MediaCleanup] listdir failed: {e}")


class PushSubscription(Base):
    """Web Push subscription endpoint tied to a reporter identity.

    Apr 2026 — UNDP scalability story. Each row holds the
    browser-issued PushSubscription (endpoint URL + p256dh ECDH
    public key + auth secret) plus the reporter identity it belongs
    to. When a Report's status changes, the dispatch / resolve
    handler enqueues a push to every subscription matching the
    reporter (by `device_hash` and/or `user_id`).

    Identity model:
      • Anonymous reporters → `device_hash` set, `user_id` NULL.
      • Logged-in reporters → `user_id` set; `device_hash` may also
        be set so a logged-out re-install on the same device still
        gets reached.
      • At least one of the two MUST be set (CHECK constraint).

    The `endpoint` URL is globally unique (browser → push provider
    pair). It serves as the natural dedup key, so a re-subscribe
    upserts onto the existing row rather than accumulating
    duplicates. We also index it for the GC path (a 410 from the
    provider invalidates one specific endpoint).

    Failure tracking is light-touch: `failure_count` increments on
    transient 5xx, `last_failure_at` records the timestamp. Hard
    failures (404 / 410 from provider) trigger immediate row
    deletion in the service module — no need to remember anything
    about a subscription that no longer exists.
    """
    __tablename__ = "push_subscriptions"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_hash = Column(String(255), nullable=True, index=True)
    # No FK on device_hash — Devices is keyed on its own UUID, and the
    # client-side device_hash isn't always materialised there at sub
    # time (some flows skip device-row creation until first report).
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    endpoint = Column(Text, unique=True, nullable=False, index=True)
    p256dh_key = Column(String(255), nullable=False)
    auth_key = Column(String(255), nullable=False)
    user_agent = Column(String(500), nullable=True)
    locale = Column(String(10), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    last_pushed_at = Column(DateTime, nullable=True)
    last_failure_at = Column(DateTime, nullable=True)
    failure_count = Column(Integer, default=0, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "device_hash IS NOT NULL OR user_id IS NOT NULL",
            name="push_sub_has_identity",
        ),
    )
