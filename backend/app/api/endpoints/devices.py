"""
Device telemetry capture — Phase 5.1 (May 2026,
docs/NEARBY_REPORTS_PIPELINE.md §6.2).

Upgrades the Phase-5 emulator_farm detector from a UA-substring scaffold
to a real telemetry-driven check. The PWA / RN client posts a compact
summary on app boot; the async batch worker reads it and scores
emulator likelihood.

Endpoint:

  POST /api/v1/devices/telemetry
       Body: { device_hash, summary: { ... } }
       Upserts the summary on the matching Device row. Creates the
       Device row on first contact (anonymous registration is allowed
       per UNDP must-have #9). Returns 200 with { ok: true } on
       success.

       Auth-free by design — devices need to post before the user has
       any account. The Device.device_hash is the per-install opaque
       identifier; abuse is bounded by the per-IP rate limit applied at
       the nginx tier in production. In development the endpoint accepts
       any device_hash.

PRIVACY (UNDP must-have #7):

  The accepted summary shape is strictly a behaviour distillation:
  - Booleans (accel_active, battery_present, charging)
  - Coarse numerics (battery_level rounded to 10 %, screen_dpr,
    screen_w, screen_h)
  - Truncated strings (webgl_renderer ≤ 64 chars, timezone, locale,
    platform_ua ≤ 200 chars)
  No raw sensor streams, no GPS, no PII. The detector reads only
  these fields. Anything not in the allow-list is silently dropped
  before storage.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.report import Device


router = APIRouter()


# Allow-list of summary keys the backend will persist. Anything outside
# this set is dropped silently so a future client roll-out can't
# accidentally start storing PII on the device row.
_ALLOWED_SUMMARY_KEYS: frozenset[str] = frozenset({
    "accel_active",       # bool
    "battery_present",    # bool
    "battery_charging",   # bool
    "battery_level",      # int, 0-100 (rounded to 10-percent buckets)
    "screen_dpr",         # float, device pixel ratio
    "screen_w",           # int, CSS width
    "screen_h",           # int, CSS height
    "webgl_renderer",     # str, truncated to 64 chars
    "timezone",           # str, IANA tz id (e.g. "Asia/Kolkata")
    "locale",             # str (e.g. "en-IN")
    "platform_ua",        # str, truncated to 200 chars
    "collected_at",       # str, client ISO timestamp
})


class TelemetryIn(BaseModel):
    """Request body for POST /devices/telemetry. The `summary` dict is
    permissive (Any) at the Pydantic layer so a future client can add a
    new probe without the backend rejecting the request — keys outside
    the allow-list are filtered at storage time."""
    device_hash: str = Field(..., min_length=4, max_length=255)
    summary: dict[str, Any] = Field(default_factory=dict)


def _sanitise_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """Drop unknown keys, truncate over-long strings, coarsen numerics.
    Returns a fresh dict so the caller's input isn't mutated."""
    out: dict[str, Any] = {}
    for k, v in raw.items():
        if k not in _ALLOWED_SUMMARY_KEYS:
            continue
        if k == "webgl_renderer" and isinstance(v, str):
            out[k] = v[:64]
        elif k == "platform_ua" and isinstance(v, str):
            out[k] = v[:200]
        elif k == "timezone" and isinstance(v, str):
            out[k] = v[:64]
        elif k == "locale" and isinstance(v, str):
            out[k] = v[:16]
        elif k == "battery_level" and isinstance(v, (int, float)):
            # Coarsen to 10-percent buckets — keeps the signal useful
            # for the "emulator-stuck-at-100" check while reducing the
            # fingerprint resolution.
            clamped = max(0, min(100, int(v)))
            out[k] = (clamped // 10) * 10
        elif isinstance(v, (bool, int, float, str)) or v is None:
            out[k] = v
        # Anything else (nested dicts, lists) is dropped silently.
    # Always stamp server time so a stale client clock can't make the
    # row look fresh.
    out["server_received_at"] = datetime.now(timezone.utc).isoformat()
    return out


@router.post("/telemetry")
def post_device_telemetry(
    body: TelemetryIn = Body(...),
    db: Session = Depends(get_db),
):
    """Upsert telemetry summary on the device row. Auth-free per the
    module docstring — abuse is bounded by per-IP rate limits at the
    nginx tier. Creates the Device row on first contact.

    Returns 200 with `{ok: true}` for both upsert paths. 422 is the
    only failure mode (Pydantic rejecting a malformed body)."""
    summary = _sanitise_summary(body.summary)
    dev = (
        db.query(Device)
          .filter(Device.device_hash == body.device_hash)
          .first()
    )
    # Device.platform is String(50); summary.platform_ua is truncated to
    # 200 above. Truncate again to fit the column. Keep the FULL value
    # in telemetry_summary.platform_ua for the detector to read.
    platform_short = (summary.get("platform_ua") or "")[:50]
    if dev is None:
        # Anonymous device registration is OK (UNDP must-have #9).
        dev = Device(
            device_hash=body.device_hash,
            platform=platform_short,
            telemetry_summary=summary,
        )
        db.add(dev)
    else:
        dev.telemetry_summary = summary
        # Backfill `platform` if it wasn't set on first registration —
        # purely a quality-of-life improvement so admin tooling shows
        # a non-empty platform string.
        if not dev.platform and platform_short:
            dev.platform = platform_short
    db.commit()
    return {"ok": True, "device_id": dev.id}
