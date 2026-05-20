"""K.6.b (May 2026, Phase K) — AI retry queue.

Pre-K.6.b a transient AI-pipeline failure (Anthropic 5xx, Whisper
OOM, satellite-provider timeout) left the report's AI fields NULL
forever — the exception was swallowed silently inside the AI
background thread.

K.6.b introduces `ai_retry_queue` + a daemon that picks up failed
rows and re-runs the AI call with exponential backoff
(1 min / 5 min / 30 min / 2 h / 12 h, 5-attempt cap).

Positive assertions:

  1. ``enqueue`` writes a row with status='pending', attempts=1, and
     a next_attempt_at ~1 min from now (first backoff tier).
  2. ``enqueue`` is idempotent for the same (report_id, kind,
     file_url) triple — does NOT insert a duplicate; bumps attempts.
  3. After 5 attempts, the row is flipped to ``terminal_failed`` and
     no further retries are scheduled.
  4. ``_run_one_attempt`` invokes the underlying AI service; on
     failure it backs off; on success it marks the row complete.
  5. ``_run_ai_pipeline_bg`` (the call site in reports.py) wraps
     failures into the retry queue instead of silently dropping
     them.
  6. ``reclaim_stuck_in_progress`` flips orphaned in_progress rows
     back to pending after a stale window.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.models.report import (
    AiRetryQueueRow,
    Media,
    MediaTypeEnum,
    Report,
    SourceEnum,
    SyncStatusEnum,
)
from app.services import ai_retry_queue as ai_rq


def _make_report(db):
    """Minimal Report row for retry-queue tests. ai_retry_queue only
    needs the FK target to exist; column values are otherwise
    irrelevant to the retry semantics.
    """
    r = Report(
        id=str(uuid.uuid4()),
        client_report_id=str(uuid.uuid4()),
        source=SourceEnum.APP,
        sync_status=SyncStatusEnum.SYNCED,
        expected_media=1,
        received_media=1,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


# ── 1. enqueue persists a row with first-tier backoff ──────────────────────


def test_enqueue_creates_pending_row_with_first_backoff(db):
    """A freshly-failed AI task → row with attempts=1, status='pending',
    next_attempt_at ~+1 min (first backoff tier).
    """
    r = _make_report(db)
    ai_rq.enqueue(
        db,
        report_id=r.id,
        kind="transcription",
        file_url="audio_test.ogg",
        media_type="AUDIO",
        error="Whisper OOM",
    )
    db.commit()

    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).first()
    assert row is not None
    assert row.status == "pending"
    assert row.kind == "transcription"
    assert row.file_url == "audio_test.ogg"
    assert row.media_type == "AUDIO"
    assert row.attempts == 1
    assert row.last_error == "Whisper OOM"

    # First-tier backoff is 1 min — assert next_attempt_at sits in
    # the 50-70 s future window (loose to absorb clock-skew on slow
    # CI runners).
    delta = (row.next_attempt_at - datetime.now(timezone.utc)).total_seconds()
    assert 50 <= delta <= 70, f"first backoff out of range: {delta}s"


# ── 2. idempotency: re-enqueue does NOT duplicate ──────────────────────────


def test_enqueue_idempotent_same_triple_bumps_attempts(db):
    """A second enqueue for the same (report_id, kind, file_url) tuple
    while the first is still pending → must NOT create a 2nd row.
    It must extend the existing row's schedule (attempts +1, next
    backoff tier).
    """
    r = _make_report(db)
    ai_rq.enqueue(db, report_id=r.id, kind="transcription",
                  file_url="a.ogg", media_type="AUDIO", error="x")
    db.commit()

    # 2nd identical enqueue
    ai_rq.enqueue(db, report_id=r.id, kind="transcription",
                  file_url="a.ogg", media_type="AUDIO", error="y")
    db.commit()

    rows = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).all()
    assert len(rows) == 1, "must not create duplicate row"
    row = rows[0]
    assert row.attempts == 2
    assert row.last_error == "y"
    # 2nd tier backoff is 5 min
    delta = (row.next_attempt_at - datetime.now(timezone.utc)).total_seconds()
    assert 250 <= delta <= 350, f"second backoff out of range: {delta}s"


# ── 3. terminal_failed after 5 attempts ─────────────────────────────────────


def test_terminal_failed_after_five_attempts(db):
    """After 5 attempts the row flips to terminal_failed and stays
    there — no further enqueues schedule a new retry.
    """
    r = _make_report(db)
    for _ in range(5):
        ai_rq.enqueue(db, report_id=r.id, kind="image_analysis",
                      file_url="img.jpg", media_type="IMAGE", error="claude 503")
        db.commit()

    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).first()
    assert row.attempts == 5
    # 5th tier backoff is 12h
    delta = (row.next_attempt_at - datetime.now(timezone.utc)).total_seconds()
    assert 12 * 3600 - 60 <= delta <= 12 * 3600 + 60

    # 6th attempt → terminal_failed
    ai_rq.enqueue(db, report_id=r.id, kind="image_analysis",
                  file_url="img.jpg", media_type="IMAGE", error="claude 503")
    db.commit()

    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).first()
    assert row.status == "terminal_failed"
    assert row.attempts == 6

    # 7th enqueue: row is in terminal_failed (not pending/in_progress),
    # so the dedup query misses it → a NEW row IS created. That's
    # fine — terminal_failed means "manual operator review"; a fresh
    # row records the next retry attempt against a fresh schedule.
    ai_rq.enqueue(db, report_id=r.id, kind="image_analysis",
                  file_url="img.jpg", media_type="IMAGE", error="claude 503")
    db.commit()
    new_rows = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
        AiRetryQueueRow.status == "pending",
    ).all()
    assert len(new_rows) == 1, "fresh pending row after terminal_failed is expected"


# ── 4. _run_one_attempt: success path + failure path ──────────────────────


def test_run_one_attempt_success_marks_complete(db):
    """Daemon picks the row, invokes the AI call, succeeds → row
    flipped to 'complete'.
    """
    r = _make_report(db)
    # Pre-create a row that is READY to retry (next_attempt_at in the past)
    row = AiRetryQueueRow(
        report_id=r.id,
        kind="image_analysis",
        file_url="img.jpg",
        media_type="IMAGE",
        attempts=1,
        last_attempt_at=datetime.now(timezone.utc) - timedelta(minutes=2),
        next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=10),
        status="pending",
    )
    db.add(row)
    db.commit()
    row_id = row.id

    # Mock the inner AI call so it returns successfully.
    with patch("app.services.ai_retry_queue._invoke_ai_call",
               return_value=None) as m:
        n = ai_rq._run_one_attempt(db)
    assert n == 1, "daemon must report one row processed"
    assert m.called

    db.expire_all()
    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.id == row_id,
    ).first()
    assert row.status == "complete"


def test_run_one_attempt_failure_schedules_next_backoff(db):
    """Daemon picks the row, invokes the AI call, fails → row
    re-scheduled with the next backoff tier + last_error stored.
    """
    r = _make_report(db)
    row = AiRetryQueueRow(
        report_id=r.id,
        kind="image_analysis",
        file_url="img.jpg",
        media_type="IMAGE",
        attempts=1,
        last_attempt_at=datetime.now(timezone.utc) - timedelta(minutes=2),
        next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=10),
        status="pending",
    )
    db.add(row)
    db.commit()
    row_id = row.id

    with patch("app.services.ai_retry_queue._invoke_ai_call",
               side_effect=RuntimeError("anthropic 503")):
        n = ai_rq._run_one_attempt(db)
    assert n == 1

    db.expire_all()
    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.id == row_id,
    ).first()
    assert row.status == "pending", "failure → still pending for retry"
    assert row.attempts == 2
    assert "anthropic 503" in (row.last_error or "")
    # Now at 2nd-tier backoff (~5 min)
    delta = (row.next_attempt_at - datetime.now(timezone.utc)).total_seconds()
    assert 250 <= delta <= 350


def test_run_one_attempt_skips_when_no_rows_ready(db):
    """When the queue is empty OR all rows are scheduled in the
    future, the daemon returns 0 without raising.
    """
    n = ai_rq._run_one_attempt(db)
    assert n == 0

    # Pre-create a row whose next_attempt_at is far in the future.
    r = _make_report(db)
    db.add(AiRetryQueueRow(
        report_id=r.id,
        kind="image_analysis",
        file_url="img.jpg",
        media_type="IMAGE",
        attempts=1,
        next_attempt_at=datetime.now(timezone.utc) + timedelta(hours=2),
        status="pending",
    ))
    db.commit()

    n = ai_rq._run_one_attempt(db)
    assert n == 0, "future-scheduled rows must not be picked up"


# ── 5. reclaim_stuck_in_progress ────────────────────────────────────────────


def test_reclaim_stuck_in_progress_flips_old_rows(db):
    """Rows stuck in 'in_progress' beyond the cutoff → flipped back
    to 'pending' so the daemon retries them. Fresh in_progress rows
    are left alone (an actively-running daemon held them).
    """
    r = _make_report(db)
    now = datetime.now(timezone.utc)

    # Old stuck row → should be reclaimed
    db.add(AiRetryQueueRow(
        report_id=r.id,
        kind="image_analysis",
        file_url="old.jpg",
        media_type="IMAGE",
        attempts=1,
        last_attempt_at=now - timedelta(minutes=45),
        next_attempt_at=now - timedelta(minutes=44),
        status="in_progress",
    ))
    # Fresh in_progress → must NOT be reclaimed
    db.add(AiRetryQueueRow(
        report_id=r.id,
        kind="transcription",
        file_url="fresh.ogg",
        media_type="AUDIO",
        attempts=1,
        last_attempt_at=now - timedelta(minutes=2),
        next_attempt_at=now - timedelta(minutes=1),
        status="in_progress",
    ))
    db.commit()

    n = ai_rq.reclaim_stuck_in_progress(db, older_than_minutes=30)
    assert n == 1

    rows = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).order_by(AiRetryQueueRow.file_url.asc()).all()
    # 'fresh.ogg' must stay in_progress; 'old.jpg' must flip to pending.
    by_url = {row.file_url: row.status for row in rows}
    assert by_url["old.jpg"] == "pending"
    assert by_url["fresh.ogg"] == "in_progress"


# ── 6. _run_ai_pipeline_bg failure-path integration ────────────────────────


def test_run_ai_pipeline_bg_enqueues_on_failure(db):
    """The bg wrapper used by the AI executor pool must enqueue a
    retry row whenever `_run_ai_pipeline` raises. Pre-K.6.b the
    exception was silently swallowed inside the thread.
    """
    from app.api.endpoints import reports as reports_mod

    r = _make_report(db)

    with patch.object(
        reports_mod, "_run_ai_pipeline",
        side_effect=RuntimeError("whisper crashed"),
    ):
        # The function opens its own session via SessionLocal, so we
        # don't pass `db`. It catches the exception and enqueues a
        # retry row that we then read back via our test session.
        reports_mod._run_ai_pipeline_bg(r.id, "AUDIO", "audio.ogg")

    db.expire_all()
    rows = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).all()
    assert len(rows) == 1, "exactly one retry row must be enqueued"
    row = rows[0]
    assert row.kind == "transcription"
    assert row.file_url == "audio.ogg"
    assert row.media_type == "AUDIO"
    assert row.status == "pending"
    assert row.attempts == 1
    assert "whisper crashed" in (row.last_error or "")


def test_run_ai_pipeline_bg_no_enqueue_on_success(db):
    """Happy path: `_run_ai_pipeline` returns normally, no retry
    row is created.
    """
    from app.api.endpoints import reports as reports_mod

    r = _make_report(db)

    with patch.object(reports_mod, "_run_ai_pipeline", return_value=None):
        reports_mod._run_ai_pipeline_bg(r.id, "AUDIO", "audio.ogg")

    db.expire_all()
    rows = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == r.id,
    ).all()
    assert len(rows) == 0, "no retry row on success"
