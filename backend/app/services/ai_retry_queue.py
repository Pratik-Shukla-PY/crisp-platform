"""AI retry queue - Phase K K.6.b.

Pre-K.6.b a transient AI-pipeline failure left the report's
``ai_assessment`` NULL forever. The audit (Agent 2, B8) caught this:
Anthropic 5xx, Whisper OOM, satellite-provider timeouts - none of
them surface to the operator, none of them get retried.

This module provides:

* ``enqueue(db, *, report_id, kind, file_url, media_type, error)`` -
  persist a retry-queue row when ``_run_ai_pipeline`` raises.
* ``_run_one_attempt(db, row)`` - pick a single ``pending`` row,
  flip to ``in_progress``, invoke the matching AI service call,
  and either mark ``complete`` or schedule the next exponential
  backoff.
* ``_ai_retry_loop()`` - daemon thread, polls every
  ``AI_RETRY_TICK_S`` seconds (default 60).

Exponential schedule (per attempt index, AFTER the failure):
    1 → +1 min
    2 → +5 min
    3 → +30 min
    4 → +2 h
    5 → +12 h
    6 → terminal_failed (no further attempts)

The 5-attempt cap matches what the audit recommended: long enough
to ride out a 12-hour Anthropic outage; short enough that a
genuinely-broken row doesn't churn the queue indefinitely.

Idempotency: ``enqueue`` is a noop if a row already exists for the
same ``(report_id, kind, file_url)`` triple in a non-terminal state.
This protects against a retried failure path re-queuing the same
work multiple times (e.g. Action ① of the assembly sweep
re-submitting an already-queued row to the AI pool).
"""
from __future__ import annotations

import logging
import os
import threading
import time as _time
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Backoff schedule - attempt N → minutes to wait before attempt N+1.
# Index 0 is the wait after the 1st failure, index 4 is after the 5th.
# After index 4, the row flips to terminal_failed.
_BACKOFF_MINUTES = [1, 5, 30, 120, 720]  # 1m, 5m, 30m, 2h, 12h
_MAX_ATTEMPTS = len(_BACKOFF_MINUTES)  # 5

# Daemon tick interval. Polls for rows ready to retry every N seconds.
# Overridable via env without redeploying (matches the assembly daemon's
# CRISP_ASSEMBLE_SWEEP_INTERVAL_S knob).
_AI_RETRY_TICK_S = int(os.getenv("CRISP_AI_RETRY_TICK_S", "60"))


