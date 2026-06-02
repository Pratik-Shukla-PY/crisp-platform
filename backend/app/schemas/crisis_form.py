"""Dynamic Crisis Forms — request/response schemas (Pydantic v2)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict


# ── Crisis Event ──────────────────────────────────────────────────────────
class CrisisEventCreate(BaseModel):
    name: str
    crisis_type: Optional[str] = None
    center_lat: float
    center_lng: float
    radius_km: float = 30.0
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    form_pack_id: Optional[str] = None
    is_active: bool = False
    status: str = "DRAFT"


class CrisisEventUpdate(BaseModel):
    name: Optional[str] = None
    crisis_type: Optional[str] = None
    center_lat: Optional[float] = None
    center_lng: Optional[float] = None
    radius_km: Optional[float] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    form_pack_id: Optional[str] = None
    is_active: Optional[bool] = None
    status: Optional[str] = None


class CrisisEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    crisis_type: Optional[str] = None
    status: str
    is_active: bool
    center_lat: float
    center_lng: float
    radius_km: float
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    form_pack_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ── Crisis Form Pack + Version ────────────────────────────────────────────
class CrisisFormPackCreate(BaseModel):
    key: str
    title: str
    description: Optional[str] = None
    crisis_type: Optional[str] = None


class CrisisFormPackUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    crisis_type: Optional[str] = None
    is_archived: Optional[bool] = None


class CrisisFormPackResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    key: str
    title: str
    description: Optional[str] = None
    crisis_type: Optional[str] = None
    active_version: Optional[int] = None
    is_archived: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class CrisisFormPackVersionCreate(BaseModel):
    schema_json: Dict[str, Any]


class CrisisFormPackVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    pack_id: str
    version: int
    schema_json: Dict[str, Any]
    status: str
    published_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


class PublishRequest(BaseModel):
    version: int


class SchemaLintRequest(BaseModel):
    schema_json: Dict[str, Any]


class SchemaLintResponse(BaseModel):
    valid: bool
    errors: List[str]


# ── Public "active crisis form for this point" ────────────────────────────
class ActiveCrisisFormResponse(BaseModel):
    active: bool
    event_id: Optional[str] = None
    event_name: Optional[str] = None
    crisis_type: Optional[str] = None
    pack_id: Optional[str] = None
    pack_version: Optional[int] = None
    schema_json: Optional[Dict[str, Any]] = None
