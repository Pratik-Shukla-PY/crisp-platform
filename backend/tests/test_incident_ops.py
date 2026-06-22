"""Building-centric Incident-Feed redesign Phase 2D — analyst incident operations.

The analyst is the AUTHORITY over incident assembly. Covers the read APIs the
detail view needs + merge / move / split / patch, including roll-up recompute,
empty-incident cleanup, severity-override pinning, and ANALYST+ gating.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import (
    Device, Report, Incident, SourceEnum, SyncStatusEnum, CrisisTypeEnum, SeverityEnum,
)
from tests.conftest import auth_header

API = "/api/v1/incidents"


def _device(db):
    d = Device(device_hash=f"dev-{uuid.uuid4().hex[:12]}")
    db.add(d)
    db.flush()
    return d


def _incident_with_reports(db, *, building_id, specs):
    """specs: list of (severity, crisis_type). Returns (incident, [reports])."""
    inc = Incident(building_id=building_id, status="OPEN")
    db.add(inc)
    db.flush()
    now = datetime.now(timezone.utc)
    reports = []
    for i, (sev, ct) in enumerate(specs):
        r = Report(
            device_id=_device(db).id, source=SourceEnum.APP,
            client_report_id=f"io-{uuid.uuid4().hex}", building_id=building_id,
            crisis_type=ct, severity=sev, incident_id=inc.id,
            sync_status=SyncStatusEnum.SYNCED, expected_media=0, received_media=0,
            server_created_at=now - timedelta(minutes=10 * (len(specs) - i)),
        )
        db.add(r)
        db.flush()
        reports.append(r)
    inc.report_count = len(reports)
    inc.lead_report_id = reports[0].id
    inc.incident_type = reports[0].crisis_type
    inc.severity = max((s for s, _ in specs), key=lambda s: ["UNKNOWN", "MINOR", "MODERATE", "SEVERE", "CRITICAL"].index(s.value)).value
    db.flush()
    return inc, reports


def test_get_incident_with_members(client, db, viewer_token):
    b = "io-" + uuid.uuid4().hex[:8]
    inc, reps = _incident_with_reports(db, building_id=b, specs=[
        (SeverityEnum.MODERATE, CrisisTypeEnum.EARTHQUAKE),
        (SeverityEnum.CRITICAL, CrisisTypeEnum.EARTHQUAKE),
    ])
    db.commit()

    res = client.get(f"{API}/{inc.id}", headers=auth_header(viewer_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["report_count"] == 2
    assert len(body["reports"]) == 2
    assert sum(1 for r in body["reports"] if r["is_lead"]) == 1


def test_list_incidents_scoped(client, db, viewer_token):
    b = "io-list-" + uuid.uuid4().hex[:8]
    _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.SEVERE, CrisisTypeEnum.FLOOD)])
    _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MINOR, CrisisTypeEnum.FLOOD)])
    db.commit()

    res = client.get(f"{API}?building_id={b}", headers=auth_header(viewer_token))
    assert res.status_code == 200, res.text
    assert res.headers.get("X-Total-Count") == "2"
    rows = res.json()
    assert len(rows) == 2
    # worst-first: SEVERE before MINOR
    assert rows[0]["severity"] == "SEVERE"


def test_merge_incidents(client, db, analyst_token):
    b = "io-merge-" + uuid.uuid4().hex[:8]
    a, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MODERATE, CrisisTypeEnum.EARTHQUAKE)])
    src, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.CRITICAL, CrisisTypeEnum.EARTHQUAKE)])
    db.commit()

    res = client.post(f"{API}/{a.id}/merge", json={"source_incident_id": src.id},
                      headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    assert res.json()["incident"]["report_count"] == 2

    db.expunge_all()
    target = db.query(Incident).filter(Incident.id == a.id).first()
    assert target.report_count == 2
    assert target.severity == "CRITICAL", "merged severity = max across both"
    assert db.query(Incident).filter(Incident.id == src.id).count() == 0, "source deleted"


def test_move_report_recomputes_both_and_deletes_empty_source(client, db, analyst_token):
    b = "io-move-" + uuid.uuid4().hex[:8]
    a, areps = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MODERATE, CrisisTypeEnum.FLOOD)])
    c, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MINOR, CrisisTypeEnum.FLOOD)])
    a_id, c_id, rep_id = a.id, c.id, areps[0].id   # capture before detaching
    db.commit()

    # Move A's only report into C → A becomes empty → deleted; C grows to 2.
    res = client.post(f"{API}/move-report",
                      json={"report_id": rep_id, "target_incident_id": c_id},
                      headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    assert res.json()["moved"] is True

    db.expunge_all()
    assert db.query(Report).filter(Report.id == rep_id).first().incident_id == c_id
    assert db.query(Incident).filter(Incident.id == c_id).first().report_count == 2
    assert db.query(Incident).filter(Incident.id == a_id).count() == 0, "emptied source deleted"


def test_split_report_into_new_incident(client, db, analyst_token):
    b = "io-split-" + uuid.uuid4().hex[:8]
    a, areps = _incident_with_reports(db, building_id=b, specs=[
        (SeverityEnum.MODERATE, CrisisTypeEnum.WILDFIRE),
        (SeverityEnum.SEVERE, CrisisTypeEnum.WILDFIRE),
    ])
    db.commit()

    res = client.post(f"{API}/split-report", json={"report_id": areps[1].id},
                      headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    assert res.json()["split"] is True
    new_id = res.json()["incident"]["id"]
    assert new_id != a.id

    db.expire_all()
    assert db.query(Report).filter(Report.id == areps[1].id).first().incident_id == new_id
    assert db.query(Incident).filter(Incident.id == a.id).first().report_count == 1
    assert db.query(Incident).filter(Incident.id == new_id).first().report_count == 1


def test_patch_incident_status_and_severity_override(client, db, analyst_token):
    b = "io-patch-" + uuid.uuid4().hex[:8]
    a, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MINOR, CrisisTypeEnum.FLOOD)])
    db.commit()

    res = client.patch(f"{API}/{a.id}", json={"status": "RESPONDING", "severity": "CRITICAL"},
                       headers=auth_header(analyst_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "RESPONDING"
    assert body["severity"] == "CRITICAL"
    assert body["severity_overridden"] is True

    # Invalid status is rejected.
    bad = client.patch(f"{API}/{a.id}", json={"status": "BOGUS"}, headers=auth_header(analyst_token))
    assert bad.status_code == 422


def test_mutations_require_analyst(client, db, viewer_token):
    b = "io-rbac-" + uuid.uuid4().hex[:8]
    a, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MINOR, CrisisTypeEnum.FLOOD)])
    src, _ = _incident_with_reports(db, building_id=b, specs=[(SeverityEnum.MINOR, CrisisTypeEnum.FLOOD)])
    db.commit()

    res = client.post(f"{API}/{a.id}/merge", json={"source_incident_id": src.id},
                      headers=auth_header(viewer_token))
    assert res.status_code == 403, "a VIEWER must not be able to merge incidents"
