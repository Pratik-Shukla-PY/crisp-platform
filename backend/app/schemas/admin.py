"""
CRISP — Admin schemas.

Phase 4 (Apr 2026): per-region auto-submit config + reviewer-workflow
patches. Kept separate from `report.py` so the admin surface doesn't leak
into client-facing payloads.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, ConfigDict


# ── Region auto-submit ──────────────────────────────────────────────────────

class RegionBase(BaseModel):
    """Shared validation — used for both create + update payloads. Radius
    capped at 200 km so a misconfigured zone can't accidentally enable
    auto-submit for an entire continent."""
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = False
    center_lat: float = Field(ge=-90, le=90)
    center_lng: float = Field(ge=-180, le=180)
    radius_meters: int = Field(ge=100, le=200_000, default=10_000)


class RegionCreate(RegionBase):
    pass


class RegionUpdate(BaseModel):
    """All fields optional so the PATCH handler can do partial updates."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    enabled: Optional[bool] = None
    center_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    center_lng: Optional[float] = Field(default=None, ge=-180, le=180)
    radius_meters: Optional[int] = Field(default=None, ge=100, le=200_000)


class RegionResponse(RegionBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class RegionPublicResponse(BaseModel):
    """Trimmed shape for the unauthenticated /regions/enabled endpoint.
    Drops metadata (created_by, timestamps) so the public payload stays
    small and doesn't expose admin identity. Clients use haversine against
    center_lat/lng/radius_meters — that's all they need."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    center_lat: float
    center_lng: float
    radius_meters: int


# ── Reviewer workflow (Phase 5) ─────────────────────────────────────────────

class ReviewPatch(BaseModel):
    """Analyst's accept/reject verdict. action_taken required when REJECTED
    so the reviewer always records a reason — enforced at endpoint level."""
    verdict: str = Field(pattern=r"^(ACCEPTED|REJECTED|NOT_REVIEWED)$")
    action_taken: Optional[str] = Field(default=None, max_length=500)


class TimestampPatch(BaseModel):
    """Responder-timestamp updates. Either or both timestamps may be set in
    a single call; server stamps the current UTC time when the caller
    omits an explicit value (common case: admin clicks "Mark Dispatched")."""
    help_dispatched_at: Optional[datetime] = None
    help_arrived_at: Optional[datetime] = None
    stamp_dispatched_now: bool = False
    stamp_arrived_now: bool = False
