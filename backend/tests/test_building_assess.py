"""Building Assessment orchestration: POST /buildings/{id}/assess.

Runs the per-incident AI assessment across a building's non-duplicate incidents and
consolidates them into a building-level confidence roll-up. Claude is mocked.
"""
import pytest
from tests.conftest import auth_header
from app.models.report import Report, Building, BuildingAssessment, BuildingEvent


def _seed(client, *, cid, building_id, severity="SEVERE"):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}",
        "client_report_id": cid,
        "source": "APP",
        "severity": severity,
        "infrastructure_type": "HOSPITAL",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "expected_media": 0,
        "building_id": building_id,
        "infrastructure_name": "Apollo Hospital",
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.fixture
def _mock_claude(monkeypatch):
    """Patch the per-incident assess so no real Claude call happens; it just stamps
    a confidence onto the representative report (so the read-time scorer yields a
    non-null composite)."""
    calls = {"n": 0}

    async def fake_assess(report_id, payload=None, user=None, db=None, force=False):
        calls["n"] += 1
        r = db.query(Report).filter(Report.id == report_id).first()
        r.ai_assessment = {"confidence_score": 82, "summary": "mock", "suggested_action": "respond"}
        db.commit()
        return dict(r.ai_assessment, _cached=False)

    monkeypatch.setattr("app.api.endpoints.reports.ai_assess_report", fake_assess)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    return calls


def test_assess_returns_consolidated_rollup(client, analyst_token, db, _mock_claude):
    bid = "osm:way:assessA"
    _seed(client, cid="ba-1", building_id=bid)
    res = client.post(f"/api/v1/buildings/{bid}/assess?force=true", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["building_confidence"]["score"] is not None
    assert body["building_confidence"]["band"] in ("VERIFIED", "LIKELY", "MIXED", "WEAK")
    assert len(body["incidents"]) >= 1
    assert body["counts"]["assessed"] >= 1
    assert _mock_claude["n"] >= 1
    # Persistence: history row + denormalised cache + event.
    assert db.query(BuildingAssessment).filter(BuildingAssessment.building_id == bid).count() == 1
    b = db.query(Building).filter(Building.id == bid).first()
    assert b.building_confidence_score is not None and b.building_assessment_at is not None
    assert db.query(BuildingEvent).filter(
        BuildingEvent.building_id == bid, BuildingEvent.event_kind == "ASSESSMENT_RUN").count() == 1


def test_assess_skips_already_assessed(client, analyst_token, db, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    bid = "osm:way:assessB"
    rid = _seed(client, cid="ba-2", building_id=bid)
    # Pre-assess the report (cache populated) so a non-forced run must SKIP Claude.
    r = db.query(Report).filter(Report.id == rid).first()
    r.ai_assessment = {"confidence_score": 75, "summary": "pre"}
    db.commit()

    async def boom(*a, **k):
        raise AssertionError("ai_assess_report must NOT be called for an already-assessed report")
    monkeypatch.setattr("app.api.endpoints.reports.ai_assess_report", boom)

    res = client.post(f"/api/v1/buildings/{bid}/assess", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["counts"]["assessed"] == 0
    assert body["counts"]["cached"] >= 1
    assert body["building_confidence"]["score"] is not None


def test_assess_per_incident_failure_is_skipped_not_fatal(client, analyst_token, db, monkeypatch):
    """Regression: a transient per-incident failure (Claude/network/DB hiccup raising
    a plain Exception) must be caught + skipped, never crash the whole building
    assessment. Previously the except handler referenced an undefined `logger`, so the
    NameError escaped as a 500 and nothing was persisted."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    bid = "osm:way:assessFail"
    _seed(client, cid="ba-fail-1", building_id=bid)

    async def boom(*a, **k):
        raise RuntimeError("simulated Claude/network failure")
    monkeypatch.setattr("app.api.endpoints.reports.ai_assess_report", boom)

    res = client.post(f"/api/v1/buildings/{bid}/assess?force=true", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text  # NOT a 500 - the failure is swallowed
    body = res.json()
    assert body["counts"]["assessed"] == 0  # the one incident failed -> skipped
    # The roll-up still completes and a history row + event are persisted.
    assert db.query(BuildingAssessment).filter(BuildingAssessment.building_id == bid).count() == 1
    assert db.query(BuildingEvent).filter(
        BuildingEvent.building_id == bid, BuildingEvent.event_kind == "ASSESSMENT_RUN").count() == 1


def test_assess_503_without_key(client, analyst_token, db, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    bid = "osm:way:assessC"
    _seed(client, cid="ba-3", building_id=bid)
    res = client.post(f"/api/v1/buildings/{bid}/assess", headers=auth_header(analyst_token))
    assert res.status_code == 503


def test_assess_404_unknown_building(client, analyst_token, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    res = client.post("/api/v1/buildings/nope-nope/assess", headers=auth_header(analyst_token))
    assert res.status_code == 404
