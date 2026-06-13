"""Pydantic schemas for the Building Intelligence & Response Coordination
endpoints (Phase H.1.c).

Two main shapes:

  BuildingSummary  — compact representation for the LIST endpoint.
                     Operator-facing dashboard renders these as cards
                     in the building-grouped view. ~20 fields.

  BuildingDetail   — full intelligence for the /buildings/{id} endpoint.
                     Inherits BuildingSummary, adds nested reports +
                     satellite roll-up + AI summary. Built for the
                     Building Intelligence Console (H.1.d) which
                     replaces the right-side detail panel when a
                     building is selected.

  FootprintUpdate  — POST body for caching an OSM polygon that the
                     dashboard fetched via Overpass.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.report import ReportResponse


class BuildingSummary(BaseModel):
    """Compact building card for the list endpoint.

    Covers the 90 % case: operator opens the dashboard, scans buildings
    by humanitarian_priority desc, gets enough context to decide
    whether to open the full console. ~600 bytes of JSON per row.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(..., description="Building id — either osm:way:<n> or a proximity UUID")
    id_source: str = Field(..., description="Provenance: OSM / PROXIMITY / MANUAL")

    # OSM-derived display labels (nullable for proximity-clustered rows).
    osm_way_id: Optional[int] = None
    osm_name: Optional[str] = None
    osm_building_type: Optional[str] = None
    osm_addr_full: Optional[str] = None

    # Centroid + footprint surface for the map.
    centroid_lat: Optional[float] = None
    centroid_lng: Optional[float] = None
    has_footprint: bool = Field(False, description="True when footprint_geojson is cached")

    # Operational state (one of the BuildingStateEnum values).
    state: str = Field("ACTIVE")

    # Five intelligence scores (0-100). NULL until the hook has fired
    # at least once for this building — the dashboard renders "—" for
    # NULL rather than 0 (which would be misleading).
    severity_score: Optional[float] = None
    confidence_score: Optional[float] = None
    activity_score: Optional[float] = None
    escalation_risk: Optional[float] = None
    humanitarian_priority: Optional[float] = None

    # Canonical roll-up counters.
    report_count: int = 0
    verified_report_count: int = 0
    responding_report_count: int = 0
    resolved_report_count: int = 0
    debris_clearing_needed_count: int = 0

    # Aggregated taxonomy.
    severity_max: Optional[str] = None
    damage_class_max: Optional[str] = None
    crisis_types_top3: Optional[List[str]] = None

    # Lifecycle timestamps.
    first_report_at: Optional[datetime] = None
    latest_report_at: Optional[datetime] = None
    state_changed_at: Optional[datetime] = None

    # AI summary presence — boolean only on the summary view; the
    # full body lands on BuildingDetail.
    has_ai_summary: bool = False
    ai_summary_at: Optional[datetime] = None

    archived_at: Optional[datetime] = None


class AISummaryPayload(BaseModel):
    """Shape of the cached ai_summary JSON blob. Populated by H.6.
    H.9 extended with `trends` (deterministic server-computed) +
    `recommended_responder_types` (Claude-classified into a bounded
    enum-like set so the dashboard can render coloured badges).

    Stays in this schema module rather than ai_assessment.py so the
    Building Console can render it independently of any AI-specific
    surfaces.
    """
    summary: Optional[str] = None
    key_findings: Optional[List[str]] = None
    conflicting_signals: Optional[List[str]] = None
    responder_recommendation: Optional[str] = None
    # Phase H.9 — deterministic trends + structured recommended types.
    trends: Optional[dict] = None
    recommended_responder_types: Optional[List[str]] = None
    model: Optional[str] = None
    generated_at: Optional[datetime] = None


class BuildingDetail(BuildingSummary):
    """Full building intelligence for the console.

    Inherits BuildingSummary's 20 fields + adds nested reports (newest
    first), the AI summary body when cached, satellite roll-up, and
    the cached footprint GeoJSON.

    Lists are bounded — `reports` is the full version stack (typically
    <50 entries per building per the audit), `crisis_types_top3` is
    capped at 3 entries by the SQLAlchemy hook.
    """

    # Nested constituent reports — full ReportResponse so the console
    # can render the per-report inline cards without a second fetch.
    reports: List[ReportResponse] = Field(default_factory=list)

    # Cached OSM polygon — GeoJSON Feature dict. Set by POST
    # /buildings/{id}/footprint after the dashboard fetched it via
    # Overpass. Future readers don't re-pay the Overpass round-trip.
    footprint_geojson: Optional[dict] = None

    # AI summary cache body (Phase H.6).
    ai_summary: Optional[AISummaryPayload] = None

    # Satellite verification roll-up across constituent reports.
    # Mean + count for the score; max verdict label by severity rank.
    satellite_summary: Optional["SatelliteRollup"] = None

    # Phase H.3 — active responders + monitors. cleared_at IS NULL.
    responders: List["ResponderResponse"] = Field(default_factory=list)
    monitors: List["MonitorResponse"] = Field(default_factory=list)

    # Phase H.4 — operator notes (newest-first, pinned first). Includes
    # active + soft-deleted (the latter render as tombstones). Capped
    # at 50 entries in the endpoint to keep the detail payload bounded.
    notes: List["NoteResponse"] = Field(default_factory=list)


class SatelliteRollup(BaseModel):
    """Aggregated satellite verification across a building's reports."""
    mean_total_score: Optional[float] = None
    count: int = 0
    latest_verdict: Optional[str] = None
    latest_scored_at: Optional[datetime] = None


