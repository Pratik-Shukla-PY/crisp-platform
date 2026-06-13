"""Operations Phase 3c — auto-claim write-path (launch / unclaim).

"Launch operation here" creates a CrisisEvent from the un-operationalised
critical cluster (centroid + bounding radius) and bulk-claims those reports;
/unclaim reverses the most recent claim. Dedup: a cluster whose centroid sits
inside a SMALLER existing active op is claimed INTO that op.

The launch endpoint operates over ALL un-operationalised criticals (one cluster),
so each test first clears any leftover orphan-criticals to isolate its own.
"""
import uuid

import pytest

from tests.conftest import auth_header
from app.models.report import (
    Report, CrisisEvent, OperationClaimLog, SeverityEnum, ReportStatusEnum,
)

_CLOSED = [ReportStatusEnum.RESOLVED, ReportStatusEnum.REJECTED, ReportStatusEnum.FALSE_ALARM]


def _clear_orphan_criticals(db):
    db.query(Report).filter(
        Report.severity == SeverityEnum.CRITICAL,
        Report.crisis_event_id.is_(None),
        Report.deletion_requested_at.is_(None),
        Report.status.notin_(_CLOSED),
    ).delete(synchronize_session=False)
    db.commit()


def _seed_critical(client, cid, lat=25.0, lng=55.0):
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "C-" + uuid.uuid4().hex[:10], "client_report_id": cid,
        "source": "APP", "severity": "CRITICAL", "infrastructure_type": "ROAD",
        "description": "crit", "expected_media": 0,
        "location": {"latitude": lat, "longitude": lng},
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def claim_world(client, db, admin_token):
    _clear_orphan_criticals(db)        # isolate this test's cluster
    state = {"ops": [], "reports": []}
    yield state
    # delete ops first (FK SET NULL un-claims their reports), then logs + reports.
    for opid in state["ops"]:
        db.query(OperationClaimLog).filter(
            OperationClaimLog.operation_id == opid).delete(synchronize_session=False)
        db.query(CrisisEvent).filter(CrisisEvent.id == opid).delete(synchronize_session=False)
    if state["reports"]:
        db.query(Report).filter(Report.id.in_(state["reports"])).delete(synchronize_session=False)
    db.commit()


def test_launch_creates_operation_and_claims_cluster(client, admin_token, db, claim_world):
    tag = uuid.uuid4().hex[:6]
    ids = [_seed_critical(client, f"cl-{tag}-{i}") for i in range(3)]
    claim_world["reports"] += ids
    res = client.post("/api/v1/operations/launch",
                      json={"name": f"Cluster Op {tag}", "crisis_type": "FLOOD"},
                      headers=auth_header(admin_token))
    assert res.status_code == 201, res.text
    body = res.json()
    claim_world["ops"].append(body["operation_id"])
    assert body["claimed_count"] == 3 and body["merged_into_existing"] is False
    db.expire_all()
    for rid in ids:
        assert db.query(Report).filter(Report.id == rid).first().crisis_event_id == body["operation_id"]
    op = db.query(CrisisEvent).filter(CrisisEvent.id == body["operation_id"]).first()
    assert op is not None and 0 < op.radius_km <= 30.0
    # an audit row records the claim for undo.
    log = db.query(OperationClaimLog).filter(
        OperationClaimLog.operation_id == body["operation_id"],
        OperationClaimLog.event_kind == "CLAIMED").first()
    assert log is not None and log.report_count == 3


def test_undo_restores_orphans(client, admin_token, db, claim_world):
    tag = uuid.uuid4().hex[:6]
    ids = [_seed_critical(client, f"un-{tag}-{i}") for i in range(2)]
    claim_world["reports"] += ids
    opid = client.post("/api/v1/operations/launch", json={"name": f"Undo Op {tag}"},
                       headers=auth_header(admin_token)).json()["operation_id"]
    claim_world["ops"].append(opid)
    un = client.post(f"/api/v1/operations/{opid}/unclaim", headers=auth_header(admin_token))
    assert un.status_code == 200, un.text
    assert un.json()["unclaimed_count"] == 2
    db.expire_all()
    for rid in ids:
        assert db.query(Report).filter(Report.id == rid).first().crisis_event_id is None


def test_double_launch_second_finds_nothing(client, admin_token, db, claim_world):
    tag = uuid.uuid4().hex[:6]
    ids = [_seed_critical(client, f"db-{tag}-{i}") for i in range(2)]
    claim_world["reports"] += ids
    b1 = client.post("/api/v1/operations/launch", json={"name": f"First {tag}"},
                     headers=auth_header(admin_token))
    assert b1.status_code == 201
    claim_world["ops"].append(b1.json()["operation_id"])
    # all orphan criticals are now claimed → the re-check leaves nothing to claim.
    b2 = client.post("/api/v1/operations/launch", json={"name": f"Second {tag}"},
                     headers=auth_header(admin_token))
    assert b2.status_code == 409


def test_launch_dedups_into_smaller_existing_op(client, admin_token, db, claim_world):
    tag = uuid.uuid4().hex[:6]
    small = CrisisEvent(name=f"Small {tag}", crisis_type="FLOOD", status="LIVE",
                        is_active=True, center_lat=25.0, center_lng=55.0, radius_km=3.0)
    db.add(small); db.commit(); db.refresh(small)
    claim_world["ops"].append(small.id)
    ids = [_seed_critical(client, f"dd-{tag}-{i}", lat=25.0, lng=55.0) for i in range(2)]
    claim_world["reports"] += ids
    res = client.post("/api/v1/operations/launch", json={"name": f"NewBig {tag}"},
                      headers=auth_header(admin_token))
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["merged_into_existing"] is True
    assert body["operation_id"] == small.id
    db.expire_all()
    for rid in ids:
        assert db.query(Report).filter(Report.id == rid).first().crisis_event_id == small.id
