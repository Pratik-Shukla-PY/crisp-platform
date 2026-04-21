"""
CRISP — Admin endpoints (Phase 4, Apr 2026).

Region auto-submit config:
  GET    /api/v1/regions/enabled           public  — client geofence check
  GET    /api/v1/admin/regions             admin   — full list (incl. disabled)
  POST   /api/v1/admin/regions             admin   — create
  PATCH  /api/v1/admin/regions/{id}        admin   — toggle / edit
  DELETE /api/v1/admin/regions/{id}        admin   — remove

Asymmetric auth is deliberate: clients need a cheap cacheable list of
enabled zones without authenticating (they'd be authenticating on every
"Start Report" tap otherwise); admin mutations use the existing JWT
`require_admin` dep so only authorised operators can enable / disable
an auto-submit zone.
"""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.report import AutoSubmitRegion
from app.schemas.admin import (
    RegionCreate,
    RegionUpdate,
    RegionResponse,
    RegionPublicResponse,
)
from app.core.deps import require_admin

logger = logging.getLogger(__name__)

# Two routers because the public endpoint lives on a different prefix.
admin_router = APIRouter()      # /admin/regions  — admin CRUD
public_router = APIRouter()     # /regions/...    — public read


# ── Public (unauthenticated) ────────────────────────────────────────────────

@public_router.get(
    "/enabled",
    response_model=List[RegionPublicResponse],
    summary="List every region with auto-submit enabled (public, cacheable)",
)
def list_enabled_regions(
    response: Response,
    db: Session = Depends(get_db),
):
    """Returns all regions whose `enabled=True`. Clients use this to decide
    whether to arm the 2-minute countdown on Start Report.

    Cached for 60 s via `Cache-Control`. Short enough that an admin toggle
    propagates inside two minutes without forcing clients to hammer the
    endpoint. No JWT needed — the payload leaks nothing personal.
    """
    response.headers["Cache-Control"] = "public, max-age=60"
    rows = db.query(AutoSubmitRegion).filter(AutoSubmitRegion.enabled == True).all()  # noqa: E712
    return rows


# ── Admin CRUD (JWT-gated, require_admin) ───────────────────────────────────

@admin_router.get(
    "/regions",
    response_model=List[RegionResponse],
    summary="List every auto-submit region (admin)",
)
def list_all_regions(
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    return db.query(AutoSubmitRegion).order_by(AutoSubmitRegion.created_at.desc()).all()


@admin_router.post(
    "/regions",
    response_model=RegionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new auto-submit region",
)
def create_region(
    payload: RegionCreate,
    db: Session = Depends(get_db),
    user = Depends(require_admin),
):
    region = AutoSubmitRegion(
        name=payload.name,
        enabled=payload.enabled,
        center_lat=payload.center_lat,
        center_lng=payload.center_lng,
        radius_meters=payload.radius_meters,
        created_by=user.id,
    )
    db.add(region)
    db.commit()
    db.refresh(region)
    logger.info(
        f"[AdminRegion] created id={region.id[:8]} name={region.name!r} "
        f"enabled={region.enabled} radius_m={region.radius_meters}"
    )
    return region


@admin_router.patch(
    "/regions/{region_id}",
    response_model=RegionResponse,
    summary="Update an auto-submit region (partial)",
)
def update_region(
    region_id: str,
    payload: RegionUpdate,
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    region = db.query(AutoSubmitRegion).filter(AutoSubmitRegion.id == region_id).first()
    if not region:
        raise HTTPException(status_code=404, detail="Region not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(region, k, v)
    db.commit()
    db.refresh(region)
    logger.info(f"[AdminRegion] updated id={region.id[:8]} changes={list(data.keys())}")
    return region


@admin_router.delete(
    "/regions/{region_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an auto-submit region",
)
def delete_region(
    region_id: str,
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    region = db.query(AutoSubmitRegion).filter(AutoSubmitRegion.id == region_id).first()
    if not region:
        raise HTTPException(status_code=404, detail="Region not found")
    db.delete(region)
    db.commit()
    logger.info(f"[AdminRegion] deleted id={region.id[:8]}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
