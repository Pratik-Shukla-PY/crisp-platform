"""Operations Phase 3a — operation-level responders (BuildingResponder Option B).

A responder can target an OPERATION (target_type=OPERATION, crisis_event_id set,
building_id NULL) reusing the building_responders table — no separate Team/Org
entity. Same assigned → dispatched → arrived → cleared lifecycle; cleared_at IS
NULL = active.
"""
import uuid
from datetime import datetime, timezone

import pytest

from tests.conftest import auth_header
from app.models.report import CrisisEvent, BuildingResponder


@pytest.fixture
def op(db):
    ev = CrisisEvent(name="RespOp-" + uuid.uuid4().hex[:6], crisis_type="FLOOD",
                     status="LIVE", is_active=True, center_lat=12.97, center_lng=77.59,
                     radius_km=30.0)
    db.add(ev); db.commit(); db.refresh(ev)
    yield ev
    db.query(BuildingResponder).filter(BuildingResponder.crisis_event_id == ev.id).delete(
        synchronize_session=False)
    db.query(CrisisEvent).filter(CrisisEvent.id == ev.id).delete(synchronize_session=False)
    db.commit()


def test_assign_operation_responder_is_operation_targeted(client, admin_token, op, db):
    r = client.post(f"/api/v1/operations/{op.id}/responders",
                    json={"responder_name": "Relief Team A", "org_type": "NGO", "eta_minutes": 15},
                    headers=auth_header(admin_token))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["target_type"] == "OPERATION"
    assert body["crisis_event_id"] == op.id
    assert body["building_id"] is None
    assert body["org_type"] == "NGO"
    row = db.query(BuildingResponder).filter(BuildingResponder.id == body["id"]).first()
    assert row.building_id is None and row.crisis_event_id == op.id and row.cleared_at is None


def test_list_and_lifecycle(client, admin_token, op):
    rid = client.post(f"/api/v1/operations/{op.id}/responders",
                      json={"responder_name": "Relief Team B"},
                      headers=auth_header(admin_token)).json()["id"]
    lst = client.get(f"/api/v1/operations/{op.id}/responders", headers=auth_header(admin_token))
    assert lst.status_code == 200 and any(x["id"] == rid for x in lst.json())
    pa = client.patch(f"/api/v1/operations/{op.id}/responders/{rid}",
                      json={"action": "dispatched"}, headers=auth_header(admin_token))
    assert pa.status_code == 200 and pa.json()["dispatched_at"] is not None
    pc = client.patch(f"/api/v1/operations/{op.id}/responders/{rid}",
                      json={"action": "cleared"}, headers=auth_header(admin_token))
    assert pc.json()["cleared_at"] is not None


def test_default_org_type_is_other(client, admin_token, op):
    body = client.post(f"/api/v1/operations/{op.id}/responders",
                       json={"responder_name": "Team C"},
                       headers=auth_header(admin_token)).json()
    assert body["org_type"] == "OTHER"


def test_invalid_org_type_rejected(client, admin_token, op):
    r = client.post(f"/api/v1/operations/{op.id}/responders",
                    json={"responder_name": "X", "org_type": "WRONG"},
                    headers=auth_header(admin_token))
    assert r.status_code == 422


def test_assign_requires_existing_operation(client, admin_token):
    r = client.post("/api/v1/operations/does-not-exist/responders",
                    json={"responder_name": "X"}, headers=auth_header(admin_token))
    assert r.status_code == 404
