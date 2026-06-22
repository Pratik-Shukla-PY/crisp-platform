"""Set-based scoped cascade engine — the Command Center action layer.

An operator acts at Operation / Global scope and it PERCOLATES to every incident +
report in the slice in ONE set-based transaction (scale-safe to a 500k-report
crisis), audited + reversible. dry_run returns the blast radius first. Global slices
are admin-gated and require a meaningful filter.
"""
import uuid

from tests.conftest import auth_header
from app.models.report import Report, Building, Incident, CrisisEvent, CascadeActionLog


def _mk_op(db, admin_user, name="Cascade Op"):
    ev = CrisisEvent(id=str(uuid.uuid4()), name=name, crisis_type="FLOOD",
                     status="LIVE", is_active=True, center_lat=12.97, center_lng=77.59,
                     radius_km=30, place_name="Test Region", created_by=admin_user.id)
    db.add(ev); db.commit(); db.refresh(ev)
    return ev


def _seed(client, *, cid, building_id, severity="SEVERE"):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}", "client_report_id": cid, "source": "APP",
        "severity": severity, "infrastructure_type": "HOSPITAL", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL", "expected_media": 0, "building_id": building_id,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _seed_into_op(client, db, *, cid, building_id, op_id, severity="SEVERE"):
    rid = _seed(client, cid=cid, building_id=building_id, severity=severity)
    db.query(Report).filter(Report.id == rid).update(
        {Report.crisis_event_id: op_id}, synchronize_session=False)
    db.commit()
    return rid


def _statuses(db, ids):
    return {(r.status.value if hasattr(r.status, "value") else r.status)
            for r in db.query(Report).filter(Report.id.in_(ids)).all()}


# ── Operation scope ────────────────────────────────────────────────────────────