# ─── List response envelope ────────────────────────────────────────
class BuildingListResponse(BaseModel):
    """Envelope for the building list endpoint. Carries metadata
    (total, next cursor) alongside the items so the dashboard knows
    whether more pages exist without inspecting headers.
    """
    items: List[BuildingSummary]
    total: int
    next_cursor: Optional[str] = None


# ─── Phase H.2 — state transition + event timeline ─────────────────
class StateTransitionRequest(BaseModel):
    """POST body for state-change endpoints.

    `to_state` must be one of BuildingStateEnum's values; transition
    validity is checked server-side via
    `is_valid_building_state_transition(from_state, to_state)`. `reason`
    is a free-text operator note that lands in the BuildingEvent payload
    + can be surfaced in the timeline.
    """
    to_state: str = Field(..., description="Target state (BuildingStateEnum value)")
    reason: Optional[str] = Field(None, max_length=500)


class BuildingEventResponse(BaseModel):
    """Single audit-log entry for the console timeline."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    building_id: str
    event_kind: str
    actor_user_id: Optional[str] = None
    actor_kind: str
    payload: Optional[Any] = None
    occurred_at: datetime


# ─── Phase H.3 — responder coordination + watch list ───────────────
class ResponderResponse(BaseModel):
    """Single responder assignment for the console panel."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    building_id: Optional[str] = None          # NULL for OPERATION-target responders
    crisis_event_id: Optional[str] = None      # the operation, for OPERATION-target rows
    target_type: Optional[str] = None          # BUILDING | OPERATION
    org_type: Optional[str] = None             # GOV | NGO | VOLUNTEER | INTERNAL | OTHER
    assigned_by_user_id: Optional[str] = None
    responder_name: str
    responder_org: Optional[str] = None
    responder_contact: Optional[str] = None
    assigned_at: datetime
    dispatched_at: Optional[datetime] = None
    arrived_at: Optional[datetime] = None
    cleared_at: Optional[datetime] = None
    eta_minutes: Optional[int] = None
    notes: Optional[str] = None


class ResponderCreate(BaseModel):
    """POST body for assigning a new responder."""
    responder_name: str = Field(..., max_length=200)
    responder_org: Optional[str] = Field(None, max_length=200)
    responder_contact: Optional[str] = Field(None, max_length=200)
    eta_minutes: Optional[int] = Field(None, ge=0, le=10080)
    notes: Optional[str] = None
    # Phase 3 — bounded org vocabulary (app-validated, not a Postgres enum).
    org_type: Optional[str] = Field(
        "OTHER", pattern="^(GOV|NGO|VOLUNTEER|INTERNAL|OTHER)$")


class ResponderUpdate(BaseModel):
    """PATCH body for updating responder lifecycle.

    `action` is one of dispatched / arrived / cleared — the endpoint
    sets the corresponding timestamp + emits the matching
    BuildingEvent kind. Free-form patches to other fields go via the
    other optional keys.
    """
    action: Optional[str] = Field(
        None,
        pattern="^(dispatched|arrived|cleared)$",
        description="One of: dispatched | arrived | cleared",
    )
    eta_minutes: Optional[int] = Field(None, ge=0, le=10080)
    notes: Optional[str] = None


class MonitorResponse(BaseModel):
    """Operator watch-list entry."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    building_id: str
    user_id: str
    started_at: datetime
    cleared_at: Optional[datetime] = None
    note: Optional[str] = None


# ─── Phase H.4 — Operator notes thread ─────────────────────────────
class NoteResponse(BaseModel):
    """Single operator note. `author_email` + `author_name` are
    denormalised at read time so the dashboard doesn't have to follow
    a user lookup per row. `is_deleted` is true when the note was
    soft-deleted; the dashboard renders a tombstone rather than
    surfacing the body."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    building_id: str
    author_user_id: Optional[str] = None
    author_email: Optional[str] = None
    author_name: Optional[str] = None
    body: str
    visibility: str = "ALL_OPERATORS"
    pinned: bool = False
    created_at: datetime
    edited_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None


class NoteCreate(BaseModel):
    """POST body for adding a new note."""
    body: str = Field(..., min_length=1, max_length=4000)
    visibility: Optional[str] = Field(
        "ALL_OPERATORS",
        pattern="^(ALL_OPERATORS|ADMIN_ONLY)$",
    )
    pinned: bool = False


class NoteUpdate(BaseModel):
    """PATCH body for editing a note.

    All fields optional — only what's provided gets touched. Empty
    body is rejected (use DELETE to soft-delete instead).
    """
    body: Optional[str] = Field(None, min_length=1, max_length=4000)
    visibility: Optional[str] = Field(
        None,
        pattern="^(ALL_OPERATORS|ADMIN_ONLY)$",
    )
    pinned: Optional[bool] = None


# ─── POST body for footprint caching ───────────────────────────────
class FootprintUpdate(BaseModel):
    """Body for POST /buildings/{id}/footprint.

    The dashboard's `loadBuildingFootprints` calls Overpass at zoom
    ≥ 15, gets back a GeoJSON FeatureCollection, and (under Phase H)
    POSTs each Feature here so subsequent loads don't re-pay the
    Overpass round-trip. Server validates the geometry is a Polygon
    + bounds-checks the coordinates.
    """
    footprint_geojson: dict = Field(
        ...,
        description="GeoJSON Feature object: {type:'Feature', geometry:{type:'Polygon',...}, properties:{...}}",
    )
    osm_name: Optional[str] = None
    osm_building_type: Optional[str] = None
    osm_addr_full: Optional[str] = None


# ─── Forward-ref resolution ─────────────────────────────────────────
# BuildingDetail references SatelliteRollup + ResponderResponse +
# MonitorResponse via forward strings. Now that all three are defined
# we rebuild the model so Pydantic can resolve the annotations.
BuildingDetail.model_rebuild()
