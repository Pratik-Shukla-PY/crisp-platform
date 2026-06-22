"""Building-centric redesign (Phase 1A) — `GET /reports/buildings-needing-review`.

Awareness feed that replaces the global "Potential Duplicates" merge panel: it lists
the buildings with UNSETTLED duplicate-candidate pairs (so cross-building visibility
is kept while merge itself moves into the building/operation workspace). Reuses
`_rdd_candidate_pairs`, so it agrees with `/duplicate-summary`.

Critical assertions:
  - A building with a same-event candidate pair (same building + same crisis + within
    1h ⇒ MEDIUM ≈ 63) is listed with candidate_pairs >= 1.
  - Same building + DIFFERENT crisis + >24h apart (base 20 only, < 50 floor) is a
    distinct incident → NOT offered (proves dup-detection doesn't fuse distinct events).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import Device, Report, SourceEnum, SyncStatusEnum, CrisisTypeEnum
from tests.conftest import auth_header


def _seed_report(db, *, device, building_id, crisis_type, when):
    r = Report(
        device_id=device.id,
        source=SourceEnum.APP,
        client_report_id=f"bnr-{uuid.uuid4().hex}",
        building_id=building_id,
        crisis_type=crisis_type,
        sync_status=SyncStatusEnum.SYNCED,
        expected_media=0,
        received_media=0,
        server_created_at=when,
    )
    db.add(r)
    return r


def _device(db):
    d = Device(device_hash=f"dev-{uuid.uuid4().hex[:12]}")
    db.add(d)
    db.flush()
    return d


def test_building_with_candidate_pair_is_listed(client, db, viewer_token):
    """Two same-building, same-crisis, within-1h reports ⇒ a MEDIUM candidate pair ⇒
    the building appears in the awareness feed."""
    bid = "bnr-cand-" + uuid.uuid4().hex[:8]
    d = _device(db)
    now = datetime.now(timezone.utc)
    _seed_report(db, device=d, building_id=bid, crisis_type=CrisisTypeEnum.EARTHQUAKE, when=now)
    _seed_report(db, device=d, building_id=bid, crisis_type=CrisisTypeEnum.EARTHQUAKE,
                 when=now - timedelta(minutes=20))
    db.commit()

    res = client.get("/api/v1/reports/buildings-needing-review", headers=auth_header(viewer_token))
    assert res.status_code == 200, res.text
    body = res.json()
    ours = [b for b in body["buildings"] if b["building_id"] == bid]
    assert len(ours) == 1, f"building {bid} not surfaced: {body}"
    assert ours[0]["candidate_pairs"] >= 1
    assert ours[0]["report_count"] == 2
    assert (ours[0]["high"] + ours[0]["medium"] + ours[0]["low"]) >= 1
    assert body["total_buildings"] >= 1


def test_same_building_distinct_incidents_not_offered(client, db, viewer_token):
    """Same building but DIFFERENT crisis types, >24h apart → score = base 20 only,
    below the LOW=50 floor → NOT a duplicate candidate → building not listed. Proves
    the engine does not fuse distinct same-building events (the Floor-1/7/10 concern)."""
    bid = "bnr-distinct-" + uuid.uuid4().hex[:8]
    d = _device(db)
    now = datetime.now(timezone.utc)
    _seed_report(db, device=d, building_id=bid, crisis_type=CrisisTypeEnum.EARTHQUAKE, when=now)
    _seed_report(db, device=d, building_id=bid, crisis_type=CrisisTypeEnum.FLOOD,
                 when=now - timedelta(hours=48))
    db.commit()

    res = client.get("/api/v1/reports/buildings-needing-review", headers=auth_header(viewer_token))
    assert res.status_code == 200, res.text
    listed = {b["building_id"] for b in res.json()["buildings"]}
    assert bid not in listed, "distinct same-building incidents must not be offered as duplicates"
