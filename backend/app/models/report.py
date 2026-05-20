import os
import uuid
import logging
from sqlalchemy import Column, String, Float, Boolean, Integer, BigInteger, DateTime, ForeignKey, Enum, JSON, Text, LargeBinary, UniqueConstraint, CheckConstraint, Index, event, text
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


# Phase H.1.b (May 2026) — Building Intelligence operational states.
#
# 7-state machine (allowed transitions documented in the plan):
#   ACTIVE  → MONITORED → RESPONDING → RESOLVED
#   ACTIVE  → ESCALATED (operator-raised priority)
#   ACTIVE  → FALSE_ALARM (operator-declared misinformation)
#   * any → ARCHIVED (auto after 30d no activity OR all reports purged)
#
# Stored as String(20) on the Building row (NOT a Postgres enum) so
# adding new states later doesn't require an ALTER TYPE migration.
# Application-layer validation in the H.2 state-transition endpoint.
class BuildingStateEnum(str, enum.Enum):
    ACTIVE      = "ACTIVE"
    MONITORED   = "MONITORED"
    RESPONDING  = "RESPONDING"
    ESCALATED   = "ESCALATED"
    RESOLVED    = "RESOLVED"
    ARCHIVED    = "ARCHIVED"
    FALSE_ALARM = "FALSE_ALARM"


# Phase H.1.b — building-id provenance (mirrors migration 0028's enum).
class BuildingIdSourceEnum(str, enum.Enum):
    OSM       = "OSM"        # PWA reporter tapped an OSM footprint
    PROXIMITY = "PROXIMITY"  # Backend proximity-clustered fallback
    MANUAL    = "MANUAL"      # Operator-created via dashboard