def _next_attempt_at(attempts_so_far: int) -> Optional[datetime]:
    """Return the timestamp for the next retry given how many attempts
    have already been made.

    ``attempts_so_far == 1`` means we've just recorded the 1st failure;
    next attempt is +1 min from now. ``attempts_so_far >= _MAX_ATTEMPTS``
    returns None → caller flips the row to terminal_failed.
    """
    if attempts_so_far <= 0:
        # Should never happen but defend anyway - schedule for "now"
        # so the daemon's next tick picks the row up immediately.
        return datetime.now(timezone.utc)
    if attempts_so_far > _MAX_ATTEMPTS:
        return None
    minutes = _BACKOFF_MINUTES[attempts_so_far - 1]
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def enqueue(
    db: Session,
    *,
    report_id: str,
    kind: str,
    file_url: Optional[str] = None,
    media_type: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """Persist a retry-queue row for a failed AI-pipeline task.

    Idempotent: if a non-terminal row already exists for the same
    ``(report_id, kind, file_url)`` triple, we extend its retry
    schedule (increment attempts, recompute next_attempt_at,
    update last_error) instead of inserting a duplicate. This is
    the path taken when ``_run_ai_pipeline`` is invoked a second
    time for an already-known-broken Media row (e.g. via the
    assembly recovery sweep).

    Caller is responsible for the surrounding transaction - we
    flush but do NOT commit, so the enqueue can roll back together
    with the rest of the failure-path handler if needed.
    """
    from app.models.report import AiRetryQueueRow

    existing = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.report_id == report_id,
        AiRetryQueueRow.kind == kind,
        AiRetryQueueRow.file_url == file_url,
        AiRetryQueueRow.status.in_(["pending", "in_progress"]),
    ).first()

    now = datetime.now(timezone.utc)

    if existing is not None:
        # A previous attempt already queued this row; bump its
        # state instead of inserting a duplicate.
        existing.attempts = (existing.attempts or 0) + 1
        existing.last_attempt_at = now
        existing.last_error = (error or "")[:8000]
        nxt = _next_attempt_at(existing.attempts)
        if nxt is None:
            existing.status = "terminal_failed"
            existing.next_attempt_at = now  # frozen; for audit only
            logger.warning(
                "[ai_retry] %s terminal_failed after %d attempts "
                "(report=%s, kind=%s, file=%s)",
                existing.id, existing.attempts, report_id, kind, file_url,
            )
        else:
            existing.status = "pending"
            existing.next_attempt_at = nxt
            logger.info(
                "[ai_retry] %s retry #%d scheduled at %s "
                "(report=%s, kind=%s)",
                existing.id, existing.attempts, nxt.isoformat(),
                report_id, kind,
            )
        db.flush()
        return

    # No existing row - create fresh.
    nxt = _next_attempt_at(1)
    row = AiRetryQueueRow(
        report_id=report_id,
        kind=kind,
        file_url=file_url,
        media_type=media_type,
        attempts=1,
        last_attempt_at=now,
        next_attempt_at=nxt or now,
        last_error=(error or "")[:8000],
        status="pending",
    )
    db.add(row)
    db.flush()
    logger.info(
        "[ai_retry] enqueued row=%s report=%s kind=%s file=%s "
        "first_retry_at=%s",
        row.id, report_id, kind, file_url,
        (nxt or now).isoformat(),
    )


def _invoke_ai_call(
    db: Session,
    *,
    kind: str,
    report_id: str,
    file_url: Optional[str],
    media_type: Optional[str],
) -> None:
    """Dispatch the actual AI service call for a retry row.

    Raises whatever the underlying service raises. The caller
    (`_run_one_attempt`) translates that into a backoff schedule.
    """
    if kind == "transcription" or kind == "image_analysis":
        if not file_url or not media_type:
            raise ValueError(
                f"ai_retry row missing file_url/media_type for kind={kind}"
            )
        # Re-invoke the same pipeline that originally failed.
        # Import here to avoid the circular import at module load.
        from app.api.endpoints.reports import _run_ai_pipeline
        _run_ai_pipeline(report_id, media_type, file_url, db)
        return

    if kind == "truth_scoring":
        # Truth scoring is a report-level fan-out across all media,
        # not a single-asset call. Re-trigger the existing helper
        # which the dashboard already calls when an analyst clicks
        # "verify with satellite".
        from app.services.truth_scorer import truth_scorer
        truth_scorer.score_report(db, report_id)
        return

    raise ValueError(f"ai_retry: unknown kind={kind!r}")


