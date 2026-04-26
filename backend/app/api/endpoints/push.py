"""Web Push subscription endpoints.

Three endpoints:
  • GET    /api/v1/push/vapid-public      → returns the VAPID public key
                                              the PWA needs to subscribe.
                                              Public, unauthenticated.
  • POST   /api/v1/push/subscribe         → upserts a PushSubscription row.
                                              Optional JWT — if present,
                                              the row also stores user_id.
  • POST   /api/v1/push/unsubscribe       → removes a row by endpoint URL.
                                              Public — endpoint URL is itself
                                              the access token (provider-issued,
                                              hard to guess). Worst-case
                                              authorisation gap is "someone
                                              else silences my notifications,"
                                              not data exposure.

The reporter identity for a subscription comes from two sources:
  1. `device_hash` in the request body (always set; PWA's stable
     localStorage device id, e.g. "DEV-XXXXXXXX").
  2. `user_id` from the optional JWT (set when reporter is logged in).
At least one must resolve, enforced by the model's CHECK constraint.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.deps import get_optional_user
from app.db.session import get_db
from app.models.auth import User
from app.schemas.push import (
    PushSubscriptionCreate,
    PushSubscriptionDelete,
    PushSubscriptionResponse,
    VapidPublicKeyResponse,
)
from app.services import push as push_service

router = APIRouter()


@router.get("/vapid-public", response_model=VapidPublicKeyResponse)
def get_vapid_public_key():
    """Return the deployment's VAPID public key for use with PushManager.subscribe().

    No auth: the public key is, by design, public. The PWA fetches it
    once at startup and passes it to the browser as `applicationServerKey`.

    `enabled: false` signals to the PWA that push is not configured on
    this deployment — the client should skip the permission prompt
    entirely instead of subscribing against a useless key.
    """
    return VapidPublicKeyResponse(
        key=push_service.settings.VAPID_PUBLIC_KEY or "",
        enabled=push_service._vapid_configured(),
    )


@router.post(
    "/subscribe",
    response_model=PushSubscriptionResponse,
    status_code=status.HTTP_201_CREATED,
)
def subscribe(
    payload: PushSubscriptionCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Upsert a Web Push subscription for this reporter.

    Idempotent on `endpoint`: a repeat subscribe from the same browser
    updates the row's keys + identity rather than inserting a duplicate.
    Returns 201 on either insert or update — the client doesn't care
    which happened, only that the server now has a current subscription.
    """
    # Identity resolution: prefer JWT user_id when present; fall back to
    # the device_hash from the body. At least one must be set or the
    # service raises ValueError (mapped to 400 below).
    user_id = current_user.id if current_user else (payload.user_id or None)
    device_hash = payload.device_hash

    if not (user_id or device_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "no_identity",
                    "message": "Push subscription requires a device_hash or authenticated user."},
        )

    # `Accept-Language` from the browser is a sensible default for the
    # subscription's locale (so the SW can render notifications in the
    # right language) — but only the first tag.
    locale_hdr = request.headers.get("accept-language", "") or ""
    locale = locale_hdr.split(",")[0].split(";")[0].strip() or None
    user_agent = request.headers.get("user-agent")

    try:
        sub = push_service.upsert_subscription(
            db,
            endpoint=payload.endpoint,
            p256dh_key=payload.keys.p256dh,
            auth_key=payload.keys.auth,
            device_hash=device_hash,
            user_id=user_id,
            user_agent=user_agent,
            locale=payload.locale or locale,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "no_identity", "message": str(e)})

    return PushSubscriptionResponse.model_validate(sub)


@router.post("/unsubscribe", status_code=status.HTTP_200_OK)
def unsubscribe(payload: PushSubscriptionDelete, db: Session = Depends(get_db)):
    """Remove a subscription by endpoint URL.

    Returns `{"deleted": true|false}` so the client can distinguish
    "I unsubscribed, server confirmed" from "subscription was already
    gone." Idempotent — re-calling on a missing endpoint returns
    `{"deleted": false}` rather than 404, because the desired state
    (no subscription) is already met.
    """
    deleted = push_service.delete_subscription_by_endpoint(db, payload.endpoint)
    return {"deleted": deleted}
