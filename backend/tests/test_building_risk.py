"""Building RISK score — ONE consolidated act-first metric (factor-based).

Unit-tests the factor math + the operationally critical edge cases (a severe-but-
unconfirmed building stays visible + flagged 'verify', never 'act now'; a credible
critical building reads CRITICAL + 'dispatch'), and the assess endpoint integration
(returns the `risk` block + persists it; the detail GET re-exposes it). Claude mocked.
"""
import pytest

from tests.conftest import auth_header
from app.models.report import Report, Building, BuildingAssessment
from app.services.building_risk import compute_building_risk, risk_band


# ── Unit: factor math + edge cases ──────────────────────────────────────────────

def test_factor_weights_sum_to_100():
    r = compute_building_risk(incidents=[{"severity": "MODERATE", "score": 60}])
    assert sum(f["max"] for f in r["factors"]) == 100
    assert [f["key"] for f in r["factors"]] == \
        ["severity", "incidents", "corroboration", "evidence", "recency"]


def test_severe_but_unverified_stays_visible_and_flagged_not_act_now():
    # 1 CRITICAL incident, NO AI assessment → severity factor ran, credibility did NOT.
    r = compute_building_risk(
        incidents=[{"severity": "CRITICAL", "score": None, "media_count": 0, "age_hours": 2}],
        report_count=1, damage_class_max="PARTIAL", source_count=1, reports_24h=1)
    sev, inc = r["factors"][0], r["factors"][1]
    assert sev["ran"] and sev["awarded"] > 0           # severity keeps it on the radar
    assert not inc["ran"] and inc["awarded"] == 0      # credibility not yet folded in
    assert r["recommendation"] == "Verify before acting"   # never "Dispatch"
    assert r["assessed"] is False
    assert r["band"] in ("LOW", "MODERATE")            # visible, not CRITICAL/HIGH


def test_credible_critical_corroborated_reads_act_now():
    r = compute_building_risk(
        incidents=[{"severity": "CRITICAL", "score": 88, "satellite_score": 80,
                    "media_count": 2, "age_hours": 1}] * 4,
        report_count=12, damage_class_max="COMPLETE", source_count=3, reports_24h=8)
    assert r["band"] in ("CRITICAL", "HIGH")
    assert r["recommendation"] == "Dispatch responders"
    assert r["assessed"] is True
    assert r["coverage"] == {"assessed": 4, "total": 4}


def test_credible_minor_is_low_priority():
    r = compute_building_risk(
        incidents=[{"severity": "MINOR", "score": 70, "media_count": 1, "age_hours": 100}],
        report_count=1, damage_class_max="MINIMAL", source_count=1, reports_24h=0)
    assert r["band"] in ("LOW", "MODERATE")
    assert r["recommendation"] in ("Verify before acting", "Monitor")


def test_empty_building_is_minimal_unassessed():
    r = compute_building_risk(incidents=[], report_count=0)
    assert r["assessed"] is False
    assert r["band"] in ("MINIMAL", "LOW")


def test_volume_corroboration_lifts_many_low_confidence_incidents():
    one = compute_building_risk(incidents=[{"severity": "MODERATE", "score": 45, "age_hours": 3}],
                                report_count=1, source_count=1)
    many = compute_building_risk(
        incidents=[{"severity": "MODERATE", "score": 45, "age_hours": 3}] * 5,
        report_count=12, source_count=4, reports_24h=6)
    assert many["score"] > one["score"]   # independent corroboration raises priority


def test_risk_band_thresholds():
    assert risk_band(None) == "UNASSESSED"
    assert risk_band(85) == "CRITICAL"
    assert risk_band(65) == "HIGH"
    assert risk_band(45) == "MODERATE"
    assert risk_band(25) == "LOW"
    assert risk_band(5) == "MINIMAL"


# ── Endpoint integration (Claude mocked) ────────────────────────────────────────

def _seed(client, *, cid, building_id, severity="CRITICAL"):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}", "client_report_id": cid, "source": "APP",
        "severity": severity, "infrastructure_type": "HOSPITAL", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL", "expected_media": 0, "building_id": building_id,
        "infrastructure_name": "Apollo Hospital", "location": {"latitude": 12.97, "longitude": 77.59}})
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.fixture
def _mock_claude(monkeypatch):
    async def fake_assess(report_id, payload=None, user=None, db=None, force=False):
        r = db.query(Report).filter(Report.id == report_id).first()
        r.ai_assessment = {"confidence_score": 84, "summary": "mock", "suggested_action": "respond"}
        db.commit()
        return dict(r.ai_assessment, _cached=False)
    monkeypatch.setattr("app.api.endpoints.reports.ai_assess_report", fake_assess)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


def test_assess_returns_and_persists_the_risk_block(client, analyst_token, db, _mock_claude):
    bid = "osm:way:riskA"
    _seed(client, cid="br-1", building_id=bid)
    res = client.post(f"/api/v1/buildings/{bid}/assess?force=true", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    risk = body["risk"]
    assert isinstance(risk["score"], int) and 0 <= risk["score"] <= 100
    assert risk["band"] in ("CRITICAL", "HIGH", "MODERATE", "LOW", "MINIMAL")
    assert len(risk["factors"]) == 5 and sum(f["max"] for f in risk["factors"]) == 100
    assert risk["assessed"] is True
    # persisted (denormalised + history row)
    b = db.query(Building).filter(Building.id == bid).first()
    assert b.building_risk_score == risk["score"] and b.building_risk_band == risk["band"]
    row = db.query(BuildingAssessment).filter(BuildingAssessment.building_id == bid).first()
    assert row.building_risk_score == risk["score"] and row.risk_factors


def test_detail_get_reexposes_the_risk_assessment(client, analyst_token, viewer_token, db, _mock_claude):
    bid = "osm:way:riskGet"
    _seed(client, cid="br-g1", building_id=bid)
    client.post(f"/api/v1/buildings/{bid}/assess?force=true", headers=auth_header(analyst_token))
    g = client.get(f"/api/v1/buildings/{bid}", headers=auth_header(viewer_token))
    assert g.status_code == 200, g.text
    a = g.json().get("assessment")
    assert a and a.get("risk") and a["risk"]["score"] is not None
    assert len(a["risk"]["factors"]) == 5
