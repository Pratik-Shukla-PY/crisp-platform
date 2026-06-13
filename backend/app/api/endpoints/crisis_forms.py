"""Dynamic Crisis Forms — geo-scoped Stage 2/3 question packs.

Public:
  GET  /api/v1/crisis-forms/active?lat=&lng=        cacheable — which pack (if any)
                                                    applies at this point right now
Admin (require_admin):
  GET/POST/PATCH/DELETE  /api/v1/admin/crisis-forms/events[/{id}]
  GET/POST/PATCH         /api/v1/admin/crisis-forms/packs[/{id}]
  GET/POST               /api/v1/admin/crisis-forms/packs/{id}/versions
  POST                   /api/v1/admin/crisis-forms/packs/{id}/publish
  POST                   /api/v1/admin/crisis-forms/packs/{id}/rollback
  POST                   /api/v1/admin/crisis-forms/packs/validate   (lint, no save)

Asymmetric auth mirrors admin.py: clients hit /active without a JWT (cheap,
cacheable, leaks nothing personal); operators mutate behind require_admin.
The default report flow is untouched — /active simply returns {active:false}
for any point outside an active, in-window zone, and clients fall back to the
hardcoded Stage 2/3.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.core.deps import require_admin
from app.models.report import CrisisEvent, CrisisFormPack, CrisisFormPackVersion
from app.services.crisis_form_schema import validate_pack_schema
from app.services.nearby_aggregator import haversine_km
from app.schemas.crisis_form import (
    CrisisEventCreate, CrisisEventUpdate, CrisisEventResponse,
    CrisisFormPackCreate, CrisisFormPackUpdate, CrisisFormPackResponse,
    CrisisFormPackVersionCreate, CrisisFormPackVersionResponse,
    PublishRequest, SchemaLintRequest, SchemaLintResponse,
    ActiveCrisisFormResponse,
)

logger = logging.getLogger(__name__)

public_router = APIRouter()   # /crisis-forms
admin_router = APIRouter()    # /admin/crisis-forms


def resolve_active_event(db: Session, lat: float, lng: float, now: datetime):
    """Return (CrisisEvent, CrisisFormPack, CrisisFormPackVersion) for the
    crisis whose circle contains (lat, lng) right now, or None.

    Single source of truth for "which active crisis applies at this point" —
    used both by the public `/active` endpoint (so clients render the right
    Stage 2/3 pack) and by report intake (so the server can derive/verify
    `report.crisis_event_id`). Keeping both callers on the same matcher means a
    client's `/active` answer and the server's intake-time derivation can never
    disagree.

    Matching rule (unchanged): among `is_active` events, newest-activation-first
    (a more recent activation wins when zones overlap); skip events with no pack,
    not yet started, or already ended; the event's circle must contain the point
    (haversine ≤ radius_km); the pack must be un-archived with a *published*
    active version. First match wins.
    """
    events = (db.query(CrisisEvent)
              .filter(CrisisEvent.is_active == True)  # noqa: E712
              .order_by(CrisisEvent.created_at.desc())
              .all())
    for ev in events:
        if not ev.form_pack_id:
            continue
        if ev.started_at and ev.started_at > now:
            continue
        if ev.ended_at and ev.ended_at < now:
            continue
        try:
            dist = haversine_km(lat, lng, ev.center_lat, ev.center_lng)
        except (TypeError, ValueError):
            continue
        if dist <= (ev.radius_km or 0):
            pack = (db.query(CrisisFormPack)
                    .filter(CrisisFormPack.id == ev.form_pack_id,
                            CrisisFormPack.is_archived == False)  # noqa: E712
                    .first())
            if not pack or not pack.active_version:
                continue
            ver = (db.query(CrisisFormPackVersion)
                   .filter(CrisisFormPackVersion.pack_id == pack.id,
                           CrisisFormPackVersion.version == pack.active_version,
                           CrisisFormPackVersion.status == "published")
                   .first())
            if not ver:
                continue
            return (ev, pack, ver)
    return None


# ── Public: which crisis form applies at this point, right now? ─────────────
@public_router.get(
    "/active",
    response_model=ActiveCrisisFormResponse,
    summary="Active crisis form pack for a lat/lng (public, cacheable)",
)
def active_crisis_form(
    response: Response,
    request: Request,
    lat: float = Query(...),
    lng: float = Query(...),
    db: Session = Depends(get_db),
):
    """Returns the published pack of the first ACTIVE, in-window CrisisEvent whose
    circle contains (lat,lng); else {active:false}. Clients call this after the
    Stage-1 location fix and render the pack for Stage 2/3 — or fall back to the
    default flow when inactive. 60 s cache + ETag (zones change rarely)."""
    now = datetime.now(timezone.utc)
    match = resolve_active_event(db, lat, lng, now)

    response.headers["Cache-Control"] = "public, max-age=60"
    if not match:
        body = ActiveCrisisFormResponse(active=False)
        response.headers["ETag"] = '"none"'
        return body
    ev, pack, ver = match
    etag = '"' + hashlib.md5(f"{ev.id}:{pack.id}:{ver.version}".encode()).hexdigest() + '"'
    if request.headers.get("if-none-match") == etag:
        response.status_code = status.HTTP_304_NOT_MODIFIED
        response.headers["ETag"] = etag
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=dict(response.headers))
    response.headers["ETag"] = etag
    return ActiveCrisisFormResponse(
        active=True, event_id=ev.id, event_name=ev.name, crisis_type=ev.crisis_type,
        pack_id=pack.id, pack_version=ver.version, schema_json=ver.schema_json,
    )


# ── Admin: Crisis Events CRUD ───────────────────────────────────────────────
@admin_router.get("/events", response_model=List[CrisisEventResponse], summary="List crisis events (admin)")
def list_events(db: Session = Depends(get_db), _user=Depends(require_admin)):
    return db.query(CrisisEvent).order_by(CrisisEvent.created_at.desc()).all()


@admin_router.post("/events", response_model=CrisisEventResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a crisis event")
def create_event(payload: CrisisEventCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    if payload.form_pack_id:
        if not db.query(CrisisFormPack).filter(CrisisFormPack.id == payload.form_pack_id).first():
            raise HTTPException(status_code=400, detail="form_pack_id does not exist")
    ev = CrisisEvent(**payload.model_dump(), created_by=user.id)
    db.add(ev); db.commit(); db.refresh(ev)
    logger.info(f"[CrisisEvent] created id={ev.id[:8]} name={ev.name!r} active={ev.is_active} r={ev.radius_km}km")
    return ev


@admin_router.patch("/events/{event_id}", response_model=CrisisEventResponse, summary="Update a crisis event")
def update_event(event_id: str, payload: CrisisEventUpdate, db: Session = Depends(get_db), _user=Depends(require_admin)):
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Crisis event not found")
    data = payload.model_dump(exclude_unset=True)
    if data.get("form_pack_id"):
        if not db.query(CrisisFormPack).filter(CrisisFormPack.id == data["form_pack_id"]).first():
            raise HTTPException(status_code=400, detail="form_pack_id does not exist")
    for k, v in data.items():
        setattr(ev, k, v)
    db.commit(); db.refresh(ev)
    logger.info(f"[CrisisEvent] updated id={ev.id[:8]} changes={list(data.keys())}")
    return ev


@admin_router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a crisis event")
def delete_event(event_id: str, db: Session = Depends(get_db), _user=Depends(require_admin)):
    ev = db.query(CrisisEvent).filter(CrisisEvent.id == event_id).first()
    if not ev:
        raise HTTPException(status_code=404, detail="Crisis event not found")
    db.delete(ev); db.commit()
    logger.info(f"[CrisisEvent] deleted id={ev.id[:8]}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Admin: Packs ────────────────────────────────────────────────────────────
@admin_router.get("/packs", response_model=List[CrisisFormPackResponse], summary="List crisis form packs (admin)")
def list_packs(db: Session = Depends(get_db), _user=Depends(require_admin)):
    return db.query(CrisisFormPack).order_by(CrisisFormPack.created_at.desc()).all()


@admin_router.post("/packs", response_model=CrisisFormPackResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a pack")
def create_pack(payload: CrisisFormPackCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    if db.query(CrisisFormPack).filter(CrisisFormPack.key == payload.key).first():
        raise HTTPException(status_code=409, detail="pack key already exists")
    pack = CrisisFormPack(**payload.model_dump(), created_by=user.id)
    db.add(pack); db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] created id={pack.id[:8]} key={pack.key!r}")
    return pack


@admin_router.patch("/packs/{pack_id}", response_model=CrisisFormPackResponse, summary="Update a pack")
def update_pack(pack_id: str, payload: CrisisFormPackUpdate, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(pack, k, v)
    db.commit(); db.refresh(pack)
    return pack


@admin_router.get("/packs/{pack_id}/versions", response_model=List[CrisisFormPackVersionResponse],
                  summary="List a pack's versions")
def list_versions(pack_id: str, db: Session = Depends(get_db), _user=Depends(require_admin)):
    return (db.query(CrisisFormPackVersion)
            .filter(CrisisFormPackVersion.pack_id == pack_id)
            .order_by(CrisisFormPackVersion.version.desc()).all())


@admin_router.post("/packs/{pack_id}/versions", response_model=CrisisFormPackVersionResponse,
                   status_code=status.HTTP_201_CREATED, summary="Create a draft version (lints the schema)")
def create_version(pack_id: str, payload: CrisisFormPackVersionCreate,
                   db: Session = Depends(get_db), user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    errs = validate_pack_schema(payload.schema_json)
    if errs:
        raise HTTPException(status_code=400, detail={"schema_errors": errs})
    last = (db.query(CrisisFormPackVersion)
            .filter(CrisisFormPackVersion.pack_id == pack_id)
            .order_by(CrisisFormPackVersion.version.desc()).first())
    next_ver = (last.version + 1) if last else 1
    ver = CrisisFormPackVersion(pack_id=pack_id, version=next_ver,
                                schema_json=payload.schema_json, status="draft", created_by=user.id)
    db.add(ver); db.commit(); db.refresh(ver)
    logger.info(f"[CrisisPack] {pack.key} draft v{next_ver} created")
    return ver


@admin_router.post("/packs/{pack_id}/publish", response_model=CrisisFormPackResponse,
                   summary="Publish a version (demotes the prior published one)")
def publish_version(pack_id: str, payload: PublishRequest, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    ver = (db.query(CrisisFormPackVersion)
           .filter(CrisisFormPackVersion.pack_id == pack_id, CrisisFormPackVersion.version == payload.version)
           .first())
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    # demote the currently-published version (if any, and different)
    for other in db.query(CrisisFormPackVersion).filter(
            CrisisFormPackVersion.pack_id == pack_id,
            CrisisFormPackVersion.status == "published").all():
        if other.version != ver.version:
            other.status = "archived"
    ver.status = "published"
    ver.published_at = datetime.now(timezone.utc)
    pack.active_version = ver.version
    pack.is_archived = False
    db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] {pack.key} published v{ver.version} (now active)")
    return pack


@admin_router.post("/packs/{pack_id}/rollback", response_model=CrisisFormPackResponse,
                   summary="Roll back active pack to an earlier published version")
def rollback_version(pack_id: str, payload: PublishRequest, db: Session = Depends(get_db), _user=Depends(require_admin)):
    pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == pack_id).first()
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    ver = (db.query(CrisisFormPackVersion)
           .filter(CrisisFormPackVersion.pack_id == pack_id, CrisisFormPackVersion.version == payload.version)
           .first())
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    if ver.status != "published":
        # mark it published again (rollback re-activates a prior published version)
        ver.status = "published"
        if not ver.published_at:
            ver.published_at = datetime.now(timezone.utc)
    pack.active_version = ver.version
    db.commit(); db.refresh(pack)
    logger.info(f"[CrisisPack] {pack.key} rolled back to v{ver.version}")
    return pack


@admin_router.post("/packs/validate", response_model=SchemaLintResponse,
                   summary="Lint a schema_json without saving (builder preview)")
def lint_schema(payload: SchemaLintRequest, _user=Depends(require_admin)):
    errs = validate_pack_schema(payload.schema_json)
    return SchemaLintResponse(valid=not errs, errors=errs)
