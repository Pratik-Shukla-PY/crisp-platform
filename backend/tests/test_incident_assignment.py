"""Building-centric Incident-Feed redesign Phase 2B — intake incident assignment.

Every report (all 6 channels, via the shared create_report_meta path) is assigned
to a first-class Incident at intake: it JOINS the best same-building incident only
on HIGH duplicate confidence (>=88, reusing _rdd_score_pair), else it SEEDS its own
incident. Conservative BY DESIGN — distinct same-building events (Floor 1/7/10,
which score MEDIUM/LOW) stay SEPARATE incidents.

Coverage:
  - parity: a report submitted through the /reports/meta endpoint comes out with an
    incident_id (proves the hook is wired into the shared path → all 6 channels).
  - HIGH-join: a near-identical re-report (same building/crisis/time/description/
    device ⇒ score 89) joins the existing incident; severity rolls up to the max.
  - distinct: three same-building/same-crisis/within-1h reports with no shared
    description (⇒ score 63, below the 88 join floor) stay 3 separate incidents.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import (
    Device, Report, Incident, SourceEnum, SyncStatusEnum, CrisisTypeEnum, SeverityEnum,
)
from app.api.endpoints.reports import _assign_incident


def _device(db):
    d = Device(device_hash=f"dev-{uuid.uuid4().hex[:12]}")
    db.add(d)
    db.flush()
    return d


def _seed(db, *, device, building_id, crisis_type, when, description=None,
          severity=SeverityEnum.MODERATE):
    r = Report(
        device_id=device.id,
        source=SourceEnum.APP,
        client_report_id=f"inc-{uuid.uuid4().hex}",
        building_id=building_id,
        crisis_type=crisis_type,
        severity=severity,
        description=description,
        sync_status=SyncStatusEnum.SYNCED,
        expected_media=0,
        received_media=0,
        server_created_at=when,
    )
    db.add(r)
    db.flush()
    return r


def test_meta_endpoint_assigns_incident(client, db):
    """A report submitted via the shared /reports/meta path comes out assigned to a
    fresh incident (must-have #1 parity — the hook fires for every channel)."""
    dev = f"DEV-INC-{uuid.uuid4().hex[:8]}"
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": dev,
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "SEVERE",
        "infrastructure_type": "HOSPITAL",
        "crisis_type": "EARTHQUAKE",
        "damage_classification": "PARTIAL",
        "description": "intake incident-assignment parity test",
        "expected_media": 0,
        # Unusual coordinate (Frankfurt) so proximity building-assignment never
        # collides with the Bangalore fixtures other tests seed → deterministic
        # singleton incident.
        "location": {"latitude": 50.1109, "longitude": 8.6821},
    })
    assert res.status_code == 201, res.text
    rid = res.json()["id"]

    r = db.query(Report).filter(Report.id == rid).first()
    assert r is not None, "report row not found"
    assert r.incident_id, "report must be assigned an incident at intake"

    inc = db.query(Incident).filter(Incident.id == r.incident_id).first()
    assert inc is not None, "the assigned incident row must exist"
    assert inc.report_count == 1
    assert inc.lead_report_id == rid
    assert inc.status == "OPEN"
    assert inc.incident_type == "EARTHQUAKE"


def test_high_confidence_report_joins_existing_incident(db):
    """Same building + crisis + within 1h + identical description + same device
    ⇒ score 89 (>=88 HIGH) ⇒ the second report JOINS the first's incident; the
    incident's severity rolls up to the max of its members."""
    bid = "inc-join-" + uuid.uuid4().hex[:8]
    dev = _device(db)
    now = datetime.now(timezone.utc)
    desc = "Residential block collapsed, multiple people trapped under the rubble"

    a = _seed(db, device=dev, building_id=bid, crisis_type=CrisisTypeEnum.EARTHQUAKE,
              when=now - timedelta(minutes=20), description=desc, severity=SeverityEnum.MODERATE)
    _assign_incident(a, db)
    db.commit()
    assert a.incident_id, "first report must seed an incident"
    inc_id = a.incident_id

    b = _seed(db, device=dev, building_id=bid, crisis_type=CrisisTypeEnum.EARTHQUAKE,
              when=now, description=desc, severity=SeverityEnum.CRITICAL)
    _assign_incident(b, db)
    db.commit()

    assert b.incident_id == inc_id, "HIGH-confidence duplicate must join the existing incident"
    inc = db.query(Incident).filter(Incident.id == inc_id).first()
    assert inc.report_count == 2
    assert inc.severity == "CRITICAL", "incident severity must be the max across members"


def test_distinct_same_building_reports_stay_separate(db):
    """Floor 1/7/10: three same-building, same-crisis, within-1h reports with NO
    shared description + different devices ⇒ score 63 (< 88) ⇒ they must remain
    three DISTINCT incidents (duplicate detection never DEFINES incident identity)."""
    bid = "inc-distinct-" + uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    reports = []
    for i in range(3):
        d = _device(db)   # different reporter each time (no same-device bonus)
        r = _seed(db, device=d, building_id=bid, crisis_type=CrisisTypeEnum.WILDFIRE,
                  when=now - timedelta(minutes=i * 5), description=None,
                  severity=SeverityEnum.MODERATE)
        _assign_incident(r, db)
        db.commit()
        reports.append(r)

    inc_ids = {r.incident_id for r in reports}
    assert all(inc_ids), "every report must still get an incident"
    assert len(inc_ids) == 3, f"distinct same-building events must stay separate, got {inc_ids}"
