"""UNDP Appendix-1 mandatory-questions pack - schema + per-channel enforcement.

These are pure-function tests over the canonical schema (app.services.undp_pack)
and the validator (app.services.crisis_form_schema). No DB / client fixture, so
they run fast and isolate the compliance contract:

  * the three core questions exist, verbatim, with the exact option counts UNDP
    mandates (electricity 6 / health 5 / pressing-needs 10 + "Other");
  * all three are multi_select and required;
  * every question + option ships the 6 UN languages (must-have #2);
  * server validation enforces them on the App + chat channels that render packs
    (APP/ANDROID/WHATSAPP/TELEGRAM) and SKIPS them on SMS/IVR (parity, must-have #1);
  * the "Other, please specify" free-text sibling is optional + conditional.
"""
import pytest

from app.services.crisis_form_schema import validate_pack_schema, validate_submission
from app.services.undp_pack import (
    UNDP_CORE_SCHEMA, UNDP_PACK_KEY, UNDP_PACK_TITLE, UNDP_CHANNELS,
)

UN_LANGS = ("en", "ar", "zh", "fr", "ru", "es")


def _fields():
    return {f["key"]: f for sec in UNDP_CORE_SCHEMA["sections"] for f in sec["fields"]}


def _schema():
    s = dict(UNDP_CORE_SCHEMA)
    s["key"], s["title"] = UNDP_PACK_KEY, UNDP_PACK_TITLE
    return s


def test_schema_is_structurally_valid():
    assert validate_pack_schema(_schema()) == []


def test_three_core_questions_present_with_exact_option_counts():
    f = _fields()
    assert f["electricity_condition"]["type"] == "multi_select"
    assert f["health_services_status"]["type"] == "multi_select"
    assert f["pressing_needs"]["type"] == "multi_select"
    assert len(f["electricity_condition"]["options"]) == 6
    assert len(f["health_services_status"]["options"]) == 5
    assert len(f["pressing_needs"]["options"]) == 10


def test_three_core_questions_are_required():
    f = _fields()
    for k in ("electricity_condition", "health_services_status", "pressing_needs"):
        assert f[k]["required"] is True, k


def test_pressing_needs_has_other_with_conditional_freetext_sibling():
    f = _fields()
    other = [o for o in f["pressing_needs"]["options"] if o.get("other")]
    assert len(other) == 1 and other[0]["value"] == "OTHER"
    sib = f["pressing_needs_other"]
    assert sib["type"] == "short_text"
    assert sib["required"] is False               # optional → no conditional-required 422
    assert sib["show_if"] == {"field": "pressing_needs", "includes": "OTHER"}


def test_every_question_and_option_ships_six_un_languages():
    for f in _fields().values():
        li = f.get("label_i18n") or {}
        for lang in UN_LANGS:
            assert li.get(lang), f"{f['key']} label missing {lang}"
        for o in f.get("options", []):
            oli = o.get("label_i18n") or {}
            for lang in UN_LANGS:
                assert oli.get(lang), f"{f['key']}/{o['value']} option missing {lang}"


def test_channels_scope_app_and_chat_only():
    for f in _fields().values():
        assert f["channels"] == UNDP_CHANNELS
        assert "SMS" not in f["channels"] and "IVR" not in f["channels"]


def test_no_first_class_maps_to_so_answers_land_in_form_data():
    # UNDP electricity is a DAMAGE scale, incompatible with ServiceStatusEnum;
    # none of the UNDP fields may bind to a first-class column.
    for f in _fields().values():
        assert "maps_to" not in f


@pytest.mark.parametrize("channel", ["APP", "ANDROID", "WHATSAPP", "TELEGRAM"])
def test_full_answer_set_validates_on_render_channels(channel):
    payload = {
        "electricity_condition": ["SEVERE"],
        "health_services_status": ["LARGELY_DISRUPTED"],
        "pressing_needs": ["FOOD_WATER", "OTHER"],
        "pressing_needs_other": "fuel for generators",
    }
    form_data, first_class, errors = validate_submission(_schema(), payload, channel)
    assert errors == []
    assert first_class == {}
    assert set(form_data) == {
        "electricity_condition", "health_services_status", "pressing_needs", "pressing_needs_other"
    }
    assert form_data["pressing_needs"] == ["FOOD_WATER", "OTHER"]


@pytest.mark.parametrize("channel", ["APP", "ANDROID", "WHATSAPP", "TELEGRAM"])
def test_missing_required_is_rejected_on_render_channels(channel):
    _, _, errors = validate_submission(_schema(), {"electricity_condition": ["NO_DAMAGE"]}, channel)
    assert any("health_services_status" in e for e in errors)
    assert any("pressing_needs" in e for e in errors)


@pytest.mark.parametrize("channel", ["SMS", "IVR"])
def test_non_render_channels_skip_the_undp_fields(channel):
    # Parity (must-have #1): a channel that can't render the pack is never 422'd
    # for the App-only/chat-only fields.
    form_data, first_class, errors = validate_submission(_schema(), {}, channel)
    assert errors == []
    assert form_data == {} and first_class == {}


def test_other_freetext_optional_even_when_other_selected():
    # The sibling is optional server-side; selecting OTHER without specifying does
    # not 422 (conditional-required is a client nicety, not a server gate).
    payload = {
        "electricity_condition": ["NO_DAMAGE"],
        "health_services_status": ["FULLY_FUNCTIONAL"],
        "pressing_needs": ["OTHER"],
    }
    _, _, errors = validate_submission(_schema(), payload, "APP")
    assert errors == []


def test_unknown_option_value_is_rejected():
    payload = {
        "electricity_condition": ["TOTALLY_FINE"],   # not a UNDP option
        "health_services_status": ["FULLY_FUNCTIONAL"],
        "pressing_needs": ["FOOD_WATER"],
    }
    _, _, errors = validate_submission(_schema(), payload, "APP")
    assert any("electricity_condition" in e for e in errors)


# ── Export surfacing (P3): form_data must reach the GIS exports with labels ──

def test_export_resolves_form_data_to_verbatim_labels():
    import json as _json
    from app.api.endpoints.exports import _resolve_form_data_export
    fmap = {
        "electricity_condition": {"label": "Electricity condition?",
                                  "options": {"SEVERE": "Severe damage (...)"}},
        "pressing_needs": {"label": "Most pressing needs?",
                           "options": {"FOOD_WATER": "Food and water", "OTHER": "Other, please specify"}},
    }
    out = _resolve_form_data_export(
        {"electricity_condition": ["SEVERE"],
         "pressing_needs": ["FOOD_WATER", "OTHER"],
         "pressing_needs_other": "fuel for generators"}, fmap)
    d = _json.loads(out)
    assert d["Electricity condition?"] == ["Severe damage (...)"]
    assert d["Most pressing needs?"] == ["Food and water", "Other, please specify"]
    # a field the schema map doesn't cover falls back to the raw key + value
    assert d["pressing_needs_other"] == "fuel for generators"


def test_export_form_data_empty_for_default_reports():
    from app.api.endpoints.exports import _resolve_form_data_export
    assert _resolve_form_data_export(None, {}) == ""
    assert _resolve_form_data_export({}, {}) == ""


def test_export_headers_and_data_dictionary_include_form_data():
    from app.api.endpoints.exports import EXPORT_HEADERS, _COLUMN_DESCRIPTIONS
    assert "form_data" in EXPORT_HEADERS
    assert "form_data" in _COLUMN_DESCRIPTIONS
