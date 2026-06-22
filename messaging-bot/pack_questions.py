"""Channel-agnostic crisis-form-pack question helpers for the chat bots.

Pure / stdlib-only. The SINGLE place the Telegram + WhatsApp bots use to decide
which pack fields to ask on their channel, render their labels/options, detect the
"Other, please specify" follow-up, and coerce a collected answer into the wire
shape that ``backend/app/services/crisis_form_schema.validate_submission`` expects.
No logic is duplicated between the two bots.

It deliberately re-implements (rather than imports) the field iteration + per-
channel gating of ``crisis_form_schema.py`` so the messaging-bot package has no
backend dependency.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# Base field types a chat bot can render conversationally (mirrors
# crisis_form_schema.BASE_FIELD_TYPES). The special types
# (photo/audio/location/building/severity) are captured by the bot's NATIVE intake
# flow, not the dynamic pack, so they are never asked here.
BOT_RENDERABLE_TYPES = {
    "yes_no", "single_select", "multi_select", "short_text", "long_text", "integer",
}


def _iter_fields(schema: dict):
    for sec in (schema.get("sections") or []):
        if isinstance(sec, dict):
            for f in (sec.get("fields") or []):
                if isinstance(f, dict):
                    yield f


def _field_offered(field: dict, channel: str) -> bool:
    """A field is asked on ``channel`` when its ``channels`` list includes it
    (omitted list == available on all channels). Mirrors
    crisis_form_schema._field_offered, so the bot asks EXACTLY the fields the server
    will require for this channel (no over/under-asking)."""
    chs = field.get("channels")
    return True if chs is None else (channel in chs)


def iter_askable_fields(schema_json: Optional[dict], channel: str) -> List[dict]:
    """Ordered list of pack fields this ``channel`` should ask conversationally:
    bot-renderable base types offered on the channel, EXCLUDING conditional
    (``show_if``) fields - those are asked only as a follow-up by the caller (see
    :func:`conditional_child`). For the UNDP pack on TELEGRAM / WHATSAPP this yields
    exactly the 3 ``multi_select`` questions."""
    if not isinstance(schema_json, dict):
        return []
    out: List[dict] = []
    for f in _iter_fields(schema_json):
        if not f.get("key") or f.get("type") not in BOT_RENDERABLE_TYPES:
            continue
        if f.get("show_if"):           # conditional - asked as a follow-up, not standalone
            continue
        if not _field_offered(f, channel):
            continue
        out.append(f)
    return out


def conditional_child(schema_json: Optional[dict], parent_key: str, channel: str) -> Optional[dict]:
    """The ``show_if`` field whose parent is ``parent_key`` and which is offered on
    ``channel`` (e.g. the UNDP ``pressing_needs_other`` free-text sibling). None when
    there is none."""
    if not isinstance(schema_json, dict):
        return None
    for f in _iter_fields(schema_json):
        si = f.get("show_if")
        if (isinstance(si, dict) and si.get("field") == parent_key
                and f.get("type") in BOT_RENDERABLE_TYPES and _field_offered(f, channel)):
            return f
    return None


def _i18n(d, lang: str, fallback: str) -> str:
    if isinstance(d, dict):
        if d.get(lang):
            return d[lang]
        if d.get("en"):
            return d["en"]
    return fallback


def field_label(field: dict, lang: str = "en") -> str:
    return _i18n(field.get("label_i18n"), lang, field.get("label") or field.get("key") or "")


def option_label(opt: dict, lang: str = "en") -> str:
    return _i18n(opt.get("label_i18n"), lang, opt.get("label") or str(opt.get("value", "")))


def is_other_option(opt: dict) -> bool:
    """The free-text "Other, please specify" option, recognised by the explicit
    ``other: true`` flag (preferred) or the conventional ``OTHER`` value - so the
    bots never string-match on the (localised) label."""
    return bool(opt.get("other") is True or opt.get("value") == "OTHER")


def selection_has_other(field: dict, selected_values) -> bool:
    """True when the user's multi/single-select selection includes an Other option,
    so the caller should prompt the conditional free-text follow-up."""
    vals = set(selected_values or [])
    return any(is_other_option(o) for o in (field.get("options") or [])
              if o.get("value") in vals)


def max_count(field: dict) -> Optional[int]:
    v = field.get("validation") or {}
    mc = v.get("max_count")
    return mc if isinstance(mc, int) and mc > 0 else None


def coerce_answer(field: dict, raw: Any) -> Any:
    """Map collected UI state -> the wire value ``validate_submission`` expects, so
    the bot-built ``form_data`` round-trips the server validator without a 422:
      * multi_select -> list of option values
      * single_select -> the value (str)
      * yes_no -> bool
      * integer -> int
      * short_text / long_text -> str (capped to validation.max_length)
    """
    ftype = field.get("type")
    valid = field.get("validation") or {}
    if ftype == "multi_select":
        return [v for v in (raw or [])]
    if ftype == "single_select":
        return raw
    if ftype == "yes_no":
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in ("true", "yes", "1", "y")
    if ftype == "integer":
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    # short_text / long_text
    s = "" if raw is None else str(raw)
    cap = valid.get("max_length", 120 if ftype == "short_text" else 5000)
    return s[:cap]
