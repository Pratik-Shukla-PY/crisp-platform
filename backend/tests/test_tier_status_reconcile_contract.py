"""Contract test for the PWA `_reconcileBeforeDequeue` race fix.

P0 (operator-reported, May 2026): ORIGINAL chunks arrived at the
backend successfully but the PWA's reconcile classified them as
"soft-drain" because they hadn't yet reached `assembly_status='complete'`
on the server's row. PWA then called `/media/mark-deferred` which
stamped the Media row as `failed, abandon_reason='bandwidth_tier_deferred'`.
Meanwhile the chunks finished arriving and assembly tried to start —
but the row was already terminal-failed → ORIGINAL lost.

The fix is PWA-side (`mobile-app/src/app.js::_reconcileBeforeDequeue`):
distinguish "row exists, mid-assembly" from "row truly absent" for
non-SMALL tiers, same as we already do for SMALL.

This Python contract test proves the BACKEND surface the PWA needs:

  1. /tier-status returns a row with `assembly_status='pending'` /
     'assembling' / 'failed' / 'complete' — the PWA needs the
     status to make the right call.

  2. A non-complete row IS present in the response (so the PWA can
     check `serverHas.has(mediaId)`).

  3. A row that's mid-assembly (chunks received but
     assembly_status='pending') is correctly surfaced.

Without these, the PWA's race-safe reconcile can't function. This
test locks the contract.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.report import (
    Media,
    MediaTypeEnum,
    Report,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


def _seed_partial_upload(db):
    """Mimic the state the operator's report hit: SMALL + MEDIUM
    complete, ORIGINAL mid-assembly (all chunks arrived but
    assembly_status still 'pending')."""
    r = Report(
        id=str(uuid.uuid4()),
        client_report_id=str(uuid.uuid4()),
        source=SourceEnum.APP,
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=3,
        received_media=2,
    )
    db.add(r)
    db.flush()

    photo_group_id = str(uuid.uuid4())

    small = Media(
        id=str(uuid.uuid4()),
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        photo_group_id=photo_group_id,
        url="/static/small.jpg",
        assembly_status="complete",
        chunk_count=1, received_chunks=1, completion_pct=100.0,
    )
    medium = Media(
        id=str(uuid.uuid4()),
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.MEDIUM,
        photo_group_id=photo_group_id,
        url="/static/medium.jpg",
        assembly_status="complete",
        chunk_count=2, received_chunks=2, completion_pct=100.0,
    )
    # ORIGINAL — all chunks arrived but assembly still pending (the
    # exact state that triggered the operator's race).
    original = Media(
        id=str(uuid.uuid4()),
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.ORIGINAL,
        photo_group_id=photo_group_id,
        url="",  # not yet assembled
        assembly_status="pending",
        chunk_count=27, received_chunks=27, completion_pct=100.0,
    )
    db.add_all([small, medium, original])
    db.commit()
    db.refresh(r)
    return r, photo_group_id, [small, medium, original]


def test_tier_status_returns_mid_assembly_row(client, db):
    """The endpoint MUST return a row entry for the ORIGINAL tier
    even though its assembly_status is still 'pending'. Without
    that, the PWA can't distinguish "row exists but mid-assembly"
    from "row never existed" and falls back to mark-deferred too
    eagerly.
    """
    r, photo_group_id, medias = _seed_partial_upload(db)

    res = client.get(f"/api/v1/reports/{r.id}/tier-status")
    assert res.status_code == 200, f"got {res.status_code}: {res.text}"
    body = res.json()
    assert body["report_id"] == r.id

    rows_by_tier = {row["resolution_tier"]: row for row in body["media"]}

    # The exact contract the PWA's _reconcileBeforeDequeue relies on:
    assert "ORIGINAL" in rows_by_tier, (
        "PWA needs the ORIGINAL row in the response — without it, "
        "`serverHas.has(mediaId)` returns false and the PWA falls back "
        "to mark-deferred even though chunks have all arrived"
    )
    orig = rows_by_tier["ORIGINAL"]
    assert orig["assembly_status"] == "pending", (
        "Mid-assembly state must surface as 'pending', not be omitted "
        "from the response"
    )
    assert orig["received_chunks"] == 27
    assert orig["chunk_count"] == 27
    # Critical: the row IS present + has a non-'complete' status →
    # PWA can classify as `softAssembling` (wait) NOT `softMissing`
    # (mark-deferred).
    assert orig["id"] == medias[2].id


def test_tier_status_returns_all_three_tiers_when_mixed_states(client, db):
    """SMALL complete + MEDIUM complete + ORIGINAL pending should
    return all 3 rows in the response. PWA needs the full picture.
    """
    r, _, medias = _seed_partial_upload(db)
    res = client.get(f"/api/v1/reports/{r.id}/tier-status")
    body = res.json()
    assert len(body["media"]) == 3
    statuses = {row["resolution_tier"]: row["assembly_status"] for row in body["media"]}
    assert statuses["SMALL"] == "complete"
    assert statuses["MEDIUM"] == "complete"
    assert statuses["ORIGINAL"] == "pending"


def test_tier_status_distinguishes_missing_vs_assembling_row(client, db):
    """If the PWA THINKS it sent an ORIGINAL but the backend never
    received any chunks, the row simply won't exist in the
    response → PWA correctly classifies as truly-missing → soft-drain.

    Asymmetric case validates the dichotomy the PWA's reconcile relies on:
      ORIGINAL row PRESENT in response (any status) → softAssembling (wait)
      ORIGINAL row ABSENT from response             → softMissing (mark-deferred)
    """
    r, photo_group_id, _ = _seed_partial_upload(db)
    # Delete the ORIGINAL row to simulate "never arrived"
    db.query(Media).filter(
        Media.report_id == r.id,
        Media.resolution_tier == ResolutionEnum.ORIGINAL,
    ).delete()
    db.commit()

    res = client.get(f"/api/v1/reports/{r.id}/tier-status")
    body = res.json()
    rows_by_tier = {row["resolution_tier"]: row for row in body["media"]}
    assert "SMALL" in rows_by_tier
    assert "MEDIUM" in rows_by_tier
    assert "ORIGINAL" not in rows_by_tier, (
        "PWA needs absence-from-response to mean truly-missing; "
        "if the backend returned a placeholder, the PWA couldn't "
        "distinguish missing from mid-assembly"
    )