def test_operation_cascade_dry_run_then_resolve_percolates(client, analyst_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op Resolve")
    b1, b2 = "osm:way:opR1", "osm:way:opR2"
    ids = [_seed_into_op(client, db, cid=f"opR-{i}", building_id=(b1 if i < 3 else b2), op_id=op.id)
           for i in range(5)]

    # dry-run shows the blast radius without mutating
    dr = client.post(f"/api/v1/operations/{op.id}/cascade/resolve?dry_run=true",
                     headers=auth_header(analyst_token))
    assert dr.status_code == 200, dr.text
    assert dr.json()["dry_run"] is True
    assert dr.json()["counts"]["reports"] == 5
    assert dr.json()["counts"]["buildings"] == 2
    assert _statuses(db, ids) == {"PENDING"}   # unchanged by dry-run

    # execute → percolates to reports + incidents + buildings, returns a log id
    res = client.post(f"/api/v1/operations/{op.id}/cascade/resolve",
                      headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["counts"]["reports"] == 5
    assert body["counts"]["buildings"] == 2
    assert body.get("log_id")
    assert _statuses(db, ids) == {"RESOLVED"}
    incs = db.query(Incident).filter(Incident.building_id.in_([b1, b2])).all()
    assert incs and all(i.status == "RESOLVED" for i in incs)
    blds = db.query(Building).filter(Building.id.in_([b1, b2])).all()
    assert blds and all(b.state == "RESOLVED" for b in blds)
    # ONE audit row (not per-report)
    assert db.query(CascadeActionLog).filter(CascadeActionLog.id == body["log_id"]).count() == 1


def test_operation_cascade_revert_restores(client, analyst_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op Revert")
    ids = [_seed_into_op(client, db, cid=f"opV-{i}", building_id="osm:way:opV", op_id=op.id)
           for i in range(3)]
    res = client.post(f"/api/v1/operations/{op.id}/cascade/resolve", headers=auth_header(analyst_token))
    log_id = res.json()["log_id"]
    assert _statuses(db, ids) == {"RESOLVED"}

    rv = client.post("/api/v1/reports/cascade-revert", headers=auth_header(analyst_token),
                     json={"log_id": log_id})
    assert rv.status_code == 200, rv.text
    assert rv.json()["reports_reverted"] == 3
    assert _statuses(db, ids) == {"PENDING"}
    # second revert is rejected (already reverted)
    rv2 = client.post("/api/v1/reports/cascade-revert", headers=auth_header(analyst_token),
                      json={"log_id": log_id})
    assert rv2.status_code == 400


def test_operation_cascade_queue_filter_narrows_slice(client, analyst_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op Queue")
    crit = [_seed_into_op(client, db, cid=f"opQc-{i}", building_id="osm:way:opQ",
                          op_id=op.id, severity="CRITICAL") for i in range(2)]
    minor = [_seed_into_op(client, db, cid=f"opQm-{i}", building_id="osm:way:opQ",
                           op_id=op.id, severity="MINOR") for i in range(2)]
    res = client.post(f"/api/v1/operations/{op.id}/cascade/resolve",
                      headers=auth_header(analyst_token),
                      json={"filters": {"queue": "critical"}})
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["reports"] == 2   # only the CRITICAL slice
    assert _statuses(db, crit) == {"RESOLVED"}
    assert _statuses(db, minor) == {"PENDING"}     # MINOR untouched


def test_operation_cascade_false_alarm_requires_reason(client, analyst_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op FA")
    _seed_into_op(client, db, cid="opFA-1", building_id="osm:way:opFA", op_id=op.id)
    r0 = client.post(f"/api/v1/operations/{op.id}/cascade/false-alarm", headers=auth_header(analyst_token))
    assert r0.status_code == 400   # reason required
    r1 = client.post(f"/api/v1/operations/{op.id}/cascade/false-alarm",
                     headers=auth_header(analyst_token), json={"reason": "noise"})
    assert r1.status_code == 200, r1.text


def test_operation_cascade_viewer_forbidden(client, viewer_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op Perm")
    r = client.post(f"/api/v1/operations/{op.id}/cascade/resolve", headers=auth_header(viewer_token))
    assert r.status_code in (401, 403)


def test_operation_cascade_unknown_op_404(client, analyst_token):
    r = client.post("/api/v1/operations/does-not-exist/cascade/resolve", headers=auth_header(analyst_token))
    assert r.status_code == 404


# ── Global filtered slice (admin-gated) ─────────────────────────────────────────

def test_global_cascade_admin_resolves_filtered_slice(client, admin_token, analyst_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op Global")
    ids = [_seed_into_op(client, db, cid=f"gC-{i}", building_id="osm:way:gC",
                         op_id=op.id, severity="CRITICAL") for i in range(3)]
    # analyst is NOT allowed a global cascade
    forbidden = client.post("/api/v1/reports/cascade", headers=auth_header(analyst_token),
                            json={"action": "resolve",
                                  "filters": {"crisis_event_id": op.id, "severity": "CRITICAL"}})
    assert forbidden.status_code in (401, 403)
    # admin is
    res = client.post("/api/v1/reports/cascade", headers=auth_header(admin_token),
                      json={"action": "resolve",
                            "filters": {"crisis_event_id": op.id, "severity": "CRITICAL"}})
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["reports"] == 3
    assert _statuses(db, ids) == {"RESOLVED"}


def test_global_cascade_requires_a_filter(client, admin_token):
    r = client.post("/api/v1/reports/cascade", headers=auth_header(admin_token),
                    json={"action": "resolve", "filters": {}})
    assert r.status_code == 400   # no blind whole-DB mutation


def test_global_cascade_unknown_action_400(client, admin_token, admin_user, db):
    op = _mk_op(db, admin_user, "Op BadAct")
    r = client.post("/api/v1/reports/cascade", headers=auth_header(admin_token),
                    json={"action": "explode", "filters": {"crisis_event_id": op.id}})
    assert r.status_code == 400
