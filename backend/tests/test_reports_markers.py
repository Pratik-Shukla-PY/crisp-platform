"""P3 — GET /reports/markers: lightweight map markers that scale past newest-500.

The dashboard map used GET /reports/?limit=200 (heavy rows, capped at 500), so at
scale it plotted a non-representative slice. /reports/markers returns lean rows
(id, coords, severity, status, type) with a much higher cap + optional bbox /
operation scope.
"""
import uuid

from tests.conftest import auth_header
from app.models.report import Report, CrisisEvent


def _seed(client, cid, *, lat, lng, severity="MODERATE"):
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "M-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": severity, "infrastructure_type": "ROAD",
        "description": "x", "expected_media": 0,
        "location": {"latitude": lat, "longitude": lng},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_markers_are_lean_and_filterable(client, db, admin_token):
    tag = uuid.uuid4().hex[:8]
    ev = CrisisEvent(name="Mk-" + tag, crisis_type="FLOOD", status="LIVE", is_active=True,
                     center_lat=25.0, center_lng=85.0, radius_km=30.0)
    db.add(ev); db.commit(); db.refresh(ev)
    near = _seed(client, f"mn-{tag}", lat=25.0, lng=85.0, severity="CRITICAL")   # in bbox + op
    far = _seed(client, f"mf-{tag}", lat=-40.0, lng=-70.0)                       # outside bbox, no op
    db.query(Report).filter(Report.id == near).update(
        {Report.crisis_event_id: ev.id}, synchronize_session=False)
    db.commit()
    try:
        # Lean shape — flat lat/lng + severity/status, NO media/location object.
        body = client.get("/api/v1/reports/markers?limit=20000",
                          headers=auth_header(admin_token)).json()
        m = next(x for x in body if x["id"] == near)
        assert m["lat"] == 25.0 and m["lng"] == 85.0
        assert m["severity"] == "CRITICAL"
        assert "status" in m and "crisis_type" in m
        assert "location" not in m and "media" not in m and "ai_analysis" not in m

        # bbox filter — `far` is excluded.
        ids_bbox = {x["id"] for x in client.get(
            "/api/v1/reports/markers?bbox=80,20,90,30", headers=auth_header(admin_token)).json()}
        assert near in ids_bbox and far not in ids_bbox

        # operation scope — only the op's reports.
        ids_op = {x["id"] for x in client.get(
            f"/api/v1/reports/markers?crisis_event_id={ev.id}", headers=auth_header(admin_token)).json()}
        assert near in ids_op and far not in ids_op

        # limit is capped (<= 20000) and the endpoint is happy with a tiny limit.
        small = client.get("/api/v1/reports/markers?limit=1", headers=auth_header(admin_token)).json()
        assert len(small) <= 1
    finally:
        db.query(Report).filter(Report.id.in_([near, far])).delete(synchronize_session=False)
        db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
        db.commit()


def test_markers_rejects_bad_bbox(client, admin_token):
    r = client.get("/api/v1/reports/markers?bbox=not,a,bbox", headers=auth_header(admin_token))
    assert r.status_code == 422
