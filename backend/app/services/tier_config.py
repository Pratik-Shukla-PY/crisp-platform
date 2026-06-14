"""Read the canonical tier-config from `shared/tier-config.json`.

Phase 2.1 (Badge Studio premium, May 2026) - single source of truth
for the V4 reward ladder across PWA, dashboard, RN, and backend
surfaces. JS / TS consumers read from auto-generated
`shared/tier-config.{js,ts}` (see `scripts/sync-tier-config.mjs`);
Python reads the canonical JSON directly via this module.

NOTE: server-side tier-promotion logic (the `_recompute_tier`
function in `app.api.endpoints.reports`) does NOT live in this
config - promotion thresholds are code rules (status transitions +
lives_impacted aggregation), not metadata. This file ONLY carries
display metadata (emoji / label / color / ring gradient) so the
LinkedIn-share OG meta and any future analytics readout stay in
sync with the client.
"""
from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Locate the canonical JSON. Repo layout:
#   <root>/backend/app/services/tier_config.py
#   <root>/shared/tier-config.json
_THIS_FILE = Path(__file__).resolve()
_REPO_ROOT = _THIS_FILE.parents[3]
_TIER_CONFIG_PATH = _REPO_ROOT / "shared" / "tier-config.json"


@lru_cache(maxsize=1)
def _load_config() -> dict[str, Any]:
    """Read + parse the JSON once per process.

    Failure-mode: if the file is missing or unparseable (impossible in
    a healthy deploy because the file is committed), we return an
    empty config so callers don't 500. The share endpoint already
    falls back to "Lifekeeper" hardcoded defaults - that path stays
    safe.
    """
    try:
        with _TIER_CONFIG_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning(
            "[tier_config] %s not found - falling back to empty config. "
            "Did the deploy strip shared/?",
            _TIER_CONFIG_PATH,
        )
        return {"tiers": [], "legacy_aliases": {}}
    except json.JSONDecodeError as e:
        logger.exception("[tier_config] failed to parse %s: %s", _TIER_CONFIG_PATH, e)
        return {"tiers": [], "legacy_aliases": {}}


def all_tiers() -> list[dict[str, Any]]:
    """Return the full ordered list of V4 tier dicts."""
    return [t for t in _load_config().get("tiers", []) if isinstance(t, dict)]


@lru_cache(maxsize=8)
def tier_by_id(tier_id: str) -> Optional[dict[str, Any]]:
    """Look up a single tier dict by V4 id. Returns None if unknown.

    Accepts legacy aliases (HERO, GUARDIAN, HELPER, NEWCOMER,
    CONTRIBUTOR, TRUSTED) and translates them to the V4 equivalent
    via the JSON's `legacy_aliases` table.
    """
    if not tier_id:
        return None
    cfg = _load_config()
    aliases = cfg.get("legacy_aliases", {}) or {}
    canonical = aliases.get(tier_id, tier_id)
    for t in cfg.get("tiers", []):
        if isinstance(t, dict) and t.get("id") == canonical:
            return t
    return None


def label_emoji_pair(tier_id: str) -> tuple[str, str]:
    """Return ``(emoji, label)`` for a tier id.

    Defaults to ("🦸", "Lifekeeper") if the tier is unknown - same
    fallback the pre-Phase-2.1 share endpoint used so OG rendering
    stays safe under config-load failures.
    """
    t = tier_by_id(tier_id)
    if t:
        return (str(t.get("emoji", "🦸")), str(t.get("label", "Lifekeeper")))
    return ("🦸", "Lifekeeper")
