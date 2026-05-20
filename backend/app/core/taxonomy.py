"""
UNDP RAPIDA Appendix-1 taxonomy helpers.

Central source of truth for the mappings:

  * crisis_type   → crisis_category  (Natural / Technological / Human-made)
  * ui_infra_chip → UNDP super-type  (Residential / Commercial / ...)
  * damage_classification normalisation (legacy "NO_DAMAGE" → "MINIMAL")

Keep this module pure (no DB / HTTP imports). Both the backend
endpoints and a small CLI could consume it — and the tests can assert
the mapping round-trips without a live DB.
"""
import enum as _enum
from typing import Optional


def _to_key(value) -> Optional[str]:
    """Coerce a value that may be a plain string, an enum member, or None
    into the canonical uppercase key form used by the lookup tables
    below. Python 3.11 changed ``str()`` on a ``(str, Enum)`` subclass to
    return ``"ClassName.MEMBER"`` rather than the underlying value, so
    the previous naive ``str(value).upper()`` call silently broke for
    Pydantic-validated fields."""
    if value is None:
        return None
    if isinstance(value, _enum.Enum):
        value = value.value
    return str(value).upper()


# ── Crisis ────────────────────────────────────────────────────────────────────

CRISIS_CATEGORY_OF = {
    # Natural
    "EARTHQUAKE":        "NATURAL",
    "FLOOD":             "NATURAL",
    "TSUNAMI":           "NATURAL",
    "CYCLONE":           "NATURAL",
    "HURRICANE":         "NATURAL",   # legacy alias, UNDP bundles as Cyclone
    "LANDSLIDE":         "NATURAL",
    # Technological
    "EXPLOSION":         "TECHNOLOGICAL",
    "CHEMICAL_INCIDENT": "TECHNOLOGICAL",
    "PANDEMIC":          "TECHNOLOGICAL",
    # Human-made
    "CONFLICT":          "HUMAN_MADE",
    "CIVIL_UNREST":      "HUMAN_MADE",
    # Legacy / unclassified
    "WILDFIRE":          "OTHER",
    "OTHER":             "OTHER",
}


def categorise_crisis(crisis_type) -> Optional[str]:
    """Return the UNDP Appendix-1 category for a crisis_type string.

    Accepts plain strings or enum members. None and unrecognised values
    return None — callers can then fall through to 'OTHER' or leave
    the column unset at their discretion.
    """
    key = _to_key(crisis_type)
    if not key:
        return None
    return CRISIS_CATEGORY_OF.get(key)


# ── Damage classification normalisation ───────────────────────────────────────

# UNDP spec: "Minimal/No damage", "Partially damaged", "Completely damaged".
# CRISP stored "NO_DAMAGE" historically — accept both, emit "MINIMAL" on write.
DAMAGE_ALIASES = {
    "NO_DAMAGE": "MINIMAL",
    "NONE": "MINIMAL",
    "MIN": "MINIMAL",
    "MINIMAL": "MINIMAL",
    "PARTIAL": "PARTIAL",
    "PARTIALLY_DAMAGED": "PARTIAL",
    "COMPLETE": "COMPLETE",
    "COMPLETELY_DAMAGED": "COMPLETE",
    "DESTROYED": "COMPLETE",
}


def normalise_damage(value) -> Optional[str]:
    """Map any legacy or alias damage-classification string to the three
    canonical UNDP values: MINIMAL / PARTIAL / COMPLETE.

    Accepts plain strings or enum members (the write path sees
    ``DamageClassEnum.NO_DAMAGE`` from Pydantic before SQLAlchemy
    coerces to the column type).
    """
    key = _to_key(value)
    if not key:
        return None
    return DAMAGE_ALIASES.get(key)


# ── Infrastructure taxonomy (UNDP 7 + Other) ──────────────────────────────────

# UNDP Appendix-1 super-types:
#     Residential / Commercial / Government / Utility /
#     Transport_Communication / Community / Public_Spaces / Other
UNDP_INFRA_TYPES = {
    "RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY",
    "TRANSPORT_COMMUNICATION", "COMMUNITY", "PUBLIC_SPACES", "OTHER",
}

# CRISP UI chips → UNDP super-type. UIs keep fine-grained chips (ROAD,
# HOSPITAL, etc.) for UX reasons; the backend stores the UNDP category
# in `infrastructure_type` and the fine-grained original in
# `infrastructure_sub_type` for analytics.
UI_CHIP_TO_UNDP = {
    # Legacy CRISP enum values
    "HOUSE":       "RESIDENTIAL",
    "GOVERNMENT":  "GOVERNMENT",
    "POWER":       "UTILITY",
    "WATER":       "UTILITY",
    "TELECOM":     "UTILITY",
    "ROAD":        "TRANSPORT_COMMUNICATION",
    "HOSPITAL":    "COMMUNITY",
    "SCHOOL":      "COMMUNITY",
    # New UNDP-aligned chips
    "RESIDENTIAL": "RESIDENTIAL",
    "COMMERCIAL":  "COMMERCIAL",
    "UTILITY":     "UTILITY",
    "TRANSPORT":   "TRANSPORT_COMMUNICATION",
    "TRANSPORT_COMMUNICATION": "TRANSPORT_COMMUNICATION",
    "COMMUNITY":   "COMMUNITY",
    "PUBLIC_SPACES": "PUBLIC_SPACES",
    "PUBLIC_SPACE":  "PUBLIC_SPACES",
    "PARK":        "PUBLIC_SPACES",
    "RELIGIOUS":   "PUBLIC_SPACES",
    "MARKET":      "COMMERCIAL",
    "SHOP":        "COMMERCIAL",
    "OFFICE":      "COMMERCIAL",
    "OTHER":       "OTHER",
}


def ui_chip_to_undp(chip) -> Optional[str]:
    """Map a UI-chip identifier (what the user tapped) to the UNDP 7+Other
    super-type. Unknown chips fall through to 'OTHER' so no report ever
    ends up unclassified."""
    key = _to_key(chip)
    if not key:
        return None
    return UI_CHIP_TO_UNDP.get(key, "OTHER")


# ── Convenience ───────────────────────────────────────────────────────────────

UNDP_CRISIS_TYPES = [
    "EARTHQUAKE", "FLOOD", "TSUNAMI", "CYCLONE", "LANDSLIDE",     # Natural
    "EXPLOSION", "CHEMICAL_INCIDENT", "PANDEMIC",                 # Technological
    "CONFLICT", "CIVIL_UNREST",                                   # Human-made
    "OTHER",                                                      # Catch-all
]

UNDP_DAMAGE_CLASSES = ["MINIMAL", "PARTIAL", "COMPLETE"]


# Phase L (May 2026) — resolution_tier canonical vocabulary is
# SMALL / MEDIUM / ORIGINAL. The legacy LOW/HIGH aliases that this
# module previously normalized were removed from `ResolutionEnum`
# in alembic 0036; Pydantic now rejects them at the schema layer
# with 422, which is the correct behaviour now that all internal
# callers have been migrated.
