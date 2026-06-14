"""Single-org identity / branding configuration.

CRISP is a SINGLE-organisation platform - there is no tenant concept. This is
the one deploying organisation's settings (name, branding, contact), editable by
an admin via the dashboard's Organisation Settings module.

Persisted as a JSON blob through the storage abstraction's internal store
(``save_internal``/``read_internal``) - NO database table, NO migration. The
logo rides the same internal store and is served back through a dedicated
backend route (never a presigned/public URL). Works identically on local disk
and S3.
"""
import json
import logging
from typing import Any, Dict

from app.services.storage import get_storage

logger = logging.getLogger(__name__)

_CONFIG_KEY = "org-config/config.json"

# Editable, public-safe branding fields + their defaults. An admin PATCH may
# only set keys in this set; internal bookkeeping keys (logo_key, content_type,
# updated_at) are managed server-side and are never client-writable.
_DEFAULTS: Dict[str, Any] = {
    "org_name": "CRISP",
    "org_public_name": "UN Crisis Command",
    "org_contact_email": "",
    "org_support_url": "",
    "org_primary_color": "#7c5cff",
    "org_default_language": "en",
    "org_region": "",
}
EDITABLE_KEYS = set(_DEFAULTS.keys())
# Public-safe keys surfaced on the unauthenticated GET /config branding block.
_PUBLIC_KEYS = set(_DEFAULTS.keys())


def read_org_config() -> Dict[str, Any]:
    """Stored config merged over defaults. Never raises - falls back to defaults
    so the public GET /config can never 500 on a missing/corrupt blob."""
    cfg = dict(_DEFAULTS)
    try:
        raw = get_storage().read_internal(_CONFIG_KEY)
        if raw:
            stored = json.loads(raw.decode("utf-8"))
            if isinstance(stored, dict):
                cfg.update(stored)
    except FileNotFoundError:
        pass  # first run - no blob saved yet
    except Exception as exc:  # noqa: BLE001 - fail-safe to defaults
        logger.warning("org_config read failed, using defaults: %s", exc)
    return cfg


def write_org_config(updates: Dict[str, Any]) -> Dict[str, Any]:
    """Merge editable keys from ``updates`` into the stored config + persist.
    Returns the full merged config. Raises on a storage write failure (the
    PATCH route surfaces that to the admin)."""
    cfg = read_org_config()
    for key, val in (updates or {}).items():
        if key in EDITABLE_KEYS:
            cfg[key] = val
    _persist(cfg)
    return cfg


def set_logo(logo_key: str, content_type: str, updated_at: str) -> Dict[str, Any]:
    """Record an uploaded logo's internal key + content-type + version stamp."""
    cfg = read_org_config()
    cfg["org_logo_key"] = logo_key
    cfg["org_logo_content_type"] = content_type
    cfg["org_logo_updated_at"] = updated_at
    _persist(cfg)
    return cfg


def public_org_block() -> Dict[str, Any]:
    """The public-safe branding subset for the unauthenticated GET /config.
    Includes a stable logo route (cache-busted) when a logo is set; never
    exposes internal storage keys."""
    cfg = read_org_config()
    block = {k: cfg.get(k, _DEFAULTS.get(k)) for k in _PUBLIC_KEYS}
    if cfg.get("org_logo_key"):
        stamp = cfg.get("org_logo_updated_at", "")
        block["org_logo_url"] = "/api/v1/config/org/logo" + (f"?v={stamp}" if stamp else "")
    else:
        block["org_logo_url"] = None
    return block


def _persist(cfg: Dict[str, Any]) -> None:
    get_storage().save_internal(
        _CONFIG_KEY, json.dumps(cfg).encode("utf-8"), content_type="application/json"
    )
