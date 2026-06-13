"""Operations Phase 2a — backend rollup + operation-scoped filters.

Covers:
  * GET /api/v1/operations — one-query per-event rollup (Critical·New·Total·last),
    active-first, + the un-operationalised critical "cluster" row.
  * require_viewer gate.
  * GET /api/v1/reports/?crisis_event_id= — scoped feed + scoped X-Total-Count.
  * GET /api/v1/analytics/summary?crisis_event_id= — scoped counts + cache-key
    isolation (event A's counts never served for event B).
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.conftest import auth_header
from app.models.report import Report, CrisisEvent


def _seed(client, *, cid, severity="MODERATE", device=None):
    device = device or ("OPS-" + uuid.uuid4().hex[:10])
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": device, "client_report_id": cid,
        "source": "APP", "severity": severity,
        "infrastructure_type": "ROAD", "description": "ops list test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def ops_world(client, db, admin_token):
    """Two operations (A, B) + linked reports, plus an orphan critical report.
    Cleans up events AND reports on teardown so active events don't pollute
    other suites (e.g. /crisis-forms/active matching, the global cluster count)."""
    tag = uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    A = CrisisEvent(name=f"OpA-{tag}", crisis_type="FLOOD", status="LIVE",
                    is_active=True, center_lat=12.97, center_lng=77.59, radius_km=30.0,
                    started_at=now - timedelta(days=1))
    B = CrisisEvent(name=f"OpB-{tag}", crisis_type="WILDFIRE", status="LIVE",
                    is_active=True, center_lat=50.0, center_lng=8.0, radius_km=30.0,
                    started_at=now - timedelta(days=2))
    db.add_all([A, B]); db.commit(); db.refresh(A); db.refresh(B)

    created = {"A": A.id, "B": B.id, "tag": tag, "reports": []}
    # A: 2 critical + 1 moderate, all recent (new_24h = 3, critical = 2, total = 3)
    for i, sev in enumerate(["CRITICAL", "CRITICAL", "MODERATE"]):
        rid = _seed(client, cid=f"a-{tag}-{i}", severity=sev)
        created["reports"].append(rid)
    # B: 1 critical (critical = 1, total = 1)
    rid = _seed(client, cid=f"b-{tag}-0", severity="CRITICAL")
    created["reports"].append(rid)
    # orphan critical (no operation) — should land in the cluster row, not A/B
    orphan = _seed(client, cid=f"orphan-{tag}", severity="CRITICAL")
    created["reports"].append(orphan)

    # Link reports to their events (intake leaves crisis_event_id NULL here).
    a_ids = [r for r in created["reports"][:3]]
    b_ids = [created["reports"][3]]
    db.query(Report).filter(Report.id.in_(a_ids)).update(
        {Report.crisis_event_id: A.id}, synchronize_session=False)
    db.query(Report).filter(Report.id.in_(b_ids)).update(
        {Report.crisis_event_id: B.id}, synchronize_session=False)
    db.commit()
    yield created

    # teardown — delete reports first, then events.
    db.query(Report).filter(Report.id.in_(created["reports"])).delete(synchronize_session=False)
    db.query(CrisisEvent).filter(CrisisEvent.id.in_([A.id, B.id])).delete(synchronize_session=False)
    db.commit()


def _find(ops, op_id):
    return next((o for o in ops if o.get("id") == op_id), None)


def test_operations_list_rollup(client, admin_token, ops_world):
    res = client.get("/api/v1/operations", headers=auth_header(admin_token))
    assert res.status_code == 200, res.text
    ops = res.json()
    a = _find(ops, ops_world["A"])
    b = _find(ops, ops_world["B"])
    assert a and b
    assert a["total"] == 3 and a["critical"] == 2 and a["new_24h"] == 3
    assert a["is_active"] is True and a["last_activity"] is not None
    assert b["total"] == 1 and b["critical"] == 1
    assert a["is_cluster"] is False


def test_operations_list_has_orphan_cluster_row(client, admin_token, ops_world):
    res = client.get("/api/v1/operations", headers=auth_header(admin_token))
    ops = res.json()
    cluster = next((o for o in ops if o.get("is_cluster")), None)
    assert cluster is not None, "expected an un-operationalised critical cluster row"
    assert cluster["id"] is None and cluster["critical"] >= 1


def test_operations_requires_auth(client):
    res = client.get("/api/v1/operations")
    assert res.status_code in (401, 403)


def test_reports_filter_scopes_feed_and_total(client, admin_token, ops_world):
    res = client.get(f"/api/v1/reports/?crisis_event_id={ops_world['A']}",
                     headers=auth_header(admin_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert all(r["crisis_event_id"] == ops_world["A"] for r in body)
    assert int(res.headers["X-Total-Count"]) == 3   # scoped, not the global total


def test_operations_count_parity_with_reports_filter(client, admin_token, ops_world):
    ops = client.get("/api/v1/operations", headers=auth_header(admin_token)).json()
    a = _find(ops, ops_world["A"])
    feed = client.get(f"/api/v1/reports/?crisis_event_id={ops_world['A']}&limit=500",
                      headers=auth_header(admin_token))
    assert a["total"] == int(feed.headers["X-Total-Count"])


def test_summary_scoped_and_cache_isolated(client, admin_token, ops_world):
    sa = client.get(f"/api/v1/analytics/summary?crisis_event_id={ops_world['A']}",
                    headers=auth_header(admin_token)).json()
    sb = client.get(f"/api/v1/analytics/summary?crisis_event_id={ops_world['B']}",
                    headers=auth_header(admin_token)).json()
    sg = client.get("/api/v1/analytics/summary", headers=auth_header(admin_token)).json()
    # A has 2 critical, B has 1 — scoped counts differ (cache key isolates them).
    assert sa["counts"]["critical"] == 2
    assert sb["counts"]["critical"] == 1
    assert sa["total_reports"] == 3 and sb["total_reports"] == 1
    # global is a superset of either operation.
    assert sg["total_reports"] >= sa["total_reports"] + sb["total_reports"]
