"""K.2.d (May 2026, Phase K) — `POST /reports/{id}/media/mark-deferred`.

Backend-side companion to the PWA's soft-drain. When the PWA gives up
on MEDIUM/HIGH variants (bandwidth-tier deferral on SLOW networks),
it POSTs to this endpoint with the list of missing tiers per
photo_group. Backend:
  1. Creates or updates Media rows with assembly_status='failed' and
     abandon_reason='bandwidth_tier_deferred'.
  2. Decrements `report.expected_media` so the SYNCED gate becomes honest.
  3. Re-evaluates SYNCED promotion.

Positive assertions:
  - Mark 2 tiers (MEDIUM + HIGH) on a photo_group → 2 abandon-stamped
    Media rows + expected_media decremented + report promoted to SYNCED
    (since only SMALL was expected as concrete deliverable).
  - Idempotent: second call with same payload is a noop.
  - Existing complete Media row beats the soft-drain claim (don't
    abandon a tier that actually did land).
  - Invalid reason → 422.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


def _seed_report_with_small_landed(db, *, device_hash, expected=3):
    """A Report with `expected_media=3` (SMALL+MEDIUM+HIGH) where the
    SMALL variant has already landed. Mirrors the typical PWA soft-drain
    state: SMALL complete, MEDIUM/HIGH never arriving."""
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k2d-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=expected,
        received_media=1,  # SMALL landed
    )
    db.add(r)
    db.flush()

    photo_group_id = str(uuid.uuid4())
    small_media = Media(
        id=str(uuid.uuid4()),
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        photo_group_id=photo_group_id,
        url="/fake/small.jpg",
        assembly_status="complete",
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
    )
    db.add(small_media)
    db.commit()
    db.refresh(r)
    return r, photo_group_id


# ── K.2.d positive assertions ────────────────────────────────────────────────


def test_mark_two_tiers_creates_placeholders_decrements_expected_and_synced(client, db):
    """Soft-drain MEDIUM + HIGH → 2 placeholder Media rows with
    `bandwidth_tier_deferred` + report promoted to SYNCED."""
    r, photo_group_id = _seed_report_with_small_landed(
        db, device_hash="k2d-mark-medium-high"
    )
    assert r.sync_status == SyncStatusEnum.PARTIAL

    res = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={
            "tiers_by_group": {photo_group_id: ["MEDIUM", "ORIGINAL"]},
            "reason": "bandwidth_tier_deferred",
        },
    )
    assert res.status_code == 200, f"got {res.status_code} body={res.text}"
    body = res.json()
    assert body["newly_stamped"] == 2
    assert body["sync_status"] == "SYNCED"

    db.expire_all()
    refreshed = db.query(Report).filter(Report.id == r.id).first()
    # expected_media decremented from 3 → 1 (received_media floor)
    assert refreshed.expected_media == 1
    # 2 new failed Media rows + 1 original complete row = 3 total
    media_rows = db.query(Media).filter_by(report_id=r.id).all()
    assert len(media_rows) == 3
    failed_rows = [m for m in media_rows if m.assembly_status == "failed"]
    assert len(failed_rows) == 2
    for fr in failed_rows:
        assert fr.abandon_reason == "bandwidth_tier_deferred"
        assert fr.abandoned_at is not None
        # Phase L canonical vocabulary — SMALL/MEDIUM/ORIGINAL only.
        # Legacy LOW/HIGH are rejected by Pydantic enum validation
        # (alembic 0036 dropped them from the Postgres enum too).
        assert fr.resolution_tier in (ResolutionEnum.MEDIUM, ResolutionEnum.ORIGINAL)


def test_mark_deferred_is_idempotent(client, db):
    """Second call with same payload → no additional rows, no double-decrement."""
    r, photo_group_id = _seed_report_with_small_landed(
        db, device_hash="k2d-idempotent"
    )

    res1 = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={"tiers_by_group": {photo_group_id: ["MEDIUM", "ORIGINAL"]}},
    )
    assert res1.status_code == 200
    assert res1.json()["newly_stamped"] == 2

    res2 = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={"tiers_by_group": {photo_group_id: ["MEDIUM", "ORIGINAL"]}},
    )
    assert res2.status_code == 200
    assert res2.json()["newly_stamped"] == 0, "Second call must be a noop"

    db.expire_all()
    media_count = db.query(Media).filter_by(report_id=r.id).count()
    assert media_count == 3, "No additional Media rows on idempotent retry"


def test_mark_deferred_does_not_overwrite_complete_media(client, db):
    """If the MEDIUM tier actually DID land (Media row in 'complete')
    after the PWA sent its soft-drain signal, we must not overwrite it
    as 'failed'. The complete row wins."""
    r, photo_group_id = _seed_report_with_small_landed(
        db, device_hash="k2d-complete-wins"
    )

    # Simulate MEDIUM landed (late but it did land)
    medium_media = Media(
        id=str(uuid.uuid4()),
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.MEDIUM,
        photo_group_id=photo_group_id,
        url="/fake/medium.jpg",
        assembly_status="complete",
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
    )
    db.add(medium_media)
    db.commit()

    # PWA's stale soft-drain says MEDIUM + HIGH were deferred
    res = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={"tiers_by_group": {photo_group_id: ["MEDIUM", "ORIGINAL"]}},
    )
    assert res.status_code == 200
    body = res.json()
    # Only HIGH gets a new placeholder; MEDIUM is already complete
    assert body["newly_stamped"] == 1

    db.expire_all()
    medium_refreshed = db.query(Media).filter(Media.id == medium_media.id).first()
    assert medium_refreshed.assembly_status == "complete", (
        "MEDIUM complete row must NOT be overwritten to failed"
    )


def test_mark_deferred_with_invalid_reason_returns_422(client, db):
    """Out-of-vocab reason → 422."""
    r, photo_group_id = _seed_report_with_small_landed(
        db, device_hash="k2d-invalid-reason"
    )
    res = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={
            "tiers_by_group": {photo_group_id: ["ORIGINAL"]},
            "reason": "someone_made_up_a_reason",
        },
    )
    assert res.status_code == 422


def test_mark_deferred_with_empty_tiers_by_group_returns_422(client, db):
    """Empty payload → 422."""
    r, _ = _seed_report_with_small_landed(db, device_hash="k2d-empty-payload")
    res = client.post(
        f"/api/v1/reports/{r.id}/media/mark-deferred",
        json={"tiers_by_group": {}},
    )
    assert res.status_code == 422


def test_mark_deferred_with_unknown_report_returns_404(client, db):
    """Bad report_id → 404."""
    res = client.post(
        "/api/v1/reports/00000000-0000-0000-0000-000000000000/media/mark-deferred",
        json={"tiers_by_group": {"some-group": ["ORIGINAL"]}},
    )
    assert res.status_code == 404
