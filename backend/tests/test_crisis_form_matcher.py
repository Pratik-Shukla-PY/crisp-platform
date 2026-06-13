"""resolve_active_event — smallest-radius-wins on overlap (Jun 2026).

When a point sits inside multiple active, in-window, published-pack crisis zones,
the SMALLEST-RADIUS (most specific) zone wins — ties broken by newest activation.
The same matcher backs GET /crisis-forms/active (form selection) AND report intake
(crisis_event_id derivation), so they can never disagree.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.conftest import auth_header
from app.models.report import Report, CrisisEvent


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _publish_pack(client, admin_token, key=None):
    key = key or ("m-" + uuid.uuid4().hex[:8])
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


@pytest.fixture
def overlap(client, db, admin_token):
    """Distinct co-located active zones at (25, 55) for overlap tests. Auto-cleans."""
    created = {"events": [], "reports": []}

    def mk(*, radius, pid=None, age_min=0):
        now = datetime.now(timezone.utc)
        ev = CrisisEvent(name="evt-" + uuid.uuid4().hex[:6], crisis_type="FLOOD",
                         status="LIVE", is_active=True, form_pack_id=pid,
                         center_lat=25.0, center_lng=55.0, radius_km=radius,
                         started_at=now - timedelta(days=1),
                         created_at=now - timedelta(minutes=age_min))
        db.add(ev); db.commit(); db.refresh(ev)
        created["events"].append(ev.id)
        return ev

    yield {"mk": mk, "publish": lambda: _publish_pack(client, admin_token), "state": created}
    db.query(Report).filter(Report.id.in_(created["reports"])).delete(synchronize_session=False)
    db.query(CrisisEvent).filter(CrisisEvent.id.in_(created["events"])).delete(synchronize_session=False)
    db.commit()


def _active(client, lat=25.0, lng=55.0):
    return client.get(f"/api/v1/crisis-forms/active?lat={lat}&lng={lng}").json()


def test_smallest_radius_wins_over_newer_bigger(client, overlap):
    # BIG is newer (would win under the old newest-first rule); SMALL is older +
    # tighter. Smallest-radius must win regardless of age.
    big = overlap["mk"](radius=50.0, pid=overlap["publish"](), age_min=5)
    small = overlap["mk"](radius=5.0, pid=overlap["publish"](), age_min=120)
    body = _active(client)
    assert body["active"] is True
    assert body["event_id"] == small.id
    assert body["event_id"] != big.id


def test_equal_radius_tiebreak_newest(client, overlap):
    older = overlap["mk"](radius=10.0, pid=overlap["publish"](), age_min=120)
    newer = overlap["mk"](radius=10.0, pid=overlap["publish"](), age_min=5)
    body = _active(client)
    assert body["event_id"] == newer.id and body["event_id"] != older.id


def test_smallest_zone_without_published_pack_falls_through(client, overlap):
    # The tightest zone has NO pack → it's skipped; the next-smallest WITH a
    # published pack wins.
    overlap["mk"](radius=5.0, pid=None, age_min=5)          # tightest, no pack
    big = overlap["mk"](radius=50.0, pid=overlap["publish"](), age_min=5)
    body = _active(client)
    assert body["active"] is True and body["event_id"] == big.id


def test_intake_derives_smallest_radius_and_matches_active(client, db, admin_token, overlap):
    big = overlap["mk"](radius=50.0, pid=overlap["publish"](), age_min=5)
    small = overlap["mk"](radius=5.0, pid=overlap["publish"](), age_min=120)
    # /active picks the smallest.
    assert _active(client)["event_id"] == small.id
    # Intake (no-pack chat-channel path): client echoes the BIG event id, but the
    # server re-derives from the submitted location → must land on SMALL.
    cid = str(uuid.uuid4())
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "M-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
        "description": "overlap", "expected_media": 0,
        "crisis_event_id": big.id,                       # wrong/bigger hint
        "location": {"latitude": 25.0, "longitude": 55.0},
    })
    assert r.status_code in (200, 201), r.text
    overlap["state"]["reports"].append(r.json()["id"])
    row = db.query(Report).filter(Report.client_report_id == cid).first()
    assert row.crisis_event_id == small.id     # smallest, re-derived from location
