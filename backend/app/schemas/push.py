"""Pydantic schemas for the Web Push subscription API."""
from typing import Optional
from pydantic import BaseModel, Field, ConfigDict


class PushSubscriptionKeys(BaseModel):
    """RFC 8291 — the encryption keys the browser hands us at subscribe.

    Both are base64-url-encoded by the browser. We store them as-is
    and pass them through to pywebpush for ECIES payload encryption.
    """
    p256dh: str = Field(..., min_length=4, max_length=255,
                        description="ECDH P-256 public key (base64url)")
    auth: str = Field(..., min_length=4, max_length=255,
                      description="HMAC auth secret (base64url, 16 bytes)")


class PushSubscriptionCreate(BaseModel):
    """Request body for POST /api/v1/push/subscribe.

    Mirrors the shape of `PushSubscription.toJSON()` in the browser
    spec, so the PWA can pass it through verbatim. Identity (device_hash
    or user_id — at least one) is REQUIRED so we know who the
    subscription belongs to when a Report status changes.
    """
    endpoint: str = Field(..., min_length=10, max_length=2048)
    keys: PushSubscriptionKeys
    device_hash: Optional[str] = Field(None, min_length=1, max_length=255)
    # user_id is NOT taken from the request body in production — the
    # endpoint pulls it from the JWT when present, falling back to
    # the body for anonymous flows. Documented here for the schema.
    user_id: Optional[str] = Field(None, max_length=36)
    user_agent: Optional[str] = Field(None, max_length=500)
    locale: Optional[str] = Field(None, max_length=10)


class PushSubscriptionDelete(BaseModel):
    """Request body for POST /api/v1/push/unsubscribe.

    Just the endpoint URL — that's the natural unique key for the row.
    Anonymous reporters can unsubscribe themselves; we don't gate on
    identity because (a) the endpoint URL is itself a hard-to-guess
    secret per push provider, and (b) the worst-case "someone else
    knows my endpoint" is them silencing my own notifications.
    """
    endpoint: str = Field(..., min_length=10, max_length=2048)


class PushSubscriptionResponse(BaseModel):
    """Response shape after a successful subscribe.

    Returns the row id + the resolved identity (so the client can
    confirm the server linked it correctly). Doesn't echo the keys
    back; nothing on the client needs them.
    """
    model_config = ConfigDict(from_attributes=True)
    id: str
    endpoint: str
    device_hash: Optional[str] = None
    user_id: Optional[str] = None


class VapidPublicKeyResponse(BaseModel):
    """Response shape for GET /api/v1/push/vapid-public.

    `key` is empty when push is not configured on this deployment —
    the PWA treats an empty key as "feature off" and skips the
    permission prompt entirely.
    """
    key: str = Field(..., description="VAPID public key (URL-base64, no padding)")
    enabled: bool = Field(...,
                          description="False if VAPID is unconfigured; client should not subscribe.")
