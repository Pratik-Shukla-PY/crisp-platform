"""Phase F image-reliability follow-up — Action ④ of the assembly
recovery sweep: PARTIAL → SYNCED auto-promotion.

The PWA's bandwidth-tier deferral (mobile-app/src/app.js:8649) holds
MEDIUM/HIGH variants back on SLOW / VERY_SLOW networks; only the LOW
(SMALL) variant lands. The PWA flips its local `stages.photo=true`
once SMALL completes (May 2026 "SMALL gates the photo stage" fix in
the same file) so the IndexedDB queue drains. But the BACKEND kept
`sync_status=PARTIAL` forever because `received_media` (e.g. 2)
never reached `expected_media` (e.g. 3). The dashboard + PWA "My
Reports" both surfaced PARTIAL as "in queue" — operators saw reports
as stuck even though they were fully usable.

Action ④ closes the loop:

  - For every PARTIAL report, group its Media rows by photo_group_id
    (NULL → solo). If every group has at least one
    `assembly_status='complete'` row AND no Media row has been touched
    within the idle window (default 60 s, env var
    CRISP_PARTIAL_PROMOTE_IDLE_S), flip sync_status → SYNCED.

  - Abandoned (terminal-failed via actions ②/③) rows do NOT count
    toward "complete" — those groups still need a fresh upload.

  - Promotion is one-way (never demotes a SYNCED). An in-flight
    MEDIUM/HIGH variant that lands AFTER promotion is just bonus
    quality — the /attach endpoint's `>=` SYNCED check is then a
    no-op.

These tests pin the operator-visible contract per the bug report
"Now when I tried sending report it is in queue" (May 2026).
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.main import _run_assembly_recovery_sweep
from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _seed_partial_report(db, *, device_hash, expected, received):
    """Report row in sync_status=PARTIAL state with the requested expected /
    received media counts. The numbers are operator-facing; Action ④ does
    not consult them — it works off the actual Media rows.
    """
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-promote-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=expected,
        received_media=received,
    )
    db.add(r)
    db.flush()
    return r


def _seed_media_row(
    db,
    report,
    *,
    type_: MediaTypeEnum = MediaTypeEnum.IMAGE,
    tier: ResolutionEnum = ResolutionEnum.SMALL,
    photo_group_id: str | None = None,
    assembly_status: str = "complete",
    completion_pct: float = 100.0,
    age_seconds: int = 600,
    abandoned_at=None,
    abandon_reason=None,
):
    """Create a Media row with a precisely-controlled `updated_at` so the
    idle window can be tested deterministically.
    """
    m = Media(
        report_id=report.id,
        type=type_,
        resolution_tier=tier,
        photo_group_id=photo_group_id,
        url=f"/fake/{report.id[:8]}-{tier.value}.jpg",
        assembly_status=assembly_status,
        chunk_count=1,
        received_chunks=1,
        completion_pct=completion_pct,
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
    )
    db.add(m)
    db.flush()
    db.execute(
        Media.__table__.update()
        .where(Media.id == m.id)
        .values(updated_at=datetime.now(timezone.utc) - timedelta(seconds=age_seconds))
    )
    db.commit()
    db.refresh(m)
    return m


def _run_sweep(db):
    """Run the periodic sweep and refresh the test session so it sees
    the sweep's committed writes."""
    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_assembly_recovery_sweep(boot=False)
    db.expire_all()


# ── Tests ────────────────────────────────────────────────────────────────────


def test_promotes_partial_when_low_tier_complete_and_idle(db):
    """A photo group with only the LOW variant complete + idle window
    elapsed (default 60 s) should flip the report PARTIAL → SYNCED.

    This is the canonical "PWA deferred LARGE on slow network" pattern
    the production bug report hit.
    """
    r = _seed_partial_report(db, device_hash="promote-low-only", expected=3, received=1)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-A",
        assembly_status="complete",
        age_seconds=120,  # well past the 60 s idle window
    )
    assert r.sync_status == SyncStatusEnum.PARTIAL

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.SYNCED, (
        "Action ④ must promote PARTIAL → SYNCED when LOW variant is "
        "complete and the idle window has elapsed."
    )


