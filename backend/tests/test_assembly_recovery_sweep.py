"""Phase F image-reliability — periodic assembly recovery sweep.

Tests the three-action sweep in `app.main._run_assembly_recovery_sweep`:

  ① REVIVE chunks-fully-arrived stuck rows (pre-existing behaviour).
  ② ABANDON assembly-worker-lost rows (new in 0032).
  ③ ABANDON chunks-never-arrived rows (new in 0032).

These tests pin the operator-visible contract:

  - A 'pending' upload that never receives its final chunks eventually
    reaches `assembly_status='failed'` with `abandon_reason=
    'chunks_never_arrived'` so the dashboard can render
    "Original lost (network timeout)" instead of pulsing forever.

  - A 'assembling' row whose worker died with chunks NOT all arrived
    eventually reaches `assembly_status='failed'` with `abandon_reason=
    'assembly_worker_lost'`.

  - A row with chunks ALL arrived but stuck 'assembling' is REVIVED
    (resubmitted to the pool), not abandoned. This is the path that
    survives an uvicorn --reload mid-assembly.

  - Already-abandoned rows are NOT re-revived on the next tick (we don't
    fight the operator's earlier "this is lost" decision).

  - Rows still inside the freshness window are untouched.

Fresh rows are NOT swept; without this guarantee a happy-path photo
upload would race the sweep on flaky CI runners.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.main import _run_assembly_recovery_sweep
from app.models.report import (
    Device, Report, Media, MediaTypeEnum, ResolutionEnum, SourceEnum
)


def _seed_report(db, device_hash="test-device"):
    """Minimal report + device so Media rows have a parent. Returns the
    Report instance."""
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-sweep-{device_hash}",
    )
    db.add(r)
    db.flush()
    return r


def _seed_media(
    db,
    report,
    *,
    assembly_status: str,
    chunk_count: int,
    received_chunks: int,
    age_minutes: int,
    abandoned_at=None,
    abandon_reason=None,
):
    """Create a Media row, then manipulate `updated_at` post-flush to
    simulate it sitting in this state for `age_minutes` minutes. Returns
    the Media row.
    """
    m = Media(
        report_id=report.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.ORIGINAL,
        url="",
        chunk_count=chunk_count,
        received_chunks=received_chunks,
        assembly_status=assembly_status,
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
    )
    db.add(m)
    db.flush()
    # Force updated_at backward by `age_minutes`. We can't pass updated_at
    # to the constructor (server_default + onupdate clobber it); use a
    # post-flush UPDATE that bypasses the model's onupdate hook.
    db.execute(
        Media.__table__.update()
        .where(Media.id == m.id)
        .values(updated_at=datetime.now(timezone.utc) - timedelta(minutes=age_minutes))
    )
    db.commit()
    db.refresh(m)
    return m


def _run_sweep_via_test_session(db):
    """Run the sweep but with `SessionLocal` patched to share the test
    fixture's bind so all writes land on the same Postgres connection
    the test reads from.
    """
    # The sweep opens its own session via `SessionLocal()`. Patch
    # `SessionLocal` so it returns sessions bound to the same engine
    # the test fixture uses.
    from app.db.session import SessionLocal as _real
    import app.main as _main_mod

    # Reuse the existing factory (it already binds to TEST_DB_URL because
    # conftest sets DATABASE_URL before `app.main` is imported); the only
    # nuance is that the sweep does its own commits, so we just call it
    # and then `db.expire_all()` so the test session sees the writes.
    _run_assembly_recovery_sweep(boot=False)
    db.expire_all()


# ── ① REVIVE ─────────────────────────────────────────────────────────────────


def test_revive_resets_assembling_with_complete_chunks_to_pending(db):
    """A row stuck in 'assembling' with all chunks arrived (server-side
    crash mid-assembly) should be reset to 'pending' and re-submitted.
    `abandoned_at` stays NULL."""
    r = _seed_report(db, device_hash="revive-asm-complete")
    m = _seed_media(
        db, r,
        assembly_status="assembling",
        chunk_count=4,
        received_chunks=4,
        age_minutes=10,  # > 2 min stale, well inside abandon window's edge
    )

    # Patch the executor so submit is a no-op (we don't want the test to
    # spawn a real assembly worker against a fake media id).
    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "pending", (
        "REVIVE should reset assembling-with-complete-chunks to pending"
    )
    assert m.abandoned_at is None
    assert m.abandon_reason is None


def test_revive_resets_failed_with_complete_chunks_when_not_yet_abandoned(db):
    """A 'failed' row pre-0032 (no abandoned_at) with complete chunks
    should still be revivable on next sweep. This salvages legacy data
    that flipped to 'failed' before we had the abandon path."""
    r = _seed_report(db, device_hash="revive-failed-legacy")
    m = _seed_media(
        db, r,
        assembly_status="failed",
        chunk_count=3,
        received_chunks=3,
        age_minutes=10,
        abandoned_at=None,  # legacy fail — no abandon record
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "pending"
    assert m.abandoned_at is None


def test_revive_skips_already_abandoned_rows(db):
    """A row the sweep has previously abandoned MUST NOT be revived on
    later ticks; reclaim requires explicit operator action via F3."""
    now = datetime.now(timezone.utc)
    r = _seed_report(db, device_hash="revive-skips-abandoned")
    m = _seed_media(
        db, r,
        assembly_status="failed",
        chunk_count=3,
        received_chunks=3,
        age_minutes=10,
        abandoned_at=now - timedelta(minutes=5),
        abandon_reason="chunks_never_arrived",
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit") as mock_submit:
        _run_sweep_via_test_session(db)
        # Should not have queued a resubmission for this row.
        for call in mock_submit.call_args_list:
            args, _ = call
            assert m.id not in args, (
                "Sweep must not re-queue rows that have been abandoned"
            )

    db.refresh(m)
    assert m.assembly_status == "failed"
    assert m.abandoned_at is not None  # untouched


# ── ② ABANDON assembly-worker-lost ───────────────────────────────────────────


def test_abandons_assembling_with_incomplete_chunks_past_deadline(db):
    """A row stuck 'assembling' past 30 min AND chunks NOT all arrived
    has a dead worker; flip to 'failed' with reason='assembly_worker_lost'.
    """
    r = _seed_report(db, device_hash="abandon-worker-lost")
    m = _seed_media(
        db, r,
        assembly_status="assembling",
        chunk_count=5,
        received_chunks=2,  # incomplete
        age_minutes=45,     # > 30 min deadline
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "failed"
    assert m.abandon_reason == "assembly_worker_lost"
    assert m.abandoned_at is not None


# ── ③ ABANDON chunks-never-arrived ───────────────────────────────────────────


def test_abandons_pending_with_incomplete_chunks_past_stale_window(db):
    """A 'pending' row whose PWA never delivered the last chunks (offline
    queue drain failed; tab closed) is permanently stuck. Flip to 'failed'
    with reason='chunks_never_arrived' so the dashboard renders
    "Original lost"."""
    r = _seed_report(db, device_hash="abandon-chunks-never")
    m = _seed_media(
        db, r,
        assembly_status="pending",
        chunk_count=7,
        received_chunks=4,  # 3 chunks short — matches the user's PROD report
        age_minutes=45,
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "failed"
    assert m.abandon_reason == "chunks_never_arrived"
    assert m.abandoned_at is not None


def test_pending_within_freshness_window_is_untouched(db):
    """Don't sweep fresh rows — they could still complete normally."""
    r = _seed_report(db, device_hash="fresh-pending-untouched")
    m = _seed_media(
        db, r,
        assembly_status="pending",
        chunk_count=7,
        received_chunks=4,
        age_minutes=5,   # well inside fresh window
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "pending"
    assert m.abandoned_at is None
    assert m.abandon_reason is None


def test_pending_with_zero_chunk_count_is_untouched(db):
    """chunk_count==0 means the row is mid-meta-create (not yet allocated).
    Flipping it to 'failed' would race the chunk handler."""
    r = _seed_report(db, device_hash="pending-zero-chunks")
    m = _seed_media(
        db, r,
        assembly_status="pending",
        chunk_count=0,    # not yet allocated
        received_chunks=0,
        age_minutes=45,
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit"):
        _run_sweep_via_test_session(db)

    db.refresh(m)
    assert m.assembly_status == "pending"
    assert m.abandoned_at is None


def test_complete_rows_are_never_touched(db):
    """Sanity — a `complete` row must never be re-enqueued or abandoned."""
    r = _seed_report(db, device_hash="complete-untouched")
    m = _seed_media(
        db, r,
        assembly_status="complete",
        chunk_count=3,
        received_chunks=3,
        age_minutes=120,
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit") as mock_submit:
        _run_sweep_via_test_session(db)
        for call in mock_submit.call_args_list:
            args, _ = call
            assert m.id not in args

    db.refresh(m)
    assert m.assembly_status == "complete"
    assert m.abandoned_at is None
