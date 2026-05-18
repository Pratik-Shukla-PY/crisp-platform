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

    Stays in this schema module rather than ai_assessment.py so the
    Building Console can render it independently of any AI-specific
    surfaces.
    """
    summary: Optional[str] = None
    key_findings: Optional[List[str]] = None
    conflicting_signals: Optional[List[str]] = None
    responder_recommendation: Optional[str] = None
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


class SatelliteRollup(BaseModel):
    """Aggregated satellite verification across a building's reports."""
    mean_total_score: Optional[float] = None
    count: int = 0
    latest_verdict: Optional[str] = None
    latest_scored_at: Optional[datetime] = None


# Allow forward references in BuildingDetail.satellite_summary.
BuildingDetail.model_rebuild()


# ─── List response envelope ────────────────────────────────────────
class BuildingListResponse(BaseModel):
    """Envelope for the building list endpoint. Carries metadata
    (total, next cursor) alongside the items so the dashboard knows
    whether more pages exist without inspecting headers.
    """
    items: List[BuildingSummary]
    total: int
    next_cursor: Optional[str] = None


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
