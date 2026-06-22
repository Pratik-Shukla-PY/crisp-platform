"""Building-centric Incident-Feed redesign Phase 2C — incident backfill (migration 0059).

Exercises the REAL `_backfill(bind)` SQL from migration 0059 against the test DB:
  - an active duplicate GROUP (primary + CONFIRMED_DUP child) collapses into ONE
    incident (lead = earliest, report_count = group size, severity = max member);
  - standalone reports each get their OWN incident;
  - it is idempotent (a second run creates nothing new).
"""
from __future__ import annotations

import importlib.util
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import (
    Device, Report, Incident, ReportDuplicateDecision,
    SourceEnum, SyncStatusEnum, CrisisTypeEnum, SeverityEnum,
)

# Load `_backfill` straight from the migration file (module name starts with a
# digit, so import by path) — we test the exact SQL the migration ships.
_MIG = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0059_backfill_incidents.py"
_spec = importlib.util.spec_from_file_location("mig_0059_backfill", _MIG)
_mig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mig)
_backfill = _mig._backfill


def _device(db):
    d = Device(device_hash=f"dev-{uuid.uuid4().hex[:12]}")
    db.add(d)
    db.flush()
    return d


def _seed(db, *, device, building_id, crisis_type, when, severity=SeverityEnum.MODERATE):
    r = Report(
        device_id=device.id,
        source=SourceEnum.APP,
        client_report_id=f"bf-{uuid.uuid4().hex}",
        building_id=building_id,
        crisis_type=crisis_type,
        severity=severity,
        sync_status=SyncStatusEnum.SYNCED,
        expected_media=0,
        received_media=0,
        server_created_at=when,
    )
    db.add(r)
    db.flush()
    return r


def test_backfill_groups_and_standalones(db):
    now = datetime.now(timezone.utc)
    b1 = "bf-bldg-" + uuid.uuid4().hex[:8]
    b2 = "bf-bldg-" + uuid.uuid4().hex[:8]
    dev = _device(db)

    # Duplicate GROUP in b1: A (earliest, MODERATE) is primary; B (CRITICAL) is a
    # confirmed child of A.
    a = _seed(db, device=dev, building_id=b1, crisis_type=CrisisTypeEnum.EARTHQUAKE,
              when=now - timedelta(minutes=30), severity=SeverityEnum.MODERATE)
    b = _seed(db, device=dev, building_id=b1, crisis_type=CrisisTypeEnum.EARTHQUAKE,
              when=now - timedelta(minutes=20), severity=SeverityEnum.CRITICAL)
    db.add(ReportDuplicateDecision(
        cluster_key=b1, primary_report_id=a.id, related_report_id=b.id, decision="CONFIRMED_DUP",
    ))
    # Standalone C in b1 (no dup decision) + standalone D in b2.
    c = _seed(db, device=dev, building_id=b1, crisis_type=CrisisTypeEnum.FLOOD,
              when=now - timedelta(minutes=10), severity=SeverityEnum.MINOR)
    d = _seed(db, device=_device(db), building_id=b2, crisis_type=CrisisTypeEnum.WILDFIRE,
              when=now, severity=SeverityEnum.SEVERE)
    db.commit()

    _backfill(db.connection())
    db.expire_all()

    A = db.query(Report).filter(Report.id == a.id).first()
    B = db.query(Report).filter(Report.id == b.id).first()
    C = db.query(Report).filter(Report.id == c.id).first()
    D = db.query(Report).filter(Report.id == d.id).first()

    # Every report is now assigned.
    assert A.incident_id and B.incident_id and C.incident_id and D.incident_id
    # The duplicate group collapsed into ONE incident; standalones are distinct.
    assert A.incident_id == B.incident_id, "confirmed-dup group must share one incident"
    assert len({A.incident_id, C.incident_id, D.incident_id}) == 3, "standalones stay distinct"

    grp = db.query(Incident).filter(Incident.id == A.incident_id).first()
    assert grp.report_count == 2
    assert grp.lead_report_id == a.id, "lead = earliest report in the group"
    assert grp.severity == "CRITICAL", "incident severity = max across members"
    assert grp.incident_type == "EARTHQUAKE"
    assert grp.status == "OPEN"

    standalone_c = db.query(Incident).filter(Incident.id == C.incident_id).first()
    assert standalone_c.report_count == 1
    assert standalone_c.lead_report_id == c.id


def test_backfill_is_idempotent(db):
    now = datetime.now(timezone.utc)
    bid = "bf-idem-" + uuid.uuid4().hex[:8]
    r = _seed(db, device=_device(db), building_id=bid, crisis_type=CrisisTypeEnum.FLOOD, when=now)
    db.commit()

    _backfill(db.connection())
    db.expire_all()
    first = db.query(Report).filter(Report.id == r.id).first().incident_id
    assert first, "report assigned on first backfill"
    n_after_first = db.query(Incident).count()

    # Second run must be a no-op (no reassignment, no new incidents).
    _backfill(db.connection())
    db.expire_all()
    assert db.query(Report).filter(Report.id == r.id).first().incident_id == first
    assert db.query(Incident).count() == n_after_first
