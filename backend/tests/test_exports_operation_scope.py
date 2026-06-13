"""Regression — exports must be scopable to one operation (crisis_event_id).

Exporting from inside an operation used to download EVERY report (the filter was
missing). The export endpoints now accept crisis_event_id and filter to that
operation's reports.
"""
import uuid

from tests.conftest import auth_header
from app.models.report import Report, CrisisEvent


def _seed(client, cid):
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "X-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
        "description": "x", "expected_media": 0,
        "location": {"latitude": 25.6, "longitude": 85.1},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_export_count_scopes_to_one_operation(client, db, admin_token):
    tag = uuid.uuid4().hex[:8]
    ev = CrisisEvent(name="ExpOp-" + tag, crisis_type="FLOOD", status="LIVE",
                     is_active=True, center_lat=25.6, center_lng=85.1, radius_km=20.0)
    db.add(ev); db.commit(); db.refresh(ev)
    in_a = [_seed(client, f"ea-{tag}-{i}") for i in range(2)]
    orphan = _seed(client, f"eo-{tag}")          # global, no operation
    db.query(Report).filter(Report.id.in_(in_a)).update(
        {Report.crisis_event_id: ev.id}, synchronize_session=False)
    db.commit()
    try:
        scoped = client.get(f"/api/v1/exports/count?crisis_event_id={ev.id}",
                            headers=auth_header(admin_token)).json()
        glob = client.get("/api/v1/exports/count", headers=auth_header(admin_token)).json()
        # Scoped count = exactly this operation's reports; global sees more (orphan + others).
        assert scoped["count"] == 2
        assert glob["count"] >= 3
        # The orphan report is NOT in the operation-scoped export.
        rows = client.get(f"/api/v1/exports/csv?crisis_event_id={ev.id}",
                         headers=auth_header(admin_token)).text
        assert orphan not in rows
        for rid in in_a:
            assert rid in rows
    finally:
        db.query(Report).filter(Report.id.in_(in_a + [orphan])).delete(synchronize_session=False)
        db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
        db.commit()
