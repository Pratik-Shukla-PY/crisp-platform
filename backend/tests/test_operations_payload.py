"""P2 — /operations payload extension (card fields) + PAUSED activation guard.

The redesigned operation card needs form_name, started_at/ended_at, radius_km,
verified, and place_name — all added to OperationSummaryResponse and computed in
the existing single grouped query (no N+1). A PAUSED operation must be forced
is_active=False so it stops matching new reports.
"""
import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import auth_header
from app.models.report import Report, CrisisEvent, CrisisFormPack, ReviewerVerdictEnum


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _seed(client, cid, cev_id=None, severity="MODERATE"):
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "P-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": severity, "infrastructure_type": "ROAD",
        "description": "x", "expected_media": 0,
        "location": {"latitude": 25.6, "longitude": 85.1},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_operations_payload_carries_card_fields(client, db, admin_token):
    tag = uuid.uuid4().hex[:8]
    pack = CrisisFormPack(key="p-" + tag, title="Flood Assessment v2")
    db.add(pack); db.commit(); db.refresh(pack)
    now = datetime.now(timezone.utc)
    ev = CrisisEvent(name="Bihar Floods " + tag, crisis_type="FLOOD",
                     status="LIVE", is_active=True, center_lat=25.6, center_lng=85.1,
                     radius_km=22.0, started_at=now - timedelta(days=2),
                     form_pack_id=pack.id, place_name="Patna, India")
    db.add(ev); db.commit(); db.refresh(ev)
    rid = _seed(client, "pv-" + tag)
    db.query(Report).filter(Report.id == rid).update(
        {Report.crisis_event_id: ev.id,
         Report.reviewer_verdict: ReviewerVerdictEnum.ACCEPTED.value},
        synchronize_session=False)
    db.commit()
    try:
        ops = client.get("/api/v1/operations", headers=auth_header(admin_token)).json()
        op = next(o for o in ops if o["id"] == ev.id)
        # All the new card fields are present + correct (one grouped query).
        assert op["form_name"] == "Flood Assessment v2"
        assert op["form_pack_id"] == pack.id
        assert op["radius_km"] == 22.0
        assert op["place_name"] == "Patna, India"
        assert op["started_at"] is not None
        assert op["ended_at"] is None
        assert op["verified"] >= 1
        assert op["total"] >= 1
    finally:
        db.query(Report).filter(Report.id == rid).delete(synchronize_session=False)
        db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
        db.query(CrisisFormPack).filter(CrisisFormPack.id == pack.id).delete(synchronize_session=False)
        db.commit()


def test_end_forces_inactive_and_rejects_paused(client, db, admin_token):
    # Two-state model (redesign v2): the only legal transition off LIVE is ENDED,
    # which forces is_active=False (the "End operation" action). PAUSED/DRAFT are
    # removed and rejected at the API boundary (422).
    tag = uuid.uuid4().hex[:8]
    ev = CrisisEvent(name="End " + tag, crisis_type="FLOOD", status="LIVE",
                     is_active=True, center_lat=1.0, center_lng=1.0, radius_km=10.0)
    db.add(ev); db.commit(); db.refresh(ev)
    try:
        # Removed statuses are rejected by the schema validator.
        bad = client.patch(f"/api/v1/admin/crisis-forms/events/{ev.id}",
                           json={"status": "PAUSED"}, headers=_h(admin_token))
        assert bad.status_code == 422, bad.text

        # Ending the operation forces it inactive.
        resp = client.patch(f"/api/v1/admin/crisis-forms/events/{ev.id}",
                            json={"status": "ENDED"}, headers=_h(admin_token))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ENDED"
        assert body["is_active"] is False   # activation gate: ENDED ⇒ inactive
        # And it now ships on /operations with the ENDED status.
        ops = client.get("/api/v1/operations", headers=auth_header(admin_token)).json()
        op = next(o for o in ops if o["id"] == ev.id)
        assert op["status"] == "ENDED" and op["is_active"] is False
    finally:
        db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
        db.commit()
