"""Unit tests for the system-only, additive Incident Credibility Score.

The score is the sum of independent automated checks (no human verdict input):
AI content (30) + Satellite (25) + Location (15) + Corroboration (15) + Reporter (15).
Suppressed until the operator runs the assessment (AI and/or satellite).
"""
import inspect

from app.services import credibility
from app.services.credibility import compute_incident_credibility as c


def _by_key(res, key):
    return next(f for f in res["factors"] if f["key"] == key)


def test_not_assessed_is_suppressed():
    r = c()  # nothing ran
    assert r["score"] is None
    assert r["band"] == "UNVERIFIED"
    assert r["assessed"] is False
    # all five checks are still listed (for the modal), just not run
    assert [f["key"] for f in r["factors"]] == ["ai", "satellite", "location", "corroboration", "reporter"]


def test_human_verdict_is_NOT_an_input():
    # The function must not accept / use a reviewer verdict - the score is
    # the system's automated assessment only.
    params = inspect.signature(c).parameters
    assert "reviewer_verdict" not in params


def test_ai_run_makes_it_assessed_and_additive():
    r = c(ai_assessment={"confidence_score": 80}, satellite_score=60,
          location={"latitude": 1, "longitude": 1, "accuracy_meters": 10},
          duplicate_count=2, reporter_tier="T2_SIGNAL")
    assert r["assessed"] is True
    # score is exactly the sum of the per-check awards (fully explainable)
    assert r["score"] == sum(f["awarded"] for f in r["factors"])
    assert _by_key(r, "ai")["awarded"] == round(30 * 80 / 100)        # 24
    assert _by_key(r, "satellite")["awarded"] == round(25 * 60 / 100)  # 15
    assert _by_key(r, "location")["awarded"] == 15                     # precise GPS
    assert _by_key(r, "corroboration")["awarded"] == 12               # min(15, 6+2*3)
    assert r["band"] in {"VERIFIED", "LIKELY", "MIXED", "WEAK"}


def test_satellite_only_also_counts_as_assessed():
    r = c(satellite_score=72, location={"latitude": 1, "longitude": 1, "accuracy_meters": 20})
    assert r["assessed"] is True
    assert _by_key(r, "ai")["ran"] is False           # AI not run -> 0
    assert _by_key(r, "ai")["awarded"] == 0
    assert _by_key(r, "satellite")["awarded"] == round(25 * 72 / 100)


def test_satellite_failure_is_distinct_from_low_score():
    r = c(ai_assessment={"confidence_score": 70}, satellite_error="no cloud-free imagery")
    sat = _by_key(r, "satellite")
    assert sat["ran"] is False
    assert sat["awarded"] == 0
    assert "could not run" in sat["reason"].lower()


def test_caps_at_100():
    r = c(ai_assessment={"confidence_score": 100}, satellite_score=100,
          location={"latitude": 1, "longitude": 1, "accuracy_meters": 5},
          duplicate_count=20, reporter_tier="T4_LIFEKEEPER")
    assert r["score"] <= 100
    assert r["band"] == "VERIFIED"


def test_each_factor_awarded_never_exceeds_its_max():
    r = c(ai_assessment={"confidence_score": 100}, satellite_score=100,
          location={"latitude": 1, "longitude": 1, "accuracy_meters": 1},
          duplicate_count=99, reporter_tier="T4_LIFEKEEPER")
    for f in r["factors"]:
        assert 0 <= f["awarded"] <= f["max"]


def test_location_low_when_text_geocoded():
    r = c(ai_assessment={"confidence_score": 60},
          location={"latitude": 1, "longitude": 1, "geocoding_confidence": 0.3})
    loc = _by_key(r, "location")
    assert loc["ran"] is True
    assert loc["awarded"] < 15  # text-geocoded with low confidence is reduced


def test_no_location_factor_does_not_run():
    r = c(ai_assessment={"confidence_score": 60}, location=None)
    assert _by_key(r, "location")["ran"] is False


def test_max_score_and_total_checks_exposed():
    r = c(ai_assessment={"confidence_score": 50})
    assert r["max_score"] == 100
    assert r["total_checks"] == 5


def test_garbage_inputs_do_not_raise():
    r = c(ai_assessment={"confidence_score": "n/a"}, satellite_score=999,
          reporter_tier="BOGUS", duplicate_count=-3, location={"latitude": None})
    assert r["band"] in {"VERIFIED", "LIKELY", "MIXED", "WEAK", "UNVERIFIED"}


def test_maxes_sum_to_100():
    assert (credibility._MAX_AI + credibility._MAX_SAT + credibility._MAX_LOC
            + credibility._MAX_CORRO + credibility._MAX_REP) == 100


def test_assessed_at_from_satellite_scored_at():
    import datetime as _dt
    ts = _dt.datetime(2026, 6, 19, 12, 30, 0)
    r = c(satellite_score=70, satellite_scored_at=ts)
    assert r["assessed_at"] is not None
    assert r["assessed_at"].startswith("2026-06-19T12:30:00")
    assert r["assessed_at"].endswith("Z") or "+" in r["assessed_at"]


def test_assessed_at_none_when_ai_only():
    # AI-only assessment carries no per-blob timestamp -> None (client falls back).
    r = c(ai_assessment={"confidence_score": 70})
    assert r["assessed"] is True
    assert r["assessed_at"] is None


def test_assessed_at_none_when_unassessed():
    r = c()
    assert r["assessed_at"] is None
