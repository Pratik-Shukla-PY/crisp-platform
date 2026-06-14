"""
Deployment-config endpoint + single-org identity/branding settings.

The GET /config document carries deployment-tunable flags the PWA + RN clients
read once at boot (always unauthenticated, 5-min cacheable). As of B6 it also
carries a public ``org`` branding block (name, colour, logo URL) for the single
deploying organisation.

The org settings are editable by an admin via the dashboard Organisation
Settings module: GET/PATCH /config/org + POST/GET /config/org/logo. They are
persisted as a JSON blob through the storage abstraction (see
``app.services.org_config``) - NO database table, NO migration. CRISP is a
single-organisation platform; there is no tenant concept here.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import require_admin
from app.models.auth import User
from app.services import org_config
from app.services.storage import get_storage


router = APIRouter()

_LOGO_KEY = "org-config/logo"
_LOGO_MAX_BYTES = 2 * 1024 * 1024  # 2 MB
_LOGO_TYPES = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/svg+xml": "svg",
}


class OrgConfigUpdate(BaseModel):
    """Admin-editable org branding fields (all optional → partial update)."""
    org_name: Optional[str] = Field(None, max_length=120)
    org_public_name: Optional[str] = Field(None, max_length=160)
    org_contact_email: Optional[str] = Field(None, max_length=200)
    org_support_url: Optional[str] = Field(None, max_length=300)
    org_primary_color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    org_default_language: Optional[str] = Field(None, max_length=8)
    org_region: Optional[str] = Field(None, max_length=120)


@router.get("/")
def get_config(response: Response) -> dict:
    """Return deployment-tunable client flags + org branding.

    `no-cache` (revalidate every load) rather than the old 5-min cache: this
    blob carries org BRANDING (name/colour/logo), which must be authoritative.
    The old `max-age=300` made the Home/shell show a STALE org name for up to
    5 minutes after an admin saved it (while the admin panel, which uses
    `no-store`, showed the new value) - the "saved successfully but reverts on
    navigation" report. The payload is tiny and fetched once per page load, so
    revalidation cost is negligible."""
    response.headers["Cache-Control"] = "no-cache"
    return {
        "nearby": {
            "citizen_t1_visibility": settings.CRISP_CITIZEN_T1_VISIBILITY,
            "density_buckets": {
                "pins": settings.CRISP_DENSITY_BUCKETS_PINS,
                "clusters": settings.CRISP_DENSITY_BUCKETS_CLUSTERS,
            },
            "disaster_mode_threshold": {
                "groups": settings.CRISP_DISASTER_MODE_GROUPS,
                "reports": settings.CRISP_DISASTER_MODE_REPORTS,
            },
        },
        "push": {
            "frequency_cap_per_user_per_hour":
                settings.CRISP_PUSH_FREQUENCY_CAP_PER_USER_PER_HOUR,
        },
        "geotag": {
            "watermark_enabled": settings.CRISP_GEOTAG_WATERMARK_ENABLED,
            "exif_enabled": settings.CRISP_GEOTAG_EXIF_ENABLED,
        },
        # B6 - single-org identity/branding (public-safe subset).
        "org": org_config.public_org_block(),
    }


# ── Organisation settings (single-org; admin-edited, config-blob backed) ──────

@router.get("/org")
def get_org_settings(response: Response, admin: User = Depends(require_admin)) -> dict:
    """Admin: the current org branding for editing (uncached)."""
    response.headers["Cache-Control"] = "no-store"
    return org_config.public_org_block()


@router.patch("/org")
def update_org_settings(req: OrgConfigUpdate, admin: User = Depends(require_admin)) -> dict:
    """Admin: update org branding (partial). Returns the merged branding."""
    org_config.write_org_config(req.model_dump(exclude_none=True))
    return org_config.public_org_block()


@router.post("/org/logo")
async def upload_org_logo(
    response: Response,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
) -> dict:
    """Admin: upload the org logo (PNG/JPEG/WebP/SVG, ≤ 2 MB). Stored via the
    storage abstraction's internal namespace; served back from GET /org/logo."""
    ctype = (file.content_type or "").lower()
    if ctype not in _LOGO_TYPES:
        raise HTTPException(status_code=400,
                            detail="Logo must be PNG, JPEG, WebP or SVG.")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(data) > _LOGO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Logo must be ≤ 2 MB.")
    get_storage().save_internal(_LOGO_KEY, data, content_type=ctype)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    org_config.set_logo(_LOGO_KEY, ctype, stamp)
    return org_config.public_org_block()


@router.get("/org/logo")
def get_org_logo() -> Response:
    """Serve the org logo bytes (public - branding is not a secret)."""
    cfg = org_config.read_org_config()
    key = cfg.get("org_logo_key")
    if not key:
        raise HTTPException(status_code=404, detail="No logo set.")
    try:
        data = get_storage().read_internal(key)
    except Exception:
        raise HTTPException(status_code=404, detail="Logo not found.")
    return Response(
        content=data,
        media_type=cfg.get("org_logo_content_type", "application/octet-stream"),
        headers={"Cache-Control": "public, max-age=3600"},
    )
