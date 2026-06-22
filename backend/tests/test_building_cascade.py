"""Building cascade actions: POST /buildings/{id}/cascade/{action}.

Resolve / False Alarm / Notify / Reject / Reopen applied to the WHOLE building
(its incidents + their reports + the building state) as one audited, reversible
batch, reusing the per-report endpoint logic.
"""
from tests.conftest import auth_header
from app.models.report import Report, Building, Incident, BuildingEvent


def _seed(client, *, cid, building_id):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}",
        "client_report_id": cid,
        "source": "APP",
        "severity": "SEVERE",
        "infrastructure_type": "HOSPITAL",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "expected_media": 0,
        "building_id": building_id,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _statuses(db, building_id):
    return {r.status.value if hasattr(r.status, "value") else r.status
            for r in db.query(Report).filter(Report.building_id == building_id).all()}


def test_cascade_resolve_sets_reports_incidents_and_building(client, analyst_token, db):
    bid = "osm:way:cascA"
    _seed(client, cid="cA-1", building_id=bid)
    _seed(client, cid="cA-2", building_id=bid)
    res = client.post(f"/api/v1/buildings/{bid}/cascade/resolve", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["building_state"] == "RESOLVED"
    assert body["counts"]["reports_changed"] >= 2
    assert _statuses(db, bid) == {"RESOLVED"}
    incs = db.query(Incident).filter(Incident.building_id == bid).all()
    assert incs and all((i.status == "RESOLVED") for i in incs)
    assert db.query(BuildingEvent).filter(
        BuildingEvent.building_id == bid, BuildingEvent.event_kind == "CASCADE_RESOLVE").count() == 1


def test_cascade_reopen_reverses_resolve(client, analyst_token, db):
    bid = "osm:way:cascB"
    _seed(client, cid="cB-1", building_id=bid)
    client.post(f"/api/v1/buildings/{bid}/cascade/resolve", headers=auth_header(analyst_token))
    res = client.post(f"/api/v1/buildings/{bid}/cascade/reopen", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    assert res.json()["building_state"] == "ACTIVE"
    assert _statuses(db, bid) == {"PENDING"}
    incs = db.query(Incident).filter(Incident.building_id == bid).all()
    assert incs and all((i.status == "OPEN") for i in incs)


def test_cascade_reopen_reverses_notify(client, analyst_token, db):
    """Regression: notify sets the building to RESPONDING; RESPONDING->ACTIVE is NOT
    in the building state machine, so without the reopen force-state the building
    would stay stuck in RESPONDING while its reports/incidents revert. Reopen must
    land it back in ACTIVE so the UI matches the reverted underlying data."""
    bid = "osm:way:cascReopenNotify"
    _seed(client, cid="cRN-1", building_id=bid)
    n = client.post(f"/api/v1/buildings/{bid}/cascade/notify", headers=auth_header(analyst_token))
    assert n.status_code == 200 and n.json()["building_state"] == "RESPONDING"
    assert _statuses(db, bid) == {"RESPONDING"}
    res = client.post(f"/api/v1/buildings/{bid}/cascade/reopen", headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    assert res.json()["building_state"] == "ACTIVE", "reopen must un-stick a notified building"
    assert _statuses(db, bid) == {"PENDING"}
    incs = db.query(Incident).filter(Incident.building_id == bid).all()
    assert incs and all((i.status == "OPEN") for i in incs)
    b = db.query(Building).filter(Building.id == bid).first()
    assert b.state == "ACTIVE"


def test_cascade_false_alarm_requires_reason(client, analyst_token):
    bid = "osm:way:cascC"
    _seed(client, cid="cC-1", building_id=bid)
    r0 = client.post(f"/api/v1/buildings/{bid}/cascade/false-alarm", headers=auth_header(analyst_token))
    assert r0.status_code == 400   # reason required
    r1 = client.post(f"/api/v1/buildings/{bid}/cascade/false-alarm",
                     headers=auth_header(analyst_token), json={"reason": "misinformation"})
    assert r1.status_code == 200, r1.text
    assert r1.json()["building_state"] == "FALSE_ALARM"


def test_cascade_reject_sets_verdict_and_keeps_status(client, analyst_token, db):
    bid = "osm:way:cascD"
    rid = _seed(client, cid="cD-1", building_id=bid)
    r0 = client.post(f"/api/v1/buildings/{bid}/cascade/reject", headers=auth_header(analyst_token))
    assert r0.status_code == 400   # reason required
    res = client.post(f"/api/v1/buildings/{bid}/cascade/reject",
                      headers=auth_header(analyst_token), json={"reason": "bogus cluster"})
    assert res.status_code == 200, res.text
    rep = db.query(Report).filter(Report.id == rid).first()
    assert rep.reviewer_verdict == "REJECTED"
    assert (rep.status.value if hasattr(rep.status, "value") else rep.status) == "PENDING"  # status untouched
    # Building-rejected reports stay out of the default export (Phase 0 invariant).
    from tests.conftest import auth_header as ah
    csv = client.get("/api/v1/exports/csv", headers=ah(analyst_token))
    assert rid not in csv.text


def test_cascade_notify_then_resolve_then_idempotent(client, analyst_token, db):
    bid = "osm:way:cascE"
    _seed(client, cid="cE-1", building_id=bid)
    n = client.post(f"/api/v1/buildings/{bid}/cascade/notify", headers=auth_header(analyst_token))
    assert n.status_code == 200 and n.json()["building_state"] == "RESPONDING"
    assert _statuses(db, bid) == {"RESPONDING"}
    # Idempotent: a second notify changes nothing actionable.
    n2 = client.post(f"/api/v1/buildings/{bid}/cascade/notify", headers=auth_header(analyst_token))
    assert n2.status_code == 200
    assert n2.json()["counts"]["reports_changed"] == 0


def test_cascade_unknown_action_400(client, analyst_token):
    bid = "osm:way:cascF"
    _seed(client, cid="cF-1", building_id=bid)
    res = client.post(f"/api/v1/buildings/{bid}/cascade/explode", headers=auth_header(analyst_token))
    assert res.status_code == 400
