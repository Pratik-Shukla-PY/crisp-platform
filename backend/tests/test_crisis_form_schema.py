"""Unit tests for the Dynamic Crisis Forms schema contract + validation
(app.services.crisis_form_schema). Pure logic — no DB."""
import copy

from app.services.crisis_form_schema import validate_pack_schema, validate_submission


def _valid_pack():
    return {
        "schema_version": 1,
        "key": "wildfire-default",
        "title": "Forest Fire — rapid assessment",
        "sections": [
            {"id": "classify", "stage": 2, "title": "Assess", "fields": [
                {"key": "flames_visible", "type": "yes_no", "label": "Flames visible?", "required": True},
                {"key": "smoke_density", "type": "single_select", "label": "Smoke density?",
                 "options": [{"value": "LIGHT", "label": "Light"}, {"value": "HEAVY", "label": "Heavy"}]},
                {"key": "damage_classification", "type": "single_select", "label": "Damage?",
                 "maps_to": "damage_classification",
                 "options": [{"value": "MINIMAL", "label": "Minimal"}, {"value": "COMPLETE", "label": "Complete"}]},
                # App-only field (not offered on chat channels)
                {"key": "households_affected", "type": "integer", "label": "Households affected",
                 "validation": {"min": 0, "max": 100000}, "channels": ["APP", "ANDROID"]},
            ]},
            {"id": "review", "stage": 3, "title": "Details", "fields": [
                {"key": "debris_clearing_needed", "type": "yes_no", "label": "Debris clearing?",
                 "maps_to": "debris_clearing_needed"},
                {"key": "note", "type": "long_text", "label": "Notes", "validation": {"max_length": 50}},
            ]},
        ],
    }


# ── validate_pack_schema ──────────────────────────────────────────────────
def test_valid_pack_passes():
    assert validate_pack_schema(_valid_pack()) == []


def test_missing_key_and_title():
    errs = validate_pack_schema({"sections": [{"fields": [{"key": "x", "type": "yes_no", "label": "X"}]}]})
    assert any("key" in e for e in errs) and any("title" in e for e in errs)


def test_unknown_field_type_rejected():
    p = _valid_pack(); p["sections"][0]["fields"][0]["type"] = "rating_stars"
    assert any("unknown type" in e for e in validate_pack_schema(p))


def test_select_requires_options():
    p = _valid_pack(); p["sections"][0]["fields"][1]["options"] = []
    assert any("non-empty 'options'" in e for e in validate_pack_schema(p))


def test_enum_guard_blocks_noncanonical_mapped_value():
    p = _valid_pack()
    p["sections"][0]["fields"][2]["options"] = [{"value": "TOTALLY_WRECKED", "label": "x"}]
    errs = validate_pack_schema(p)
    assert any("not valid damage_classification" in e for e in errs)


def test_duplicate_keys_rejected():
    p = _valid_pack(); p["sections"][0]["fields"][0]["key"] = "smoke_density"
    assert any("duplicate field key" in e for e in validate_pack_schema(p))


def test_bad_channel_rejected():
    p = _valid_pack(); p["sections"][0]["fields"][0]["channels"] = ["APP", "FAX"]
    assert any("channels" in e for e in validate_pack_schema(p))


def test_maps_to_unknown_column_rejected():
    p = _valid_pack(); p["sections"][1]["fields"][1]["maps_to"] = "secret_field"
    assert any("not a writable Report column" in e for e in validate_pack_schema(p))


# ── validate_submission ────────────────────────────────────────────────────
def test_submission_routes_first_class_and_form_data():
    schema = _valid_pack()
    payload = {"flames_visible": "yes", "smoke_density": "HEAVY",
               "damage_classification": "COMPLETE", "households_affected": 12,
               "debris_clearing_needed": False, "note": "all clear"}
    fd, fc, errs = validate_submission(schema, payload, "APP")
    assert errs == []
    assert fc["damage_classification"] == "COMPLETE"        # maps_to → first-class
    assert fc["debris_clearing_needed"] is False
    assert fd["flames_visible"] is True and fd["smoke_density"] == "HEAVY"
    assert fd["households_affected"] == 12
    assert "damage_classification" not in fd                # not duplicated into form_data


def test_required_missing_errors():
    schema = _valid_pack()
    _, _, errs = validate_submission(schema, {}, "APP")
    assert any("flames_visible" in e and "required" in e for e in errs)


def test_integer_bounds_enforced():
    schema = _valid_pack()
    _, _, errs = validate_submission(schema, {"flames_visible": True, "households_affected": 999999}, "APP")
    assert any("households_affected" in e and "above max" in e for e in errs)


def test_select_value_must_be_allowed():
    schema = _valid_pack()
    _, _, errs = validate_submission(schema, {"flames_visible": True, "smoke_density": "NUCLEAR"}, "APP")
    assert any("smoke_density" in e for e in errs)


def test_channel_parity_skips_app_only_field():
    """A chat channel that omits an APP-only field must NOT be errored (#1 parity)."""
    schema = _valid_pack()
    # households_affected is App-only; Telegram omits it → no error, not in output.
    fd, fc, errs = validate_submission(schema, {"flames_visible": True}, "TELEGRAM")
    assert errs == []
    assert "households_affected" not in fd


def test_enum_guard_on_submission():
    """Even if a tampered payload sends a non-canonical mapped value, reject it."""
    schema = _valid_pack()
    # Force the option list to (illegally) include a bad value, simulating drift.
    schema["sections"][0]["fields"][2]["options"].append({"value": "BOGUS", "label": "b"})
    _, fc, errs = validate_submission(schema, {"flames_visible": True, "damage_classification": "BOGUS"}, "APP")
    assert any("canonical enum" in e for e in errs)
    assert "damage_classification" not in fc


def test_extra_payload_keys_ignored():
    schema = _valid_pack()
    fd, fc, errs = validate_submission(schema, {"flames_visible": True, "evil": "x"}, "APP")
    assert errs == [] and "evil" not in fd
