"""Shared chat-bot pack-question helpers (messaging_bot.pack_questions).

Pure-function tests: which fields each channel asks, the "Other" follow-up
detection, i18n fallback, and - crucially - that a bot-built answer round-trips the
REAL backend validator (crisis_form_schema.validate_submission) without a 422, so
Telegram / WhatsApp submissions can never be rejected for shape.
"""
import pytest

from messaging_bot import pack_questions as pq
from app.services.crisis_form_schema import validate_submission
from app.services.undp_pack import UNDP_CORE_SCHEMA, UNDP_PACK_KEY, UNDP_CHANNELS


def _schema():
    s = dict(UNDP_CORE_SCHEMA)
    s["key"] = UNDP_PACK_KEY
    return s


@pytest.mark.parametrize("channel", ["TELEGRAM", "WHATSAPP"])
def test_iter_askable_yields_exactly_the_three_undp_questions(channel):
    fields = pq.iter_askable_fields(_schema(), channel)
    keys = [f["key"] for f in fields]
    assert keys == ["electricity_condition", "health_services_status", "pressing_needs"]
    # the conditional free-text sibling is NOT asked standalone
    assert "pressing_needs_other" not in keys
    assert all(f["type"] == "multi_select" for f in fields)


@pytest.mark.parametrize("channel", ["SMS", "IVR"])
def test_non_render_channels_get_no_undp_fields(channel):
    assert pq.iter_askable_fields(_schema(), channel) == []


def test_omitted_channels_is_offered_everywhere():
    schema = {"sections": [{"fields": [
        {"key": "q", "type": "yes_no", "label": "Q"},          # no channels → all
        {"key": "app_only", "type": "yes_no", "label": "A", "channels": ["APP"]},
    ]}]}
    for ch in ("TELEGRAM", "WHATSAPP", "SMS"):
        keys = [f["key"] for f in pq.iter_askable_fields(schema, ch)]
        assert "q" in keys
        assert "app_only" not in keys


def test_special_types_are_never_asked():
    schema = {"sections": [{"fields": [
        {"key": "p", "type": "photo", "channels": UNDP_CHANNELS},
        {"key": "loc", "type": "location", "channels": UNDP_CHANNELS},
        {"key": "ok", "type": "single_select", "channels": UNDP_CHANNELS,
         "options": [{"value": "A", "label": "A"}]},
    ]}]}
    assert [f["key"] for f in pq.iter_askable_fields(schema, "TELEGRAM")] == ["ok"]


def test_conditional_child_resolves_the_other_sibling():
    child = pq.conditional_child(_schema(), "pressing_needs", "TELEGRAM")
    assert child is not None and child["key"] == "pressing_needs_other"
    # no sibling for a field without one
    assert pq.conditional_child(_schema(), "electricity_condition", "TELEGRAM") is None


def test_is_other_option_and_selection_has_other():
    needs = next(f for f in pq.iter_askable_fields(_schema(), "TELEGRAM")
                 if f["key"] == "pressing_needs")
    others = [o for o in needs["options"] if pq.is_other_option(o)]
    assert len(others) == 1 and others[0]["value"] == "OTHER"
    assert pq.selection_has_other(needs, ["FOOD_WATER", "OTHER"]) is True
    assert pq.selection_has_other(needs, ["FOOD_WATER"]) is False


def test_labels_use_i18n_with_fallback():
    elec = next(f for f in pq.iter_askable_fields(_schema(), "TELEGRAM")
                if f["key"] == "electricity_condition")
    # native language wins
    assert pq.field_label(elec, "fr").startswith("Quel est")
    # unknown language → English fallback
    assert pq.field_label(elec, "xx") == pq.field_label(elec, "en")
    opt = elec["options"][0]
    assert pq.option_label(opt, "es")  # non-empty Spanish label
    assert pq.option_label(opt, "xx") == pq.option_label(opt, "en")


def test_coerce_answer_roundtrips_through_the_real_validator():
    fields = {f["key"]: f for f in pq.iter_askable_fields(_schema(), "TELEGRAM")}
    # simulate what the bot collects: a list of picked option values per question
    form_data = {
        "electricity_condition": pq.coerce_answer(fields["electricity_condition"], ["SEVERE"]),
        "health_services_status": pq.coerce_answer(fields["health_services_status"], ["LARGELY_DISRUPTED"]),
        "pressing_needs": pq.coerce_answer(fields["pressing_needs"], ["FOOD_WATER", "OTHER"]),
        "pressing_needs_other": "fuel for generators",
    }
    assert form_data["electricity_condition"] == ["SEVERE"]
    # the REAL server validator must accept the bot-built payload on TELEGRAM
    _fd, _fc, errors = validate_submission(_schema(), form_data, "TELEGRAM")
    assert errors == []
    assert _fd["pressing_needs"] == ["FOOD_WATER", "OTHER"]


def test_coerce_yes_no_and_integer():
    yn = {"key": "d", "type": "yes_no"}
    assert pq.coerce_answer(yn, "yes") is True
    assert pq.coerce_answer(yn, "no") is False
    assert pq.coerce_answer(yn, True) is True
    iq = {"key": "n", "type": "integer"}
    assert pq.coerce_answer(iq, "12") == 12
    assert pq.coerce_answer(iq, "abc") is None


def test_max_count_helper():
    assert pq.max_count({"validation": {"max_count": 3}}) == 3
    assert pq.max_count({}) is None
