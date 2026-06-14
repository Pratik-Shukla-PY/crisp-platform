"""
Admin CRUD + refresh for hot-region snapshots.

Phase 5.1 (May 2026, docs/NEARBY_REPORTS_PIPELINE.md §9.5). Pairs with
the model + helper service + migration 0026.

Endpoints (all require_admin):

  GET    /api/v1/admin/nearby/hot-regions
         List every configured region with a freshness summary.

  POST   /api/v1/admin/nearby/hot-regions
         Create a new region. Body: { name, centre_lat, centre_lng,
         radius_km, refresh_interval_min }.

  PATCH  /api/v1/admin/nearby/hot-regions/{name}
         Update region settings (centre / radius / interval / enabled).

  DELETE /api/v1/admin/nearby/hot-regions/{name}
         Remove a region. Its snapshot is dropped with it.

  POST   /api/v1/admin/nearby/hot-regions/{name}/refresh
         Force an immediate refresh of one region's snapshot. The
         actual /nearby aggregation runs synchronously - fine for an
         admin button click. The scheduled per-interval refresh is
         left to the operator's job runner (cron / Celery beat /
         docker-compose timer).

Out of scope: a built-in cron loop. Different deployments use different
schedulers; CRISP doesn't ship one. The README that lands with this
endpoint documents the suggested cron line.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.deps import require_admin
from app.db.session import get_db
from app.models.report import NearbyHotRegion
from app.services.hot_regions import (
    is_snapshot_fresh, store_snapshot, is_hot_regions_enabled,
)


router = APIRouter()


# ── Pydantic I/O ────────────────────────────────────────────────────

class HotRegionIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=64,
                      pattern=r"^[a-z0-9_-]+$")
    centre_lat: float = Field(..., ge=-90.0, le=90.0)
    centre_lng: float = Field(..., ge=-180.0, le=180.0)
    radius_km: float = Field(5.0, gt=0.0, le=200.0)
    refresh_interval_min: int = Field(15, ge=1, le=240)
    is_enabled: bool = True


class HotRegionPatch(BaseModel):
    centre_lat: Optional[float] = Field(None, ge=-90.0, le=90.0)
    centre_lng: Optional[float] = Field(None, ge=-180.0, le=180.0)
    radius_km: Optional[float] = Field(None, gt=0.0, le=200.0)
    refresh_interval_min: Optional[int] = Field(None, ge=1, le=240)
    is_enabled: Optional[bool] = None


class HotRegionOut(BaseModel):
    id: str
    name: str
    centre_lat: float
    centre_lng: float
    radius_km: float
    refresh_interval_min: int
    is_enabled: bool
    refreshed_at: Optional[datetime]
    snapshot_age_seconds: Optional[float]
    snapshot_fresh: bool


def _to_out(r: NearbyHotRegion) -> HotRegionOut:
    age_s: Optional[float] = None
    if r.refreshed_at is not None:
        refreshed = r.refreshed_at
        if refreshed.tzinfo is None:
            refreshed = refreshed.replace(tzinfo=timezone.utc)
        age_s = (datetime.now(timezone.utc) - refreshed).total_seconds()
    return HotRegionOut(
        id=r.id,
        name=r.name,
        centre_lat=r.centre_lat,
        centre_lng=r.centre_lng,
        radius_km=r.radius_km,
        refresh_interval_min=r.refresh_interval_min,
        is_enabled=r.is_enabled,
        refreshed_at=r.refreshed_at,
        snapshot_age_seconds=age_s,
        snapshot_fresh=is_snapshot_fresh(r),
    )


# ── Endpoints ──────────────────────────────────────────────────────

@router.get("", response_model=list[HotRegionOut])
def list_hot_regions(
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    rows = db.query(NearbyHotRegion).order_by(NearbyHotRegion.name).all()
    return [_to_out(r) for r in rows]


@router.post("", response_model=HotRegionOut, status_code=201)
def create_hot_region(
    body: HotRegionIn = Body(...),
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    exists = (
        db.query(NearbyHotRegion)
          .filter(NearbyHotRegion.name == body.name)
          .first()
    )
    if exists is not None:
        raise HTTPException(
            status_code=409,
            detail={"code": "region_name_taken", "name": body.name},
        )
    region = NearbyHotRegion(
        name=body.name,
        centre_lat=body.centre_lat,
        centre_lng=body.centre_lng,
        radius_km=body.radius_km,
        refresh_interval_min=body.refresh_interval_min,
        is_enabled=body.is_enabled,
    )
    db.add(region)
    db.commit()
    db.refresh(region)
    return _to_out(region)


@router.patch("/{name}", response_model=HotRegionOut)
def update_hot_region(
    name: str,
    body: HotRegionPatch = Body(...),
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    region = (
        db.query(NearbyHotRegion)
          .filter(NearbyHotRegion.name == name)
          .first()
    )
    if region is None:
        raise HTTPException(status_code=404, detail="region not found")
    # Apply only the fields the patch supplied.
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(region, k, v)
    # Any geometry change invalidates the snapshot - drop it so the
    # next read goes live until refresh.
    if any(k in data for k in ("centre_lat", "centre_lng", "radius_km")):
        region.snapshot_json = None
        region.refreshed_at = None
    db.commit()
    db.refresh(region)
    return _to_out(region)


@router.delete("/{name}", status_code=204)
def delete_hot_region(
    name: str,
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    region = (
        db.query(NearbyHotRegion)
          .filter(NearbyHotRegion.name == name)
          .first()
    )
    if region is None:
        raise HTTPException(status_code=404, detail="region not found")
    db.delete(region)
    db.commit()
    return Response(status_code=204)


@router.post("/{name}/refresh", response_model=HotRegionOut)
def refresh_hot_region(
    name: str,
    db: Session = Depends(get_db),
    _user = Depends(require_admin),
):
    """Force an immediate aggregator run + snapshot rewrite. Uses the
    region's centre + radius as the /nearby parameters. Synchronous
    - fine for the admin "Refresh now" button; per-interval refresh
    is the operator's job runner's responsibility."""
    region = (
        db.query(NearbyHotRegion)
          .filter(NearbyHotRegion.name == name)
          .first()
    )
    if region is None:
        raise HTTPException(status_code=404, detail="region not found")
    if not region.is_enabled:
        raise HTTPException(status_code=409, detail="region is disabled")

    # Late-bind the aggregator entry point to avoid an import cycle
    # (reports.py imports services.hot_regions; services.hot_regions
    # would otherwise need to import reports.py for the aggregator).
    from app.api.endpoints.reports import _aggregate_nearby_for_region

    try:
        snapshot = _aggregate_nearby_for_region(
            db,
            lat=region.centre_lat,
            lng=region.centre_lng,
            radius_km=region.radius_km,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "refresh_failed", "message": str(e)},
        )

    store_snapshot(region, snapshot, db)
    db.commit()
    db.refresh(region)
    return _to_out(region)


@router.get("/status")
def hot_regions_status(_user = Depends(require_admin)):
    """Convenience: is the /nearby read path consuming snapshots?"""
    return {"hot_regions_read_enabled": is_hot_regions_enabled()}
