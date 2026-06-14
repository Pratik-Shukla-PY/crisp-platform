"""Dynamic Crisis Forms - request/response schemas (Pydantic v2)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# Operations have exactly two states (Operations redesign v2): a live response
# effort or a closed/historical one. DRAFT/PAUSED were removed; the server
# derives is_active from status (LIVE ⟺ active). Enforced at the DB layer by the
# 0053 CHECK constraint and here at the API boundary.
OPERATION_STATUSES = ("LIVE", "ENDED")


def _validate_operation_status(v):
    """Reject anything outside {LIVE, ENDED}; pass None through (partial update)."""
    if v is None:
        return v
    if v not in OPERATION_STATUSES:
        raise ValueError("status must be one of LIVE, ENDED")
    return v


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
    is_active: bool = True
    status: str = "LIVE"
    place_name: Optional[str] = None

    _chk_status = field_validator("status")(_validate_operation_status)


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
    place_name: Optional[str] = None

    _chk_status = field_validator("status")(_validate_operation_status)


# ── Operations list (operator-facing rollup; Phase 2) ──────────────────────
class OperationSummaryResponse(BaseModel):
    """One row in the operations rail/list: a CrisisEvent (operation) plus its
    per-event report rollup. A synthetic row with id=None / is_cluster=True
    represents un-operationalised critical reports ("Launch operation here")."""
    model_config = ConfigDict(from_attributes=True)
    id: Optional[str] = None
    name: str
    crisis_type: Optional[str] = None
    status: Optional[str] = None
    is_active: bool = False
    center_lat: Optional[float] = None
    center_lng: Optional[float] = None
    # P2 card fields - geography + identity + dates (all on CrisisEvent; were
    # omitted from the rollup payload). radius_km drives the SVG mini-map ring;
    # place_name is the denormalised "City, Country"; form_name is the active
    # pack's title (outerjoin); started_at/ended_at are the operation window.
    radius_km: Optional[float] = None
    place_name: Optional[str] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    form_pack_id: Optional[str] = None
    form_name: Optional[str] = None
    critical: int = 0
    new_24h: int = 0
    new_prev_24h: int = 0                        # [48h,24h) window - for the card's trend arrow
    total: int = 0
    verified: int = 0                           # all-time verified reports in this op
    last_activity: Optional[datetime] = None
    is_cluster: bool = False
    # Phase 3 - backend-authoritative health (replaces the client-side stand-in).
    health: str = "GREEN"                       # RED | AMBER | GREEN
    health_reason: Optional[str] = None         # short "why" for the hover
    responders_active: int = 0                  # live responders attached to this op
    unattended_critical: int = 0
    sla_breaches: int = 0


# ── Auto-claim write-path (Phase 3) ────────────────────────────────────────
class OperationLaunchRequest(BaseModel):
    """Operationalize the un-operationalised critical cluster: create (or merge
    into) an operation and bulk-claim the open-critical, un-operationalised reports."""
    name: str = Field(..., max_length=200)
    crisis_type: Optional[str] = None
    form_pack_id: Optional[str] = None


class OperationLaunchResponse(BaseModel):
    operation_id: str
    operation_name: str = ""
    claimed_count: int = 0
    skipped_count: int = 0
    unclaimed_count: int = 0
    merged_into_existing: bool = False


class OperationLaunchWithFormRequest(BaseModel):
    """Atomic "Start New Operation" publish (redesign v2 wizard, Step 4). Creates a
    crisis-form pack + a published version + a LIVE CrisisEvent in ONE transaction -
    nothing persists unless the whole thing succeeds (the no-draft-persistence rule).
    The server fills schema_json['key'/'title'] from the pack it creates, so the
    wizard only has to supply the sections + a human title."""
    name: str = Field(..., max_length=200)
    crisis_type: Optional[str] = None
    center_lat: float
    center_lng: float
    radius_km: float = 30.0
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    place_name: Optional[str] = None
    form_title: Optional[str] = None              # pack title; defaults to the operation name
    schema_json: Dict[str, Any]                   # the built form (sections + fields)
    from_cluster: bool = False                    # also claim the orphan-critical reports


class OperationFormTemplate(BaseModel):
    """Lean template row for the wizard's Step 1 (analyst-scoped, no admin needed)."""
    id: str
    key: str
    title: str
    crisis_type: Optional[str] = None
    schema_json: Optional[Dict[str, Any]] = None


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
    place_name: Optional[str] = None
    created_by: Optional[str] = None  # user id; the dashboard resolves → full_name
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