def _run_one_attempt(db: Session) -> int:
    """Pick (at most) one pending row whose ``next_attempt_at`` has
    arrived, run its AI call, and update its status.

    Returns the number of rows actually attempted (0 or 1). The
    daemon calls this in a loop; we deliberately pick one at a time
    to keep transaction scope narrow + avoid one slow row blocking
    a queue full of fast ones.
    """
    from app.models.report import AiRetryQueueRow

    now = datetime.now(timezone.utc)

    # Lock the row we pick up for the duration of this txn so the
    # (very unlikely) case of two daemon threads racing each other
    # - e.g. during a rolling deploy where two backend instances
    # overlap - doesn't double-process the same row.
    row = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.status == "pending",
        AiRetryQueueRow.next_attempt_at <= now,
    ).order_by(
        AiRetryQueueRow.next_attempt_at.asc()
    ).with_for_update(skip_locked=True).first()

    if row is None:
        return 0

    row.status = "in_progress"
    row.last_attempt_at = now
    db.flush()
    db.commit()  # release the row lock so other daemons can pick others

    try:
        _invoke_ai_call(
            db,
            kind=row.kind,
            report_id=row.report_id,
            file_url=row.file_url,
            media_type=row.media_type,
        )
    except Exception as e:  # noqa: BLE001
        # Failure path: extend the schedule.
        db.rollback()
        row = db.get(AiRetryQueueRow, row.id)
        if row is None:
            return 1
        row.attempts = (row.attempts or 0) + 1
        row.last_attempt_at = datetime.now(timezone.utc)
        row.last_error = str(e)[:8000]
        nxt = _next_attempt_at(row.attempts)
        if nxt is None:
            row.status = "terminal_failed"
            row.next_attempt_at = datetime.now(timezone.utc)
            logger.warning(
                "[ai_retry] row=%s terminal_failed after %d attempts "
                "(report=%s, kind=%s, err=%s)",
                row.id, row.attempts, row.report_id, row.kind, e,
            )
        else:
            row.status = "pending"
            row.next_attempt_at = nxt
            logger.info(
                "[ai_retry] row=%s attempt %d failed; retry at %s "
                "(report=%s, kind=%s, err=%s)",
                row.id, row.attempts, nxt.isoformat(),
                row.report_id, row.kind, e,
            )
        db.commit()
        return 1

    # Success: mark complete.
    row = db.get(AiRetryQueueRow, row.id)
    if row is not None:
        row.status = "complete"
        db.commit()
        logger.info(
            "[ai_retry] row=%s complete (report=%s, kind=%s, attempts=%d)",
            row.id, row.report_id, row.kind, row.attempts,
        )
    return 1


def _ai_retry_loop() -> None:
    """Daemon thread - polls the queue every ``_AI_RETRY_TICK_S``
    seconds. Drains all ready rows on each tick (one row per inner
    iteration to bound transaction scope).
    """
    from app.db.session import SessionLocal

    # First tick after a warmup pause so a backend restart doesn't
    # immediately re-attempt rows that the previous process left
    # in 'in_progress' (those will be picked up after the lock
    # times out anyway, but the pause keeps boot logs clean).
    _time.sleep(_AI_RETRY_TICK_S)

    while True:
        try:
            db = SessionLocal()
            try:
                # Drain ready rows one at a time. Cap per-tick at 100
                # so a deep backlog doesn't monopolise the daemon for
                # many minutes.
                processed = 0
                while processed < 100:
                    n = _run_one_attempt(db)
                    if n == 0:
                        break
                    processed += 1
                if processed:
                    logger.info(
                        "[ai_retry] tick processed %d rows", processed,
                    )
            finally:
                db.close()
        except Exception as e:  # noqa: BLE001
            logger.warning("[ai_retry] tick error: %s", e)
        _time.sleep(_AI_RETRY_TICK_S)


def reclaim_stuck_in_progress(db: Session, *, older_than_minutes: int = 30) -> int:
    """Boot-time helper - flip rows stuck in ``in_progress`` for
    longer than ``older_than_minutes`` back to ``pending`` so the
    daemon retries them.

    A row reaches this state when a backend instance crashed
    between marking it ``in_progress`` and committing the
    success / failure transition. Without this sweep the row would
    be invisible to the daemon's ``status='pending'`` filter
    forever.
    """
    from app.models.report import AiRetryQueueRow

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=older_than_minutes)
    n = db.query(AiRetryQueueRow).filter(
        AiRetryQueueRow.status == "in_progress",
        AiRetryQueueRow.last_attempt_at < cutoff,
    ).update(
        {"status": "pending"}, synchronize_session=False,
    )
    if n:
        db.commit()
        logger.info(
            "[ai_retry] reclaimed %d stuck in_progress rows (>=%d min old)",
            n, older_than_minutes,
        )
    return n
