"""Dynamic Crisis Forms — schema contract + validation (pure, stdlib-only).

This module is the single source of truth for the crisis-pack `schema_json`
wire format that the dashboard builder produces and the per-channel renderers
(PWA / RN / Telegram) consume. It is intentionally free of app/DB/config
imports so it is trivially unit-testable and cheap to import.

Two jobs:
  1. validate_pack_schema(schema)      → list[str] errors  (authoring / publish lint)
  2. validate_submission(schema, payload, channel)
        → (form_data, first_class, errors)   (server re-validation of a report)

schema_json shape (sections → fields):
{
  "schema_version": 1,
  "key": "wildfire-default",
  "title": "Forest Fire — rapid assessment",
  "sections": [
    {"id": "classify", "stage": 2, "title": "...", "fields": [ <field>, ... ]},
    {"id": "review",   "stage": 3, "title": "...", "fields": [ <field>, ... ]}
  ]
}

field shape:
{
  "key": "flames_visible",          # unique; == backend column name when maps_to is set
  "type": "yes_no",                 # base type or CRISP special type (below)
  "label": "Flames visible?",       # plain label (fallback)
  "label_i18n": {"en": "...", "ar": "..."},   # optional embedded localization
  "required": true,
  "options": [{"value": "LIGHT", "label": "Light"}, ...],   # *_select only
  "validation": {"min": 0, "max": 500, "max_length": 200, "max_count": 3},
  "channels": ["APP","ANDROID","WHATSAPP","TELEGRAM"],      # parity (omitted = all)
  "maps_to": "damage_classification"   # optional → write a first-class Report column
}
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# Field types — the 6 modules.py base types ∪ the 5 CRISP special types.
BASE_FIELD_TYPES = {"single_select", "multi_select", "short_text", "long_text", "integer", "yes_no"}
SPECIAL_FIELD_TYPES = {"photo", "audio", "location", "building", "severity"}
ALL_FIELD_TYPES = BASE_FIELD_TYPES | SPECIAL_FIELD_TYPES

# Channels (must mirror SourceEnum). Omitted field.channels == available on all.
CHANNELS = {"APP", "ANDROID", "WHATSAPP", "TELEGRAM", "SMS", "IVR"}

# First-class Report columns a field may bind to via `maps_to`, with their
# canonical UNDP value allowlists (mirror the SQLAlchemy model enums). The
# allowlist is the enum-guard: an authored pack can never smuggle a non-canonical
# value into a first-class column (protects must-haves #4 / #5).
_DAMAGE = {"MINIMAL", "PARTIAL", "COMPLETE"}
_CRISIS = {"EARTHQUAKE", "FLOOD", "TSUNAMI", "CYCLONE", "WILDFIRE", "EXPLOSION",
           "CHEMICAL_INCIDENT", "CONFLICT", "CIVIL_UNREST", "OTHER"}
_INFRA = {"RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY",
          "TRANSPORT_COMMUNICATION", "COMMUNITY", "PUBLIC_SPACES", "OTHER"}
_SEVERITY = {"MINOR", "MODERATE", "SEVERE", "CRITICAL", "UNKNOWN"}
FIRST_CLASS_FIELDS: Dict[str, Optional[set]] = {
    "damage_classification": _DAMAGE,
    "crisis_type": _CRISIS,
    "infrastructure_type": _INFRA,
    "severity": _SEVERITY,
    "infrastructure_name": None,       # free text
    "debris_clearing_needed": None,    # yes_no → bool
}

MAX_SECTIONS = 6
MAX_FIELDS = 40


def _iter_fields(schema: dict):
    for sec in (schema.get("sections") or []):
        if isinstance(sec, dict):
            for f in (sec.get("fields") or []):
                if isinstance(f, dict):
                    yield sec, f


def validate_pack_schema(schema: Any) -> List[str]:
    """Structural + semantic validation of a pack definition. Returns a list of
    human-readable errors (empty = valid). Fail-soft: collects ALL problems so the
    dashboard builder can show them at once (mirrors modules._validate_module)."""
    errs: List[str] = []
    if not isinstance(schema, dict):
        return ["schema_json must be an object"]
    if not isinstance(schema.get("key"), str) or not schema.get("key"):
        errs.append("missing 'key' (stable string handle)")
    if not isinstance(schema.get("title"), str) or not schema.get("title"):
        errs.append("missing 'title'")
    secs = schema.get("sections")
    if not isinstance(secs, list) or not secs:
        errs.append("'sections' must be a non-empty list")
        return errs
    if len(secs) > MAX_SECTIONS:
        errs.append(f"too many sections (> {MAX_SECTIONS})")

    seen_keys: set = set()
    n_fields = 0
    for sec, f in _iter_fields(schema):
        n_fields += 1
        key = f.get("key")
        if not isinstance(key, str) or not key:
            errs.append("a field is missing 'key'")
            continue
        if key in seen_keys:
            errs.append(f"duplicate field key '{key}'")
        seen_keys.add(key)
        ftype = f.get("type")
        if ftype not in ALL_FIELD_TYPES:
            errs.append(f"field '{key}': unknown type '{ftype}'")
            continue
        if not (isinstance(f.get("label"), str) and f["label"]) and not isinstance(f.get("label_i18n"), dict):
            errs.append(f"field '{key}': needs 'label' or 'label_i18n'")
        # selects need a non-empty options list of {value,label}
        if ftype in ("single_select", "multi_select"):
            opts = f.get("options")
            if not isinstance(opts, list) or not opts:
                errs.append(f"field '{key}': {ftype} needs a non-empty 'options' list")
            else:
                for o in opts:
                    if not isinstance(o, dict) or "value" not in o:
                        errs.append(f"field '{key}': each option needs a 'value'")
                        break
        # channels subset check
        chs = f.get("channels")
        if chs is not None:
            if not isinstance(chs, list) or any(c not in CHANNELS for c in chs):
                errs.append(f"field '{key}': 'channels' must be a subset of {sorted(CHANNELS)}")
        # maps_to → first-class column + enum-guard
        mt = f.get("maps_to")
        if mt is not None:
            if mt not in FIRST_CLASS_FIELDS:
                errs.append(f"field '{key}': maps_to '{mt}' is not a writable Report column")
            else:
                allow = FIRST_CLASS_FIELDS[mt]
                if allow and ftype in ("single_select",) and isinstance(f.get("options"), list):
                    bad = [o.get("value") for o in f["options"]
                           if isinstance(o, dict) and o.get("value") not in allow]
                    if bad:
                        errs.append(f"field '{key}': option values {bad} are not valid {mt} enum values")
    if n_fields == 0:
        errs.append("schema has no fields")
    if n_fields > MAX_FIELDS:
        errs.append(f"too many fields (> {MAX_FIELDS})")
    return errs


def _field_offered(f: dict, channel: str) -> bool:
    chs = f.get("channels")
    return True if chs is None else (channel in chs)


def validate_submission(schema: dict, payload: dict, channel: str
                        ) -> Tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """Re-validate a submitted crisis-pack answer set against the pack schema, FOR
    THIS CHANNEL. Returns (form_data, first_class, errors):
      • form_data   → validated answers for the report's `form_data` JSON column
      • first_class → values for canonical Report columns (via `maps_to`)
      • errors      → list (empty = accept)
    Fields not offered on `channel` are skipped (NOT errored) — this is the
    multi-channel parity mechanism (must-have #1): a chat channel omitting an
    App-only field is never 422'd.
    """
    payload = payload or {}
    form_data: Dict[str, Any] = {}
    first_class: Dict[str, Any] = {}
    errors: List[str] = []

    for _sec, f in _iter_fields(schema):
        key = f.get("key")
        ftype = f.get("type")
        if not key or ftype not in ALL_FIELD_TYPES:
            continue
        if not _field_offered(f, channel):
            continue  # parity: field not available on this channel → skip
        raw = payload.get(key, None)
        required = bool(f.get("required"))
        empty = raw is None or raw == "" or raw == [] or raw == {}
        if empty:
            if required:
                errors.append(f"'{key}' is required")
            continue
        val: Any = raw
        valid = f.get("validation") or {}
        try:
            if ftype == "integer":
                val = int(raw)
                if "min" in valid and val < valid["min"]:
                    errors.append(f"'{key}' below min {valid['min']}"); continue
                if "max" in valid and val > valid["max"]:
                    errors.append(f"'{key}' above max {valid['max']}"); continue
            elif ftype == "yes_no":
                if isinstance(raw, bool):
                    val = raw
                elif str(raw).lower() in ("true", "yes", "1"):
                    val = True
                elif str(raw).lower() in ("false", "no", "0"):
                    val = False
                else:
                    errors.append(f"'{key}' must be yes/no"); continue
            elif ftype in ("short_text", "long_text"):
                val = str(raw)
                cap = valid.get("max_length", 120 if ftype == "short_text" else 5000)
                if len(val) > cap:
                    val = val[:cap]
            elif ftype == "single_select":
                opt_vals = {o.get("value") for o in (f.get("options") or []) if isinstance(o, dict)}
                if raw not in opt_vals:
                    errors.append(f"'{key}' value '{raw}' not an allowed option"); continue
            elif ftype == "multi_select":
                opt_vals = {o.get("value") for o in (f.get("options") or []) if isinstance(o, dict)}
                if not isinstance(raw, list) or any(v not in opt_vals for v in raw):
                    errors.append(f"'{key}' must be a subset of the allowed options"); continue
                val = list(raw)
            # special types (photo/audio/location/building/severity): presence/shape
            # only — bytes flow through the existing media + location pipelines.
        except (ValueError, TypeError):
            errors.append(f"'{key}' is malformed for type {ftype}")
            continue

        mt = f.get("maps_to")
        if mt and mt in FIRST_CLASS_FIELDS:
            allow = FIRST_CLASS_FIELDS[mt]
            if allow and val not in allow:
                errors.append(f"'{key}' → {mt} value '{val}' is not a canonical enum value"); continue
            first_class[mt] = val
        else:
            form_data[key] = val

    return form_data, first_class, errors