def test_does_not_promote_when_medium_still_in_flight(db):
    """A photo group with LOW complete but MEDIUM still uploading inside
    the idle window MUST NOT promote — the in-flight MEDIUM may land
    within the next few seconds and we want to wait for it.
    """
    r = _seed_partial_report(db, device_hash="hold-medium-in-flight", expected=3, received=1)
    # LOW landed cleanly 10 min ago.
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-B",
        assembly_status="complete",
        age_seconds=600,
    )
    # MEDIUM still receiving chunks — touched 10 s ago.
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.MEDIUM,
        photo_group_id="group-B",
        assembly_status="pending",
        completion_pct=40.0,
        age_seconds=10,
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.PARTIAL, (
        "Idle-window gate failed: report flipped to SYNCED while a "
        "MEDIUM variant upload was still in-flight."
    )


def test_does_not_promote_when_no_complete_variant(db):
    """A photo group with all variants in 'pending' / 'assembling' (no
    complete row at all) MUST NOT promote — the photo isn't operationally
    usable yet."""
    r = _seed_partial_report(db, device_hash="no-complete-skip", expected=3, received=0)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-C",
        assembly_status="pending",
        completion_pct=0.0,
        age_seconds=600,
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.PARTIAL


def test_promotes_image_group_plus_audio_when_both_complete(db):
    """A report with an IMAGE photo-group (LOW complete) AND a separate
    AUDIO row (complete) should promote — every group is satisfied."""
    r = _seed_partial_report(db, device_hash="image-plus-audio", expected=4, received=2)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-D",
        assembly_status="complete",
        age_seconds=600,
    )
    _seed_media_row(
        db, r,
        type_=MediaTypeEnum.AUDIO,
        tier=ResolutionEnum.SMALL,
        photo_group_id=None,  # audio doesn't carry a group_id in the PWA
        assembly_status="complete",
        age_seconds=600,
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.SYNCED


def test_does_not_promote_when_only_abandoned_media(db):
    """A report whose only Media rows have been abandoned (terminal-failed
    via actions ②/③) MUST NOT promote — the operator should reclaim or
    delete; auto-promoting would mark a media-less report as 'fully
    synced' which is misleading."""
    r = _seed_partial_report(db, device_hash="abandoned-only", expected=1, received=0)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-E",
        assembly_status="failed",
        age_seconds=600,
        abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=30),
        abandon_reason="chunks_never_arrived",
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.PARTIAL


def test_promotes_legacy_solo_photo_without_group_id(db):
    """Legacy single-variant photo (no photo_group_id) that completed
    should also promote — each NULL-group row forms its own implicit
    'solo' group keyed by media id.
    """
    r = _seed_partial_report(db, device_hash="legacy-solo-photo", expected=1, received=1)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.ORIGINAL,  # legacy path used HIGH for the only variant
        photo_group_id=None,
        assembly_status="complete",
        age_seconds=600,
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.SYNCED


def test_partial_with_complete_low_and_abandoned_high_promotes(db):
    """Photo group where the HIGH variant got abandoned (PWA gave up
    after 30 min of failed retries) and only LOW remains complete should
    still promote — LOW is operationally enough."""
    r = _seed_partial_report(db, device_hash="low-ok-high-abandoned", expected=3, received=1)
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.SMALL,
        photo_group_id="group-F",
        assembly_status="complete",
        age_seconds=600,
    )
    _seed_media_row(
        db, r,
        tier=ResolutionEnum.ORIGINAL,
        photo_group_id="group-F",
        assembly_status="failed",
        age_seconds=600,
        abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=30),
        abandon_reason="chunks_never_arrived",
    )

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.SYNCED


def test_already_synced_report_is_left_alone(db):
    """A report already in SYNCED state must NOT be touched by action ④
    (one-way promotion; the action should never query SYNCED rows)."""
    d = Device(device_hash="already-synced-noop")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id="e2e-already-synced",
        sync_status=SyncStatusEnum.SYNCED,
        expected_media=1,
        received_media=1,
    )
    db.add(r)
    db.commit()

    _run_sweep(db)

    db.refresh(r)
    assert r.sync_status == SyncStatusEnum.SYNCED
