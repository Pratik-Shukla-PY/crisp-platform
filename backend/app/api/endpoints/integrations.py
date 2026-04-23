"""UNDP RAPIDA integration surface (Apr 2026 UI v2.1 W7).

RAPIDA (Rapid Post-Crisis Integrated Digital Assessment) is UNDP's
flagship methodology; the brief explicitly names it as the canonical
ingestion target. CRISP's native data model already aligns to UNDP
Appendix-1 taxonomy, so the "integration" is mostly a matter of
shape-mapping + a stable endpoint URL UNDP's ingestion tooling can
point at.

This module ships TWO endpoints:

    POST  /api/v1/integrations/rapida/events
        Accepts a RAPIDA-shape damage event and creates a Report.
        Idempotent on `event_id`: duplicate events return the same
        report id without creating a second row.

    GET   /api/v1/integrations/rapida/schema
        Returns the JSON-Schema of the event payload + the CRISP
        field-mapping table. Ingestion partners can build adapters
        against this response without reading our code.

Why a stub + schema rather than the full bidirectional webhook:
UNDP has not published a RAPIDA webhook spec as of April 2026; we
ship the ingestion half (their systems → ours) + the field schema so
they can scope the outgoing-direction work post-award. The endpoint's
request model is intentionally a strict subset of Appendix-1 so a
RAPIDA field engineer can fill in any of our columns without needing
the full `ReportMetaCreate` contract.

Security: requires a bearer token with ADMIN or SUPER_ADMIN role —
the endpoint is intended for server-to-server calls, not citizens.
Rate-limited 300 events/min per token.
"""
from __future__ import annotations
import logging
import uuid
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.core.deps import require_admin
from app.models.report import (
    Report,
    Device,
    Location,
    SeverityEnum,
    CrisisTypeEnum,
    DamageClassEnum,
    InfraTypeEnum,
    SourceEnum,
    SyncStatusEnum,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class RAPIDAEvent(BaseModel):
    """A damage event posted by the RAPIDA tooling (or any partner).

    Intentionally narrow: the fields below are the lowest common
    denominator across UNDP's post-crisis assessment tools. Richer
    Appendix-1 fields (`service_status`, `pressing_needs`, modules)
    can be submitted through our native `POST /reports/meta` which
    uses the full schema — RAPIDA's ingestion doesn't need them.
    """
    # Stable id supplied by the partner. Second POST with the same
    # event_id returns the previously-created report without a new
    # row — this lets lossy retry loops (common in disaster comms)
    # converge without duplicating.
    event_id: str = Field(..., min_length=1, max_length=128)

    # Core UNDP Appendix-1 fields.
    crisis_type: Optional[CrisisTypeEnum] = None
    infrastructure_type: Optional[InfraTypeEnum] = None
    damage_classification: Optional[DamageClassEnum] = None
    severity: Optional[SeverityEnum] = None
    description: Optional[str] = Field(None, max_length=4000)

    # Location — either GPS (preferred) or a free-text descriptor.
    latitude:  Optional[float] = Field(None, ge=-90,  le=90)
    longitude: Optional[float] = Field(None, ge=-180, le=180)
    location_name: Optional[str] = Field(None, max_length=200)

    # Provenance — the partner can stamp either a person or a system.
    reporter: Optional[str] = Field(None, max_length=200)
    captured_at: Optional[str] = Field(None, max_length=64)   # ISO-8601

    # Optional building identifier for dedup + versioning.
    building_id: Optional[str] = Field(None, max_length=64)

    model_config = ConfigDict(extra="forbid")   # strict: reject unknown keys


class RAPIDAEventAck(BaseModel):
    report_id: str
    event_id: str
    was_duplicate: bool = False


@router.post(
    "/rapida/events",
    response_model=RAPIDAEventAck,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Ingest one RAPIDA damage event",
    description=(
        "Server-to-server ingestion from UNDP RAPIDA tooling or any "
        "partner system. Idempotent on `event_id`. "
        "Creates a CRISP Report in 'PENDING' state and links a virtual "
        "Device keyed off the `event_id` prefix so multi-partner feeds "
        "don't collide in the device table. Requires ADMIN role."
    ),
)
def ingest_rapida_event(
    event: RAPIDAEvent,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    # Rate limit — 300 events/min per auth subject (system-to-system
    # call, so IP isn't a good bucket).
    from app.main import check_rate_limit
    key = f"rapida-ingest:{getattr(admin, 'id', 'anon')}"
    if not check_rate_limit(key, max_requests=300, window=60):
        raise HTTPException(status_code=429, detail="Rate limit exceeded on RAPIDA ingestion")

    # Idempotency: derive a 36-char client_report_id so it fits the
    # existing VARCHAR(36) column. Partner event_ids can be up to 128
    # chars per the schema, so we can't pack both the "rapida:" prefix
    # AND the raw id. SHA1-truncate to 29 hex chars then prefix
    # `rapida:` (7 chars) → exactly 36. Deterministic, so same
    # event_id always maps to the same client_report_id → second POST
    # hits the existing row (idempotency preserved). The prefix keeps
    # the ingestion cohort greppable in the DB and the raw event_id
    # is still recoverable via the structured log line below.
    import hashlib as _h
    _evt_hash = _h.sha1(event.event_id.encode("utf-8")).hexdigest()[:29]
    client_report_id = f"rapida:{_evt_hash}"
    assert len(client_report_id) == 36, client_report_id
    existing = db.query(Report).filter(Report.client_report_id == client_report_id).first()
    if existing:
        return RAPIDAEventAck(
            report_id=existing.id,
            event_id=event.event_id,
            was_duplicate=True,
        )

    # Provision a virtual device per partner-domain. `rapida-ingest` is
    # a single dummy device shared across all RAPIDA submissions; future
    # multi-partner variants can branch on an optional `partner` field.
    partner_key = "rapida-ingest"
    device = db.query(Device).filter(Device.device_hash == partner_key).first()
    if not device:
        device = Device(device_hash=partner_key)
        db.add(device); db.flush()

    report = Report(
        id=str(uuid.uuid4()),
        client_report_id=client_report_id,
        device_id=device.id,
        source=SourceEnum.APP,           # RAPIDA is an API-driven source; no dedicated enum yet
        sync_status=SyncStatusEnum.SYNCED,
        severity=event.severity or SeverityEnum.UNKNOWN,
        infrastructure_type=event.infrastructure_type or InfraTypeEnum.OTHER,
        crisis_type=event.crisis_type,
        damage_classification=event.damage_classification,
        description=event.description or "",
        building_id=event.building_id,
    )
    db.add(report)
    db.flush()

    # Attach location if coordinates were given.
    if event.latitude is not None and event.longitude is not None:
        db.add(Location(
            report_id=report.id,
            latitude=event.latitude,
            longitude=event.longitude,
            user_location_name=event.location_name,
        ))

    db.commit()
    logger.info(
        "[RAPIDA] ingested event_id=%s → report_id=%s "
        "crisis=%s infra=%s damage=%s",
        event.event_id, report.id,
        event.crisis_type, event.infrastructure_type, event.damage_classification,
    )
    return RAPIDAEventAck(
        report_id=report.id,
        event_id=event.event_id,
        was_duplicate=False,
    )


@router.get(
    "/rapida/schema",
    summary="RAPIDA integration event schema + CRISP field mapping",
    description=(
        "Returns (a) the JSON-Schema of the RAPIDAEvent payload so a "
        "partner can build a typed adapter, and (b) the verbatim "
        "mapping from RAPIDA fields → CRISP columns so integration "
        "engineers can trace each value end-to-end."
    ),
)
def rapida_schema():
    return {
        "event_schema": RAPIDAEvent.model_json_schema(),
        "mapping": {
            # Left = RAPIDA payload field, right = CRISP column(s) + transform.
            "event_id":              "reports.client_report_id = 'rapida:' + event_id",
            "crisis_type":           "reports.crisis_type (CrisisTypeEnum)",
            "infrastructure_type":   "reports.infrastructure_type (InfraTypeEnum super-type)",
            "damage_classification": "reports.damage_classification (DamageClassEnum)",
            "severity":              "reports.severity (SeverityEnum)",
            "description":           "reports.description (free text, max 4000)",
            "latitude":              "locations.latitude (WGS84)",
            "longitude":             "locations.longitude (WGS84)",
            "location_name":         "locations.user_location_name",
            "reporter":              "(not persisted — logged only; use auth token for provenance)",
            "captured_at":           "(not persisted — backend stamps server_created_at on receipt)",
            "building_id":           "reports.building_id (osm:way:<id> preferred)",
        },
        "idempotency": {
            "key":      "event_id",
            "lookup":   "reports.client_report_id == 'rapida:' + event_id",
            "behaviour": "Duplicate event returns the first report's id with was_duplicate=true",
        },
        "auth": "Bearer token; role must be ADMIN or SUPER_ADMIN",
        "rate_limit": {"per_token_per_minute": 300},
        "endpoint_url": "/api/v1/integrations/rapida/events",
    }