class Device(Base):
    __tablename__ = "devices"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_hash = Column(String(255), unique=True, nullable=False)
    platform = Column(String(50))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Phase 3 (May 2026, docs §6.1 + §6.2) — trust-score signals.
    # spam_score: accumulator (synchronous bumps from hot abuse
    # signals + Phase-5 async batch worker). 0.0 = clean.
    # reports_count: total reports seen — cached integer maintained
    # synchronously on every report insert.
    # spam_signals: jsonb array of detected signal-type strings
    # ("gps_spoof" / "impossible_movement" / "rate_burst" / ...);
    # used by the dashboard's Phase-4 triage UI.
    spam_score = Column(Float, default=0.0, nullable=False, server_default="0.0")
    reports_count = Column(Integer, default=0, nullable=False, server_default="0")
    # `server_default` matches migration 0021_device_trust_columns so a
    # `Base.metadata.create_all()` (used by the migration test
    # fixtures) emits the same NOT-NULL column with a default the DB
    # itself enforces — raw INSERTs that omit `spam_signals` get the
    # empty-array default instead of a NotNullViolation. Without this,
    # the model-driven `create_all` diverges from the alembic-driven
    # `upgrade head` and any test that bypasses the SA ORM trips up.
    spam_signals = Column(
        JSON, default=list, nullable=False,
        server_default=text("'[]'::jsonb"),
    )

    # Phase 5.1 (May 2026, docs §6.2) — device telemetry summary for
    # real emulator fingerprinting. Posted by PWA / RN on app boot via
    # POST /api/v1/devices/telemetry. Nullable — devices that predate
    # the capture (or refuse it for any reason) get a NULL summary and
    # only the cheap UA-substring check applies. Stored as a SUMMARY
    # only (no raw sensor streams) so this is not PII / fingerprinting
    # data the user could be re-identified from.
    telemetry_summary = Column(JSON, nullable=True)

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
    # K.2.e (May 2026, Phase K) — surfaces "I had a Bearer token but
    # it was expired" so the dashboard chip (K.5.a) can render
    # "🔓 Attribution lost: token expired". Distinct from `user_id IS
    # NULL` which covers both genuine anonymous AND lost-attribution.
    # The reporter retains the ability to retroactively re-link via a
    # future "claim this report" admin endpoint (out of scope this
    # batch — flag only).
    submitted_as_anonymous_due_to_expired_token = Column(
        Boolean, default=False, server_default=text("false"), nullable=False
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
    # UNDP must-have #8 (Phase F.5.c, May 2026) — building versioning.
    # Reports about the same building stack up; ordinal counts entries in
    # chronological order (1-indexed, NULL for rows without a building_id),
    # building_is_latest flags the most-recent row in each partition.
    # Backfilled by migration 0027 over historical data. Maintained on
    # insert/update by the `_apply_building_versioning` SQLAlchemy hook
    # below. The dashboard renders a "Version N of M · Latest" chip from
    # these two fields. See migration 0027_building_versioning + audit
    # plan /Users/pks/.claude/plans/swirling-forging-raccoon.md F.5.c.
    building_version_ordinal = Column(Integer, nullable=True)
    building_is_latest = Column(Boolean, default=False, nullable=False, server_default="false")
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
        # F.5.c (May 2026) — UNDP must-have #8. Frequent dashboard query
        # "give me the latest version of this building" benefits from
        # this composite. See migration 0027_building_versioning.
        Index("ix_reports_building_latest",        "building_id", "building_is_latest"),
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

    # Phase 5.1 (May 2026, docs §9.4) — H3 hexagonal cell index for
    # the optional CRISP_NEARBY_H3_MODE aggregator path. Resolution 9
    # (~175 m hex edge length, ~110k m² area) is the docs-recommended
    # default for 500k+-reports-per-crisis scale. Nullable: NULL means
    # the row predates the H3 backfill or the helper failed silently.
    # The /nearby query falls back to ST_DWithin / bbox when h3_idx is
    # absent for any candidate row.
    h3_idx = Column(String(16), nullable=True)

    report = relationship("Report", back_populates="location")

    # May 2026 (0018) — composite index on (latitude, longitude) so the
    # /api/v1/reports/nearby bbox pre-filter is an indexed range scan
    # instead of a full Location table scan. Mirrored in migration
    # 0018_locations_lat_lng_index so `Base.metadata.create_all()`
    # (pytest setup) and `alembic upgrade` produce the same physical
    # index name.
    # 0025 added ix_locations_h3_idx for the H3-mode aggregator path.
    __table_args__ = (
        Index("ix_locations_lat_lng", "latitude", "longitude"),
        Index("ix_locations_h3_idx", "h3_idx"),
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

    # Phase F image-reliability (May 2026, migration 0032).
    # Terminal-state metadata for stuck uploads. Populated by the periodic
    # `_assembly_recovery_loop` daemon in app.main when a row sits in
    # `assembly_status='assembling'` or `received_chunks < chunk_count` past
    # its deadline. The companion `assembly_status` flips to 'failed' at the
    # same time; both columns stay NULL on complete / pending / assembling
    # rows that are still inside the freshness window. See migration 0032
    # for the abandon_reason vocabulary (chunks_never_arrived /
    # assembly_worker_lost / checksum_mismatch / operator_manual).
    abandoned_at = Column(DateTime(timezone=True), nullable=True)
    abandon_reason = Column(String(40), nullable=True)

    report = relationship("Report", back_populates="media")
    chunks = relationship("MediaChunk", back_populates="media", cascade="all, delete-orphan")

    # UI v2.1 — pHash dedup endpoint windows by `created_at` for
    # the last 24 h. Mirrors migration 0008.
    # 0032 — `ix_media_abandoned_at` lives in the migration only (date-range
    # probe by the periodic sweep); not declared here because the index isn't
    # used by SQLAlchemy queries directly.
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


# Phase F.5.c (May 2026) — UNDP must-have #8 building versioning hook.
#
# Fires on INSERT only. For a row with a non-NULL building_id:
#   1. Find the count of existing reports for that building_id.
#   2. Assign `building_version_ordinal = count + 1` (1-indexed).
#   3. Set `building_is_latest = True` on this new row.
#   4. Flip every prior row in the same partition to
#      `building_is_latest = False` (single UPDATE statement;
#      the partial index `ix_reports_building_latest` is built for
#      exactly this query shape).
#
# We deliberately DON'T re-run this on UPDATE — once an ordinal is
# stamped it stays put across edits. If a report's building_id is
# CHANGED post-insert (rare; analyst-driven via a re-link action),
# the dashboard's "Version 3 of 7" chip becomes stale until the next
# new report on either building shifts the partition. Tolerable;
# fully-consistent ordinals across cross-building moves would need a
# trigger on UPDATE too, which complicates the rollback path.
#
# Defensive: never fail an INSERT because of this hook. If the
# partition query throws (e.g. the connection drops mid-write), the
# new row simply lands with ordinal=NULL + is_latest=False — the
# next successful insert restamps the partition.
def _apply_building_versioning(_mapper, connection, target: "Report") -> None:  # type: ignore[name-defined]
    try:
        if not getattr(target, "building_id", None):
            return
        from sqlalchemy import text as _text
        # K.1.c (May 2026, Phase K) — partition-scoped advisory lock.
        # Pre-fix the SELECT COUNT() + UPDATE was a check-then-act race:
        # two concurrent INSERTs for the same building_id could both
        # read `existing=N`, both compute `ordinal=N+1`, both mark
        # `is_latest=True` → duplicate ordinals AND multiple "latest"
        # rows in the same partition, breaking F.5.c's invariant.
        # Postgres disallows `SELECT ... FOR UPDATE` with aggregate
        # functions, so we use `pg_advisory_xact_lock(hashtext(...))`
        # which is the idiomatic pattern for serialising a partition
        # at txn scope. The lock auto-releases at COMMIT/ROLLBACK and
        # is scoped per-building (so different buildings can still
        # insert concurrently). A second INSERT for the same building
        # waits on the lock, then reads the freshly-committed count.
        connection.execute(
            _text("SELECT pg_advisory_xact_lock(hashtext(:tag))"),
            {"tag": f"crisp:building:{target.building_id}"},
        )
        result = connection.execute(
            _text("SELECT COUNT(*) FROM reports WHERE building_id = :bid"),
            {"bid": target.building_id},
        )
        existing = result.scalar() or 0
        # Step 2: assign ordinal + mark latest.
        target.building_version_ordinal = existing + 1
        target.building_is_latest = True
        # Step 3: flip prior latest rows in the same partition to false.
        # No-op when this is the first report on the building (existing=0).
        if existing > 0:
            connection.execute(
                _text(
                    "UPDATE reports SET building_is_latest = false "
                    "WHERE building_id = :bid AND building_is_latest = true"
                ),
                {"bid": target.building_id},
            )
    except Exception:
        # Never fail the write — defensive default leaves ordinal=NULL,
        # is_latest=False which is the same shape as a row without a
        # building_id. Subsequent inserts will restamp the partition.
        pass


event.listen(Report, "before_insert", _apply_building_versioning)


# ──────────────────────────────────────────────────────────────────────
# Phase H.1.b (May 2026) — Building intelligence entity + lifecycle hook.
#
# Companion to F.5.c's building_version_ordinal / _is_latest columns
# (those live on Report). This block elevates the building itself to
# a first-class entity with cached roll-ups, an operational state, and
# 5 intelligence scores. See migration 0028 for the schema; see the
# Phase H plan in /Users/pks/.claude/plans/swirling-forging-raccoon.md
# for the design rationale.
#
# Two write paths land here:
#
#   1. `_apply_building_link` — after_insert / after_update hook on
#      Report. Ensures a Building row exists for the report's
#      building_id, then re-derives the cached roll-ups + scores from
#      the full partition. Defensive — never raises.
#
#   2. `_compute_building_scores` — pure-Python score helpers exported
#      so the initial-sweep script + the H.1.c list endpoint can call
#      them directly without re-running the hook.
#
# Performance: the hook fires on every Report INSERT/UPDATE. The
# work per fire is bounded by the partition size (~ few rows per
# building); on a 500k-report DB with 50k buildings that's typically
# <50 rows per fire, well under 10 ms.
# ──────────────────────────────────────────────────────────────────────
class Building(Base):
    """First-class building entity (Phase H.1).

    Master table for the Building Intelligence & Response Coordination
    system. One row per distinct building_id seen across the Reports
    table. Cached roll-up columns + 5 intelligence scores avoid the
    O(reports) recompute on every dashboard render.

    Created + backfilled by alembic 0028; maintained on every Report
    write by `_apply_building_link`. Score formulas are documented in
    `_compute_building_scores` below.
    """
    __tablename__ = "buildings"

    id = Column(String(64), primary_key=True)
    id_source = Column(
        Enum(BuildingIdSourceEnum, name="building_id_source",
             create_type=False),  # type managed by migration 0028
        nullable=False,
        default=BuildingIdSourceEnum.OSM,
    )

    # OSM-derived metadata
    osm_way_id = Column(BigInteger, nullable=True, index=True)
    osm_node_id = Column(BigInteger, nullable=True)
    osm_name = Column(String(200), nullable=True)
    osm_building_type = Column(String(40), nullable=True)
    osm_addr_full = Column(String(400), nullable=True)

    # Footprint cache (PostGIS column added by migration 0028 when
    # available; not exposed as a column attribute here — endpoints
    # query via raw SQL for PostGIS-specific operations).
    footprint_geojson = Column(JSON, nullable=True)
    centroid_lat = Column(Float, nullable=True)
    centroid_lng = Column(Float, nullable=True)

    # Operational state. Stored as plain String(20) so we can add new
    # states later without an ALTER TYPE migration; validation lives
    # in the H.2 state-transition endpoint.
    state = Column(String(20), nullable=False, default="ACTIVE",
                   server_default="ACTIVE", index=True)

    # Cached 5-score intelligence model. NULL until the hook fires
    # at least once for this building. Dashboard renders "—" when NULL.
    severity_score = Column(Float, nullable=True, index=True)
    confidence_score = Column(Float, nullable=True)
    activity_score = Column(Float, nullable=True)
    escalation_risk = Column(Float, nullable=True)
    humanitarian_priority = Column(Float, nullable=True, index=True)

    # Roll-ups (canonical "what's the situation" counters).
    report_count = Column(Integer, nullable=False, default=0,
                          server_default="0")
    verified_report_count = Column(Integer, nullable=False, default=0,
                                   server_default="0")
    responding_report_count = Column(Integer, nullable=False, default=0,
                                     server_default="0")
    resolved_report_count = Column(Integer, nullable=False, default=0,
                                   server_default="0")
    severity_max = Column(String(20), nullable=True)
    damage_class_max = Column(String(20), nullable=True)
    crisis_types_top3 = Column(JSON, nullable=True)
    debris_clearing_needed_count = Column(Integer, nullable=False, default=0,
                                          server_default="0")
    estimated_people_affected = Column(Integer, nullable=True)

    # Lifecycle timestamps
    first_report_at = Column(DateTime(timezone=True), nullable=True)
    latest_report_at = Column(DateTime(timezone=True), nullable=True, index=True)
    state_changed_at = Column(DateTime(timezone=True), nullable=True)
    state_changed_by_user_id = Column(String(36), nullable=True)

    # AI summary cache (populated by H.6)
    ai_summary = Column(JSON, nullable=True)
    ai_summary_at = Column(DateTime(timezone=True), nullable=True)

    # Soft archive (set when all constituent reports are deleted in grace)
    archived_at = Column(DateTime(timezone=True), nullable=True)

    # Relationship back to constituent reports — many reports per
    # building. Use lazy="dynamic" so we can filter/count without
    # pulling the whole partition into memory.
    reports = relationship(
        "Report", primaryjoin="Report.building_id == Building.id",
        foreign_keys="Report.building_id", lazy="dynamic",
        viewonly=True,  # Report-side authoritative; Building is the
                         # cache. Avoids double-writing on session.commit.
    )


# ─── Severity / damage ranking — same as the dashboard's mental model ──
_SEVERITY_RANK = {
    "CRITICAL": 5, "SEVERE": 4, "MODERATE": 3, "MINOR": 2, "UNKNOWN": 1,
}
_DAMAGE_RANK = {
    "COMPLETE": 3, "PARTIAL": 2, "MINIMAL": 1, "NO_DAMAGE": 0,
}


def _compute_building_scores(connection, building_id: str) -> dict:
    """Compute the 5 intelligence scores for a building from current
    reports + verifications. Returns a dict suitable for an UPDATE
    SET clause. Pure SQL aggregation where possible; falls back to
    Python for the time-decayed activity_score.

    Score formulas (see plan H — Intelligence scoring model):

      severity_score (0-100) =
          (max_severity_rank / 5) × 60
        + (verified_count / report_count) × 20
        + (max_damage_rank / 3) × 20

      confidence_score (0-100) =
          AVG(satellite_verification.total_score) × 0.5  (when any)
        + (verified_count / report_count) × 30
        + min(distinct_sources, 5) × 4

      activity_score (0-100) =
          Σ over reports of exp(-Δhours / 48) × 12   (capped at 100)

      escalation_risk (0-100) =
          (reports_last_60min ≥ 3 ? 30 : 0)         # burst signal
        + (reports_last_15min ≥ 5 ? 50 : 0)         # acute signal
        + (severity_max in CRITICAL/SEVERE ? 20 : 0) # severity bump
        capped at 100

      humanitarian_priority (0-100, weighted) =
          0.40 × severity_score
        + 0.25 × confidence_score
        + 0.20 × escalation_risk
        + 0.10 × min(estimated_people_affected/100, 100)
        + 0.05 × activity_score
    """
    from sqlalchemy import text
    import math
    from datetime import datetime, timezone as _tz

    # Step 1 — pull the cheap aggregates in one SQL pass.
    rows = connection.execute(text("""
        SELECT
            COUNT(*)                                                AS rep_count,
            SUM(CASE WHEN reviewer_verdict = 'ACCEPTED' THEN 1 ELSE 0 END) AS verified,
            COUNT(DISTINCT source)                                  AS sources,
            COUNT(*) FILTER (WHERE server_created_at > NOW() - INTERVAL '60 minutes') AS r60m,
            COUNT(*) FILTER (WHERE server_created_at > NOW() - INTERVAL '15 minutes') AS r15m,
            MAX(CASE severity
                WHEN 'CRITICAL' THEN 5 WHEN 'SEVERE'   THEN 4
                WHEN 'MODERATE' THEN 3 WHEN 'MINOR'    THEN 2
                WHEN 'UNKNOWN'  THEN 1 ELSE 0 END)                  AS sev_rank,
            MAX(CASE damage_classification
                WHEN 'COMPLETE' THEN 3 WHEN 'PARTIAL' THEN 2
                WHEN 'MINIMAL'  THEN 1 ELSE 0 END)                  AS dmg_rank
        FROM reports
        WHERE building_id = :bid AND deletion_requested_at IS NULL
    """), {"bid": building_id}).first()

    rep_count = (rows[0] or 0) if rows else 0
    if rep_count == 0:
        # No constituent reports → no scores. Don't write zeros (they
        # would falsely look like "this building has been measured at
        # 0"); leave NULL.
        return {}

    verified = rows[1] or 0
    sources = rows[2] or 0
    r60m = rows[3] or 0
    r15m = rows[4] or 0
    sev_rank = rows[5] or 0
    dmg_rank = rows[6] or 0

    # Step 2 — satellite verification mean (separate query because the
    # JOIN to satellite_verifications adds noise on the main aggregate).
    # Postgres `AVG()` returns Decimal; force to float here to avoid
    # mixing types in the score arithmetic below (Decimal × float =
    # TypeError in Python).
    sat_mean_raw = connection.execute(text("""
        SELECT AVG(sv.total_score)
        FROM satellite_verifications sv
        JOIN reports r ON r.id = sv.report_id
        WHERE r.building_id = :bid
          AND r.deletion_requested_at IS NULL
          AND sv.total_score IS NOT NULL
    """), {"bid": building_id}).scalar()
    sat_mean = float(sat_mean_raw) if sat_mean_raw is not None else 0.0

    verified_ratio = verified / rep_count if rep_count > 0 else 0.0

    # severity_score
    severity_score = min(100.0,
        (sev_rank / 5.0) * 60.0
        + verified_ratio * 20.0
        + (dmg_rank / 3.0) * 20.0
    )

    # confidence_score
    confidence_score = min(100.0,
        sat_mean * 0.5
        + verified_ratio * 30.0
        + min(sources, 5) * 4.0
    )

    # activity_score — exponential decay. Pull report timestamps
    # (count is bounded by partition size; typically <50 rows).
    # `EXTRACT(EPOCH ...)/3600.0` returns Decimal in Postgres → cast
    # to float at the boundary for the math.exp call.
    ts_rows = connection.execute(text("""
        SELECT EXTRACT(EPOCH FROM (NOW() - server_created_at)) / 3600.0
        FROM reports
        WHERE building_id = :bid AND deletion_requested_at IS NULL
    """), {"bid": building_id}).all()
    activity_score = min(100.0,
        sum(
            math.exp(-max(float(h) if h is not None else 0.0, 0.0) / 48.0)
            for (h,) in ts_rows
        ) * 12.0
    )

    # escalation_risk
    escalation_risk = min(100.0,
        (30 if r60m >= 3 else 0)
        + (50 if r15m >= 5 else 0)
        + (20 if sev_rank >= 4 else 0)
    )

    # humanitarian_priority (weighted)
    humanitarian_priority = min(100.0,
        0.40 * severity_score
        + 0.25 * confidence_score
        + 0.20 * escalation_risk
        + 0.05 * activity_score
        # 0.10 × estimated_people_affected term defaults to 0 here —
        # population estimate isn't on Report today; H.6 AI summary
        # will populate it.
    )

    return {
        "severity_score": round(severity_score, 1),
        "confidence_score": round(confidence_score, 1),
        "activity_score": round(activity_score, 1),
        "escalation_risk": round(escalation_risk, 1),
        "humanitarian_priority": round(humanitarian_priority, 1),
    }


def _refresh_building_rollups(connection, building_id: str) -> None:
    """Single-query UPDATE that re-derives ALL cached roll-up columns
    on the buildings row from current reports. Cheap (one SQL round-
    trip). Score columns NOT touched here — `_compute_building_scores`
    is called separately + writes them in a second UPDATE.
    """
    from sqlalchemy import text
    connection.execute(text("""
        UPDATE buildings b
        SET
            report_count            = sub.rep_count,
            verified_report_count   = sub.verified,
            responding_report_count = sub.responding,
            resolved_report_count   = sub.resolved,
            severity_max            = sub.sev_max,
            damage_class_max        = sub.dmg_max,
            crisis_types_top3       = sub.crisis_top3,
            debris_clearing_needed_count = sub.debris,
            first_report_at         = sub.first_at,
            latest_report_at        = sub.latest_at
        FROM (
            SELECT
                COUNT(*) AS rep_count,
                SUM(CASE WHEN reviewer_verdict = 'ACCEPTED' THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN status = 'RESPONDING' THEN 1 ELSE 0 END) AS responding,
                SUM(CASE WHEN status IN ('RESOLVED','FALSE_ALARM') THEN 1 ELSE 0 END) AS resolved,
                (SELECT severity FROM reports
                  WHERE building_id = :bid AND deletion_requested_at IS NULL
                  ORDER BY CASE severity
                      WHEN 'CRITICAL' THEN 5 WHEN 'SEVERE' THEN 4
                      WHEN 'MODERATE' THEN 3 WHEN 'MINOR' THEN 2
                      WHEN 'UNKNOWN' THEN 1 ELSE 0 END DESC
                  LIMIT 1) AS sev_max,
                (SELECT damage_classification FROM reports
                  WHERE building_id = :bid AND deletion_requested_at IS NULL
                    AND damage_classification IS NOT NULL
                  ORDER BY CASE damage_classification
                      WHEN 'COMPLETE' THEN 3 WHEN 'PARTIAL' THEN 2
                      WHEN 'MINIMAL' THEN 1 ELSE 0 END DESC
                  LIMIT 1) AS dmg_max,
                (SELECT COALESCE(jsonb_agg(crisis_type ORDER BY n DESC), '[]'::jsonb)
                 FROM (
                    SELECT crisis_type, COUNT(*) AS n
                    FROM reports
                    WHERE building_id = :bid AND deletion_requested_at IS NULL
                      AND crisis_type IS NOT NULL
                    GROUP BY crisis_type
                    ORDER BY n DESC
                    LIMIT 3
                 ) ct) AS crisis_top3,
                SUM(CASE WHEN debris_clearing_needed THEN 1 ELSE 0 END) AS debris,
                MIN(server_created_at) AS first_at,
                MAX(server_created_at) AS latest_at
            FROM reports
            WHERE building_id = :bid AND deletion_requested_at IS NULL
        ) sub
        WHERE b.id = :bid
    """), {"bid": building_id})


def _ensure_building_exists(connection, building_id: str) -> None:
    """Insert a minimal Building row if `building_id` isn't already in
    the buildings table. Mirrors the migration 0028 backfill heuristic
    for id_source + osm_way_id derivation.
    """
    from sqlalchemy import text
    exists = connection.execute(
        text("SELECT 1 FROM buildings WHERE id = :bid"),
        {"bid": building_id},
    ).first()
    if exists:
        return
    # Determine id_source + osm_way_id by inspecting the id string.
    # OSM ids are `osm:way:<int>` or `osm:node:<int>`; anything else
    # is treated as a proximity-clustered UUID.
    if building_id.startswith("osm:way:"):
        id_source = "OSM"
        try:
            osm_way_id = int(building_id.split(":", 2)[2])
        except (ValueError, IndexError):
            osm_way_id = None
    elif building_id.startswith("osm:node:"):
        id_source = "OSM"
        osm_way_id = None  # node id lands in osm_node_id, not osm_way_id
    else:
        id_source = "PROXIMITY"
        osm_way_id = None
    connection.execute(text("""
        INSERT INTO buildings (id, id_source, osm_way_id, state)
        VALUES (:bid, :src, :owid, 'ACTIVE')
        ON CONFLICT (id) DO NOTHING
    """), {"bid": building_id, "src": id_source, "owid": osm_way_id})


def _apply_building_link(_mapper, connection, target: "Report") -> None:  # type: ignore[name-defined]
    """SQLAlchemy `after_insert` / `after_update` hook on Report.

    Keeps the buildings table's cached roll-ups + scores current
    after every Report write. Defensive — never re-raises. The
    Report write is already committed (after_insert/update), so a
    failure here just leaves the building cache slightly stale; a
    subsequent write or the hourly background sweep restamps it.
    """
    try:
        bid = getattr(target, "building_id", None)
        if not bid:
            return
        _ensure_building_exists(connection, bid)
        _refresh_building_rollups(connection, bid)
        # Compute scores in Python (uses time-decay math). Apply via a
        # second UPDATE so the SQL roll-up + Python score writes are
        # atomic per Building row.
        scores = _compute_building_scores(connection, bid)
        if scores:
            from sqlalchemy import text
            connection.execute(text("""
                UPDATE buildings SET
                    severity_score = :sev,
                    confidence_score = :conf,
                    activity_score = :act,
                    escalation_risk = :esc,
                    humanitarian_priority = :prio
                WHERE id = :bid
            """), {
                "bid": bid,
                "sev": scores["severity_score"],
                "conf": scores["confidence_score"],
                "act": scores["activity_score"],
                "esc": scores["escalation_risk"],
                "prio": scores["humanitarian_priority"],
            })
    except Exception as e:
        # Never propagate — the Report write succeeded and the
        # Building cache will catch up on the next write or sweep.
        import logging
        logging.warning(
            "[_apply_building_link] failed for building_id=%s: %s",
            getattr(target, "building_id", None), e,
        )


# Register on both insert + update. Update fires when the Report's
# severity / status / damage / debris_clearing_needed changes, so the
# rolled-up severity_max etc. stay current.
event.listen(Report, "after_insert", _apply_building_link)
event.listen(Report, "after_update", _apply_building_link)


# Phase H.2 (May 2026) — Building audit trail.
#
# Append-only log of state transitions + operator actions on a
# Building entity. Created by alembic 0029. Indexed
# `(building_id, occurred_at)` for the dashboard timeline render.
#
# Event kinds (bounded vocabulary; NOT a Postgres enum so we can
# add new kinds without ALTER TYPE migrations):
#
#   STATE_CHANGED       payload: {from_state, to_state, reason?}
#   REPORT_LINKED       payload: {report_id}
#   REPORT_UNLINKED     payload: {report_id}
#   MONITOR_STARTED     payload: {} (actor_user_id is the watcher)
#   MONITOR_CLEARED     payload: {}
#   RESPONDER_*         payload: {responder_id, eta_minutes?}
#   NOTE_ADDED          payload: {note_id, body_prefix}
#   NOTE_EDITED / NOTE_DELETED
#   AI_SUMMARY_GENERATED
#   SATELLITE_VERIFIED  payload: {mean_score, verdict, count}
#   ESCALATED / DE_ESCALATED / FALSE_ALARM_DECLARED / ARCHIVED
class BuildingEvent(Base):
    """Append-only audit log of building lifecycle events.

    Surfaced via the dashboard Building Intelligence Console timeline
    section (renders newest-first) and the H.2 state-transition
    endpoints append rows here on every state change.
    """
    __tablename__ = "building_events"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    building_id = Column(
        String(64),
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_kind = Column(String(40), nullable=False, index=True)
    actor_user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    actor_kind = Column(
        Enum("OPERATOR", "SYSTEM", "AI",
             name="building_event_actor_kind",
             create_type=False),
        nullable=False,
        default="OPERATOR",
    )
    payload = Column(JSON, nullable=True)
    occurred_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )


# Allowed BuildingState transitions (state machine). Applied at the
# H.2 state-transition endpoint level — the database does not enforce
# this, only the application layer. Operators can always force a
# transition via SUPER_ADMIN role if the machine gets stuck (escape
# hatch documented in the endpoint).
_BUILDING_STATE_TRANSITIONS = {
    "ACTIVE":       {"MONITORED", "RESPONDING", "ESCALATED", "FALSE_ALARM", "RESOLVED", "ARCHIVED"},
    "MONITORED":    {"RESPONDING", "ESCALATED", "FALSE_ALARM", "RESOLVED", "ARCHIVED", "ACTIVE"},
    "RESPONDING":   {"RESOLVED", "ESCALATED", "FALSE_ALARM", "ARCHIVED"},
    "ESCALATED":    {"RESPONDING", "RESOLVED", "FALSE_ALARM", "ARCHIVED"},
    "RESOLVED":     {"ACTIVE", "ARCHIVED"},           # can re-open if new reports come in
    "ARCHIVED":     {"ACTIVE"},                        # rehydrate if new reports land
    "FALSE_ALARM":  {"ACTIVE", "ARCHIVED"},           # operator changes mind
}


def is_valid_building_state_transition(from_state: str, to_state: str) -> bool:
    """Return True if `from_state → to_state` is an allowed transition."""
    if from_state == to_state:
        return False  # no-op
    allowed = _BUILDING_STATE_TRANSITIONS.get(from_state, set())
    return to_state in allowed


# Phase H.3 (May 2026) — responder coordination + operator watch list.
#
# `building_responders` — one row per responder assigned to the
# building. Lifecycle: assigned → dispatched → arrived → cleared.
# Surfaces in the Building Intelligence Console's Responders panel.
class BuildingResponder(Base):
    """Responder assigned to a building.

    Created when an operator clicks "Assign responder" in the console.
    The lifecycle timestamps progress as the field situation evolves;
    `cleared_at` set means the responder has finished and the row no
    longer counts toward the building's "active responder count".
    """
    __tablename__ = "building_responders"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    building_id = Column(
        String(64),
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assigned_by_user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    responder_name = Column(String(200), nullable=False)
    responder_org = Column(String(200), nullable=True)
    responder_contact = Column(String(200), nullable=True)
    assigned_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    dispatched_at = Column(DateTime(timezone=True), nullable=True)
    arrived_at = Column(DateTime(timezone=True), nullable=True)
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    eta_minutes = Column(Integer, nullable=True)
    notes = Column(Text, nullable=True)


# Phase H.3 — per-operator building watch list.
#
# Each operator can "watch" a building to get prioritised in their
# personal queue + (future) push notifications on score changes.
# `cleared_at` IS NULL → active watch; partial unique index in the
# migration enforces "max one active watch per (building, user)".
class BuildingMonitor(Base):
    """Per-operator watch list entry."""
    __tablename__ = "building_monitors"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    building_id = Column(
        String(64),
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    started_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    note = Column(Text, nullable=True)


# ── Phase H.4 — Operator notes thread ──────────────────────────────────
class BuildingNote(Base):
    """Free-text operator note on a Building.

    Notes are the long-form context channel that BuildingEvent (audit
    log) + Building.ai_summary (machine brief) deliberately don't try
    to be. Pinnable, edit + soft-delete, visibility ENUM gates
    ADMIN_ONLY notes from non-admin operators.
    """
    __tablename__ = "building_notes"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    building_id = Column(
        String(64),
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # author_user_id is nullable so deleting a user doesn't cascade-
    # delete their historical notes (ON DELETE SET NULL on the FK).
    author_user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    body = Column(Text, nullable=False)
    # Visibility is a Postgres ENUM created by the alembic migration.
    # We bind to the existing type rather than have SQLAlchemy try to
    # create it again at table-create time.
    visibility = Column(
        Enum(
            "ALL_OPERATORS", "ADMIN_ONLY",
            name="building_note_visibility",
            create_type=False,
        ),
        nullable=False,
        default="ALL_OPERATORS",
    )
    pinned = Column(Boolean, nullable=False, default=False)
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    edited_at = Column(DateTime(timezone=True), nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)


# ── Phase 5.1 (May 2026, docs §9.4) — H3 cell auto-population ────────
# When a Location row is inserted or its lat/lng changes, derive the H3
# cell index. Single listener covers all three Location-create sites in
# reports.py + any future sites — no per-site wiring required.
#
# Best-effort: import + computation failures are silently swallowed so
# a missing h3 wheel or NaN coords can never block a real submission.
def _populate_h3_idx(mapper, connection, target: "Location") -> None:  # type: ignore[name-defined]
    """Always recompute the cell on insert + on every update.
    Recompute is microsecond-cheap; the alternative ("skip if set")
    would leave stale h3_idx values after a lat/lng correction."""
    try:
        lat = getattr(target, "latitude", None)
        lng = getattr(target, "longitude", None)
        if lat is None or lng is None:
            return
        # Lazy import to avoid a hard dep at model-load time.
        from app.services.h3_helper import compute_cell
        target.h3_idx = compute_cell(float(lat), float(lng))
    except Exception:
        # Don't ever break the insert/update path for an H3 hiccup.
        pass


event.listen(Location, "before_insert", _populate_h3_idx)
event.listen(Location, "before_update", _populate_h3_idx)


# ── Phase 5.1 (May 2026, docs §9.5) — Materialised hot-region snapshots ─
# Per-region pre-aggregated /nearby responses for 1 M+-report regions
# under active disaster. The aggregator runs once per region per refresh
# interval; every /nearby poll that falls inside an enabled region
# returns the cached snapshot instead of re-aggregating live.
#
# Not a PostgreSQL materialised view — a regular table with a JSONB
# blob keyed by region. Lighter than MV + survives multi-worker /
# multi-instance / process-restart without rebuild drama.

class NearbyHotRegion(Base):
    __tablename__ = "nearby_hot_regions"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    # Unique human-readable name (e.g. "bangalore-central", "delhi-ncr").
    # The admin endpoint uses this as the path component.
    name = Column(String(64), unique=True, nullable=False)
    # Region centre + radius. /nearby callers whose coords fall within
    # `radius_km` of the centre get the snapshot.
    centre_lat = Column(Float, nullable=False)
    centre_lng = Column(Float, nullable=False)
    radius_km = Column(Float, nullable=False, default=5.0)
    # Snapshot lifetime. The scheduled refresh task should run at
    # least this often (default 15 min, per docs §9.5).
    refresh_interval_min = Column(Integer, nullable=False, default=15,
                                  server_default="15")
    # The most recent precomputed /nearby response, exactly as the
    # endpoint would return it (active groups + recently_resolved +
    # density mode + …).
    snapshot_json = Column(JSON, nullable=True)
    refreshed_at = Column(DateTime(timezone=True), nullable=True)
    # Soft toggle so the operator can disable a region without
    # deleting its row + losing the configured centre / radius.
    is_enabled = Column(Boolean, nullable=False, default=True,
                        server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


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


class NearbyGroupEvent(Base):
    """Nearby Reports Pipeline — lifecycle audit trail.

    Phase 2 (May 2026, docs §3.7 + §13). One row per transition for a
    nearby aggregation group: promote / downgrade / merge / split /
    resolve / fading. Group ids are SYNTHETIC (g_building_<bid> /
    g_block_<gh>_<crisis> / g_area_<gh>_<crisis>) so there is no FK —
    groups are ephemeral aggregations, not DB rows. The synthetic id
    is stable across polls as long as the membership doesn't change,
    which is exactly what the transition detector needs.

    Indexed for two access patterns:
      ① "all events for group X newest-first" — composite
         (group_id, occurred_at DESC), used by the public
         "Cluster history" timeline.
      ② "all events in the last N minutes" — single column
         occurred_at, used by §13's observability metrics
         (cluster lifetime histogram, promotion-rate counter).
    """
    __tablename__ = "nearby_group_events"

    id = Column(String(36), primary_key=True)
    group_id = Column(String(128), nullable=False)
    # Bounded vocabulary; the aggregator emits one of these constants.
    # See app/services/nearby_lifecycle.py:GroupEventKind.
    event_kind = Column(String(32), nullable=False)
    from_tier = Column(String(16), nullable=True)
    to_tier = Column(String(16), nullable=True)
    from_count = Column(Integer, nullable=True)
    to_count = Column(Integer, nullable=True)
    # JSONB for ad-hoc diff data — kept jsonb so we can query inside
    # later (e.g. "groups whose acute_grade flipped HIGH→LOW").
    payload = Column(JSON, default=dict, nullable=False)
    occurred_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_nearby_group_events_group_id_occurred_at",
              "group_id", "occurred_at"),
        Index("ix_nearby_group_events_occurred_at", "occurred_at"),
    )


class Appeal(Base):
    """CRISP-hosted moderation appeal (Phase 4, docs §6.4 + §7.5).

    Opened when a device's spam_score / spam_signals cause its
    contributions to be suppressed. Admins decide: reinstated
    (zero spam_score) / upheld (keep suppression) / banned
    (permanent — requires 2-admin co-sign per docs §7.5).

    UNDP and other deployment partners integrate via outbound
    webhooks emitted on status changes — they DON'T own the
    underlying tables. Framework stays reusable across deployments.
    """
    __tablename__ = "appeals"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    device_id = Column(String(36),
                       ForeignKey("devices.id", ondelete="CASCADE"),
                       nullable=True)
    user_id = Column(String(36), nullable=True)
    # 'open' | 'under_review' | 'reinstated' | 'upheld' | 'banned'
    status = Column(String(20), nullable=False, default="open",
                    server_default="open")
    claim_text = Column(Text, nullable=True)
    original_signals = Column(JSON, default=list, nullable=False)
    original_spam_score = Column(Float, nullable=True)
    opened_at = Column(DateTime(timezone=True),
                       server_default=func.now(), nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    decided_by_admin_id = Column(String(36), nullable=True)
    decision_notes = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_appeals_device_id", "device_id"),
        Index("ix_appeals_status_opened", "status", "opened_at"),
    )


class AppealEvent(Base):
    """Append-only event log per Appeal."""
    __tablename__ = "appeal_events"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    appeal_id = Column(String(36),
                       ForeignKey("appeals.id", ondelete="CASCADE"),
                       nullable=False)
    # 'opened' | 'comment' | 'status_change' | 'webhook_sent'
    event_kind = Column(String(24), nullable=False)
    actor_admin_id = Column(String(36), nullable=True)
    payload = Column(JSON, default=dict, nullable=False)
    occurred_at = Column(DateTime(timezone=True),
                         server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_appeal_events_appeal_id_occurred",
              "appeal_id", "occurred_at"),
    )


class AiRetryQueueRow(Base):
    """Phase K K.6.b — persistent retry queue for AI pipeline tasks.

    Pre-K.6.b a transient AI failure (Anthropic 5xx, Whisper OOM,
    satellite-provider timeout) left the report's ``ai_assessment``
    NULL forever. The audit (Agent 2, B8) flagged this as P1: no
    automated retry, no operator-visible signal of partial-AI rows.

    K.6.b introduces this table + a daemon thread in ``app.main``
    (`_ai_retry_loop`) that polls every 60 s, picks rows where
    ``status='pending' AND next_attempt_at <= now``, re-runs the AI
    call, and either marks ``complete`` or backs off
    exponentially (1 min → 5 min → 30 min → 2 h → 12 h). After
    5 attempts the row flips to ``terminal_failed`` for manual
    operator review; the K.5.a chip surface renders "AI analysis
    failed" once that state is reached.

    Status vocabulary (bounded):
        pending          — waiting for next retry (next_attempt_at <= now)
        in_progress      — daemon picked this row up + is running it now
        complete         — AI call succeeded; row stays for audit
        terminal_failed  — 5 attempts exhausted; manual op only

    Kind vocabulary (bounded):
        transcription    — re-run audio → text via Whisper
        image_analysis   — re-run image → labels via Claude vision
        truth_scoring    — re-run satellite + truth_scorer fan-out
    """
    __tablename__ = "ai_retry_queue"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    report_id = Column(String(36),
                       ForeignKey("reports.id", ondelete="CASCADE"),
                       nullable=False)
    # 'transcription' | 'image_analysis' | 'truth_scoring' | other
    kind = Column(String(40), nullable=False)
    # Reference to the asset being processed (Media.url for media-bound
    # retries; NULL for report-level retries like truth_scoring which
    # reads multiple assets).
    file_url = Column(String, nullable=True)
    media_type = Column(String(10), nullable=True)  # IMAGE | AUDIO
    attempts = Column(Integer, nullable=False, server_default="0", default=0)
    last_attempt_at = Column(DateTime(timezone=True), nullable=True)
    next_attempt_at = Column(DateTime(timezone=True),
                             server_default=func.now(), nullable=False)
    last_error = Column(Text, nullable=True)
    status = Column(String(20), nullable=False,
                    server_default="pending", default="pending")
    created_at = Column(DateTime(timezone=True),
                        server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True),
                        server_default=func.now(),
                        onupdate=func.now(), nullable=False)

    __table_args__ = (
        # Hot daemon query: status='pending' AND next_attempt_at <= NOW().
        Index("ix_ai_retry_queue_status_next_attempt",
              "status", "next_attempt_at"),
        # Per-report cleanup + the dashboard's "show me the retry
        # history for this report" surface (planned follow-up).
        Index("ix_ai_retry_queue_report_id", "report_id"),
    )
