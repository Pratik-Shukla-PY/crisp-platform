"""PATCH /reports/{id}/location — edited location re-evaluates operation assignment.

When the reporter corrects the location (Telegram / WhatsApp / dashboard pin-fix),
the edited point is authoritative: passing ``reresolve_operation: true`` re-derives
``crisis_event_id`` from the new coords via the SAME smallest-radius matcher /active
+ intake use — re-homing the report to the operation containing it, or clearing the
link when it leaves every zone. WITHOUT the flag (AI/SMS/IVR backfill) the link is
untouched, preserving the GLOBAL-by-design contract (no fake-matching).
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.report import Report, CrisisEvent


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _publish_pack(client, admin_token):
    key = "lr-" + uuid.uuid4().hex[:8]
    p = client.post("/api/v1/admin/crisis-forms/packs",
                    json={"key": key, "title": "Pack " + key}, headers=_h(admin_token))
    assert p.status_code == 201, p.text
    pid = p.json()["id"]
    schema = {"key": key, "title": "Pack", "sections": [{"id": "s1", "stage": 2, "fields": [
        {"key": "q1", "type": "yes_no", "label": "Anything?", "required": False}]}]}
    v = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/versions",
                    json={"schema_json": schema}, headers=_h(admin_token))
    assert v.status_code in (200, 201), v.text
    pub = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/publish",
                      json={"version": 1}, headers=_h(admin_token))
    assert pub.status_code in (200, 201), pub.text
    return pid


def _seed_report(client, *, lat, lng):
    """A plain report at (lat,lng) — starts GLOBAL (crisis_event_id NULL)."""
    cid = str(uuid.uuid4())
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "L-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
        "description": "x", "expected_media": 0,
        "location": {"latitude": lat, "longitude": lng},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"], cid


def _patch_loc(client, rid, *, lat, lng, reresolve=None):
    body = {"latitude": lat, "longitude": lng}
    if reresolve is not None:
        body["reresolve_operation"] = reresolve
    return client.patch(f"/api/v1/reports/{rid}/location", json=body)


@pytest.fixture
def zone(client, db, admin_token):
    """One active zone (radius 10 km) at (25,55) with a published pack. Auto-cleans."""
    created = {"events": [], "reports": []}
    now = datetime.now(timezone.utc)
    ev = CrisisEvent(name="LR-" + uuid.uuid4().hex[:6], crisis_type="FLOOD",
                     status="LIVE", is_active=True, form_pack_id=_publish_pack(client, admin_token),
                     center_lat=25.0, center_lng=55.0, radius_km=10.0,
                     started_at=now - timedelta(days=1))
    db.add(ev); db.commit(); db.refresh(ev)
    created["events"].append(ev.id)
    yield {"event": ev, "state": created, "publish": lambda: _publish_pack(client, admin_token)}
    db.query(Report).filter(Report.id.in_(created["reports"])).delete(synchronize_session=False)
    db.query(CrisisEvent).filter(CrisisEvent.id.in_(created["events"])).delete(synchronize_session=False)
    db.commit()


def test_edit_into_zone_links_operation(client, db, zone):
    # Report starts FAR from the zone → GLOBAL.
    rid, cid = _seed_report(client, lat=10.0, lng=10.0)
    zone["state"]["reports"].append(rid)
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id is None
    # Correct the location INTO the zone with the opt-in flag → re-homes.
    r = _patch_loc(client, rid, lat=25.0, lng=55.0, reresolve=True)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id == zone["event"].id


def test_edit_out_of_zone_clears_operation(client, db, zone):
    rid, cid = _seed_report(client, lat=10.0, lng=10.0)
    zone["state"]["reports"].append(rid)
    # First move IN (link), then move OUT (clear).
    _patch_loc(client, rid, lat=25.0, lng=55.0, reresolve=True)
    db.expire_all()
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id == zone["event"].id
    r = _patch_loc(client, rid, lat=40.0, lng=80.0, reresolve=True)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id is None


def test_no_flag_leaves_link_untouched(client, db, zone):
    # GLOBAL report moved INTO the zone WITHOUT the flag → stays GLOBAL (SMS/IVR
    # contract: coarse backfill never fake-matches an operation).
    rid, cid = _seed_report(client, lat=10.0, lng=10.0)
    zone["state"]["reports"].append(rid)
    r = _patch_loc(client, rid, lat=25.0, lng=55.0)   # no reresolve_operation
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id is None


def test_edit_into_overlap_picks_smallest_radius(client, db, zone):
    # A tighter zone co-located with the fixture zone → the edited point inside
    # both must re-home to the SMALLEST-radius operation.
    now = datetime.now(timezone.utc)
    small = CrisisEvent(name="LRsmall-" + uuid.uuid4().hex[:6], crisis_type="FLOOD",
                        status="LIVE", is_active=True, form_pack_id=zone["publish"](),
                        center_lat=25.0, center_lng=55.0, radius_km=3.0,
                        started_at=now - timedelta(days=1))
    db.add(small); db.commit(); db.refresh(small)
    zone["state"]["events"].append(small.id)
    rid, cid = _seed_report(client, lat=10.0, lng=10.0)
    zone["state"]["reports"].append(rid)
    r = _patch_loc(client, rid, lat=25.0, lng=55.0, reresolve=True)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Report).filter(Report.id == rid).first().crisis_event_id == small.id
