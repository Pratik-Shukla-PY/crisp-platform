"""AI Analyze at operation + global scope (aggregate-then-synthesize).

The deterministic roll-up is always valid; the single Claude call is mocked here so
the test exercises the real aggregation + output shaping + the AI->action tie-in (a
recommended_action is an executable cascade) without a network call.
"""
import uuid

from tests.conftest import auth_header
from app.models.report import Report, Building, CrisisEvent, ScopeAssessment


def _mk_op(db, admin_user, name="Assess Op"):
    ev = CrisisEvent(id=str(uuid.uuid4()), name=name, crisis_type="FLOOD",
                     status="LIVE", is_active=True, center_lat=12.97, center_lng=77.59,
                     radius_km=30, place_name="Test Region", created_by=admin_user.id)
    db.add(ev); db.commit(); db.refresh(ev)
    return ev


def _seed_into_op(client, db, *, cid, building_id, op_id, severity="CRITICAL", conf=None):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}", "client_report_id": cid, "source": "APP",
        "severity": severity, "infrastructure_type": "HOSPITAL", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL", "expected_media": 0, "building_id": building_id,
        "location": {"latitude": 12.97, "longitude": 77.59}})
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    db.query(Report).filter(Report.id == rid).update(
        {Report.crisis_event_id: op_id}, synchronize_session=False)
    if conf is not None:
        db.query(Building).filter(Building.id == building_id).update(
            {Building.building_confidence_score: conf}, synchronize_session=False)
    db.commit()
    return rid


async def _fake_generate(db, scope_type, scope_id=None):
    """Stand-in for the Claude call: real aggregate + a canned narrative through the
    REAL _shape (so output shaping + executable-action mapping are exercised)."""
    from app.services.scope_assessment import aggregate_operation, aggregate_global, _shape
    agg = aggregate_operation(db, scope_id) if scope_type == "operation" else aggregate_global(db)
    parsed = {
        "situation_summary": "Two critical buildings remain unattended; collapse risk rising.",
        "key_risks": ["structural collapse", "responder shortfall"],
        "escalation_likelihood": {"level": "HIGH", "rationale": "criticals rising, none dispatched"},
        "recommended_actions": [
            {"label": "Dispatch to unattended critical", "action": "dispatch", "queue": "unattended_critical"},
            {"label": "bogus", "action": "explode", "queue": "critical"},   # invalid → dropped
        ],
        "priority_score": 88,
        "resource_recommendations": ["2 search-and-rescue teams", "medical triage unit"],
    }
    return _shape(agg, parsed, parsed["situation_summary"])


# ── Deterministic aggregation (no Claude) ───────────────────────────────────────

def test_aggregate_operation_rolls_up_scores_and_coverage(client, admin_user, db):
    from app.services.scope_assessment import aggregate_operation
    op = _mk_op(db, admin_user, "Agg Op")
    _seed_into_op(client, db, cid="ag-1", building_id="osm:way:ag1", op_id=op.id, conf=80)
    _seed_into_op(client, db, cid="ag-2", building_id="osm:way:ag2", op_id=op.id, conf=40)
    _seed_into_op(client, db, cid="ag-3", building_id="osm:way:ag3", op_id=op.id, conf=None)  # unassessed
    agg = aggregate_operation(db, op.id)
    assert agg["counts"]["reports"] == 3
    assert agg["counts"]["buildings"] == 3
    assert agg["counts"]["critical"] == 3
    assert agg["coverage"]["assessed"] == 2 and agg["coverage"]["total"] == 3
    assert agg["score"] == 60            # mean(80, 40)
    assert agg["band"] == "LIKELY"
    assert agg["distribution"]["VERIFIED"] == 1 and agg["distribution"]["MIXED"] == 1


# ── Endpoints (Claude mocked) ───────────────────────────────────────────────────

def test_operation_assess_persists_and_get_returns_narrative(client, analyst_token, viewer_token,
                                                              admin_user, db, monkeypatch):
    op = _mk_op(db, admin_user, "Assess E2E")
    _seed_into_op(client, db, cid="as-1", building_id="osm:way:as1", op_id=op.id, conf=70)

    # GET before any Analyze → not yet assessed, but live metrics present
    g0 = client.get(f"/api/v1/operations/{op.id}/assess", headers=auth_header(viewer_token))
    assert g0.status_code == 200 and g0.json()["assessed"] is False
    assert g0.json()["counts"]["reports"] == 1

    monkeypatch.setattr("app.services.scope_assessment.generate_scope_assessment", _fake_generate)
    res = client.post(f"/api/v1/operations/{op.id}/assess", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    p = res.json()
    assert p["situation_summary"].startswith("Two critical")
    assert p["priority_score"] == 88
    assert p["escalation_likelihood"]["level"] == "HIGH"
    # exactly ONE valid executable cascade survived (the bogus action was dropped)
    assert len(p["recommended_actions"]) == 1
    act = p["recommended_actions"][0]
    assert act["action"] == "dispatch"
    assert act["scope"] == {"scope_type": "operation", "scope_id": op.id}
    assert act["filters"]["queue"] == "unattended_critical"
    # persisted
    assert db.query(ScopeAssessment).filter(ScopeAssessment.scope_id == op.id).count() == 1
    # GET now returns the cached narrative + fresh metrics
    g1 = client.get(f"/api/v1/operations/{op.id}/assess", headers=auth_header(viewer_token))
    assert g1.json()["assessed"] is True
    assert g1.json()["situation_summary"].startswith("Two critical")


def test_recommended_action_is_an_executable_cascade(client, analyst_token, admin_user, db, monkeypatch):
    """The AI->action tie-in: a recommended_action's {action,scope,filters} runs as a
    real cascade and percolates to the slice."""
    op = _mk_op(db, admin_user, "Assess Action")
    ids = [_seed_into_op(client, db, cid=f"aa-{i}", building_id="osm:way:aa",
                         op_id=op.id, severity="CRITICAL", conf=50) for i in range(2)]
    monkeypatch.setattr("app.services.scope_assessment.generate_scope_assessment", _fake_generate)
    p = client.post(f"/api/v1/operations/{op.id}/assess", headers=auth_header(analyst_token)).json()
    act = p["recommended_actions"][0]            # dispatch unattended_critical
    # execute it exactly as the dashboard would
    res = client.post(f"/api/v1/operations/{act['scope']['scope_id']}/cascade/{act['action']}",
                      headers=auth_header(analyst_token), json={"filters": act["filters"]})
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["reports"] == 2
    statuses = {(r.status.value if hasattr(r.status, "value") else r.status)
                for r in db.query(Report).filter(Report.id.in_(ids)).all()}
    assert statuses == {"RESPONDING"}


def test_assess_viewer_cannot_run_but_can_read(client, viewer_token, admin_user, db, monkeypatch):
    op = _mk_op(db, admin_user, "Assess Perm")
    monkeypatch.setattr("app.services.scope_assessment.generate_scope_assessment", _fake_generate)
    r = client.post(f"/api/v1/operations/{op.id}/assess", headers=auth_header(viewer_token))
    assert r.status_code in (401, 403)
    g = client.get(f"/api/v1/operations/{op.id}/assess", headers=auth_header(viewer_token))
    assert g.status_code == 200


def test_global_assess_get_aggregates(client, viewer_token, admin_user, db):
    g = client.get("/api/v1/analytics/assess", headers=auth_header(viewer_token))
    assert g.status_code == 200
    body = g.json()
    assert body["scope_type"] == "global"
    assert "counts" in body and "operations" in body["counts"]
