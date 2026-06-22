"""Location mismatch (device GPS vs reporter-submitted pin) — analyst signal only.

Contract: a significant mismatch is surfaced as a NOTE in the credibility location
factor's reason text + as AI-assessment context + as export columns, but it NEVER
changes the numeric Confidence Score (a corrected pin must not be penalised).
"""
from app.services.credibility import compute_incident_credibility


_BASE = dict(reporter_tier="T2_SIGNAL",
             location={"latitude": 12.97, "longitude": 77.59, "accuracy_meters": 30})


def test_mismatch_does_not_change_any_numeric_credibility_field():
    a = compute_incident_credibility(**_BASE)
    b = compute_incident_credibility(**_BASE, location_mismatch={"distance_km": 14})
    for k, v in a.items():
        if isinstance(v, (int, float)):
            assert b[k] == v, f"{k} changed {v} -> {b[k]} (mismatch must not affect the score)"
    # the location factor's awarded points are identical
    la = next(f for f in a["factors"] if f["key"] == "location")
    lb = next(f for f in b["factors"] if f["key"] == "location")
    assert la["awarded"] == lb["awarded"]


def test_mismatch_appends_a_note_to_the_location_reason():
    b = compute_incident_credibility(**_BASE, location_mismatch={"distance_km": 14})
    lb = next(f for f in b["factors"] if f["key"] == "location")
    assert "14 km" in lb["reason"] and "device GPS" in lb["reason"]


def test_no_mismatch_means_no_note():
    a = compute_incident_credibility(**_BASE)
    la = next(f for f in a["factors"] if f["key"] == "location")
    assert "NOTE" not in la["reason"]
    # an empty mismatch dict (distance 0) also adds nothing
    c = compute_incident_credibility(**_BASE, location_mismatch={})
    lc = next(f for f in c["factors"] if f["key"] == "location")
    assert "NOTE" not in lc["reason"]


def test_exports_carry_device_coords_and_data_dictionary_covers_them():
    from app.api.endpoints.exports import EXPORT_HEADERS, _COLUMN_DESCRIPTIONS
    for col in ("device_latitude", "device_longitude"):
        assert col in EXPORT_HEADERS
        assert col in _COLUMN_DESCRIPTIONS
