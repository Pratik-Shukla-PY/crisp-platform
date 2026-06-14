"""Web Push delivery service (RFC 8030 / 8291 / 8292).

The dashboard endpoint that flips a Report's status (dispatch /
resolve / false-alarm) calls `push_report_status_change(report)`
AFTER its own DB commit. We:

  1. Look up every PushSubscription tied to that reporter
     (by `device_hash` and/or `user_id`).
  2. Build a small JSON payload (~200 bytes - Web Push payloads
     are encrypted but capped at ~4 KB; small is more reliable).
  3. Hand each delivery to a ThreadPoolExecutor and return.
     The HTTP request that triggered the status change is NEVER
     blocked on push delivery - providers can be slow / unreachable
     / rate-limit us, none of which should affect the analyst
     workflow.

Failure handling:
  * 200 / 201 / 202 → success; bump last_pushed_at + reset
    failure_count to zero.
  * 404 / 410 → endpoint is dead; delete the row immediately.
  * 429 / 5xx → transient provider issue. Phase 2.3 (May 2026):
    in-task bounded retry with exponential backoff (3 attempts
    spaced 1s / 2s / 4s) before giving up + bumping failure_count.
    Subscriptions whose failure_count exceeds
    `PUSH_DEAD_LETTER_THRESHOLD` get pruned (auto-delete) so we
    don't keep retrying forever against an endpoint that's silently
    dead (some providers stop returning 410 after their own GC
    window).
  * 401 / 403 → VAPID key mismatch or expired claim. Operator
    needs to look at the logs - could be a key rotation gone wrong.
    Not retried (would just fail again with the same auth error).

The in-task retry was added in Phase 2.3 (May 2026) after operator
feedback that the report→response feedback loop felt unreliable
when push providers hiccup. Retries are still cheap - they happen
on the executor thread, NEVER on the API request path.

If VAPID is not configured (any of public-key / private-key /
contact-email is empty) the entry point short-circuits with a
single startup log line - the platform stays healthy, push is
just "feature off" rather than failing.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import logging
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.report import PushSubscription, Report

logger = logging.getLogger(__name__)

# Single executor - all push deliveries share it. 4 workers is plenty
# for the burst rate (status changes are human-paced; even at 100
# concurrent reports each fanning out to 5 devices, the queue drains
# within seconds).
_push_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="webpush")

_warned_vapid_missing = False

# Phase 2.3 (May 2026) - bounded retry + dead-letter knobs.
#
# Retry policy is exponential: 1s / 2s / 4s = 7s total worst case
# per delivery. Bounded to keep the executor pool from filling with
# slow retries during a provider-wide hiccup. Three attempts is
# enough to ride out the typical "429 cooling-down" or "transient
# 503" pattern without holding workers hostage.
PUSH_RETRY_BACKOFF_S = [1, 2, 4]
# Subscriptions whose failure_count crosses this threshold get
# auto-pruned. Some providers stop returning 410 GONE after their
# own GC window - without this prune, we'd retry forever on dead
# endpoints. Tuned at 10 (≈ a fortnight of daily-fail status
# changes) so a brief provider outage doesn't accidentally prune a
# healthy subscription.
PUSH_DEAD_LETTER_THRESHOLD = 10


def _vapid_configured() -> bool:
    """Return True iff all three VAPID env vars are populated."""
    return bool(
        settings.VAPID_PUBLIC_KEY
        and settings.VAPID_PRIVATE_KEY
        and settings.VAPID_CONTACT_EMAIL
    )


def _vapid_claims() -> Dict[str, str]:
    """RFC 8292 §2 - `sub` is the operator's contact URI."""
    return {"sub": f"mailto:{settings.VAPID_CONTACT_EMAIL}"}


def _send_one(
    sub_endpoint: str,
    sub_p256dh: str,
    sub_auth: str,
    payload: Dict[str, Any],
    ttl_seconds: int = 86400,
) -> int:
    """Send a single encrypted push and return the provider's HTTP status.

    Raises pywebpush.WebPushException only if the call itself failed
    before reaching the provider (network error, invalid keys). For
    HTTP-level errors, we return the status code so the caller can
    decide whether to delete the subscription or just bump
    failure_count.

    Imported lazily so import-time failures (e.g. cryptography
    backend missing) don't break the rest of the API.
    """
    from pywebpush import webpush, WebPushException  # type: ignore

    sub = {
        "endpoint": sub_endpoint,
        "keys": {"p256dh": sub_p256dh, "auth": sub_auth},
    }
    try:
        resp = webpush(
            subscription_info=sub,
            data=json.dumps(payload),
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims=_vapid_claims(),
            ttl=ttl_seconds,
        )
        return getattr(resp, "status_code", 200)
    except WebPushException as exc:
        # Provider returned an error response we can map.
        if exc.response is not None:
            return exc.response.status_code
        # Network / encryption error - surface as 500-class so the
        # caller treats it as transient (failure_count bump, leave
        # the row in place).
        logger.warning("[push] WebPushException without response: %s", exc)
        return 599


def _deliver_one(
    sub_id: str,
    payload: Dict[str, Any],
) -> None:
    """Run inside the executor pool. Owns its own DB session.

    Phase 2.3 (May 2026) - bounded retry + dead-letter pruning.
    Transient failures (429 / 5xx) now retry up to len(PUSH_RETRY_BACKOFF_S)
    times with exponential backoff before giving up. Auth failures
    (401 / 403) skip retry - they'd just fail again with the same
    error.

    Any exception here is logged but not propagated - the executor
    swallows it anyway, and we don't want a malformed subscription
    to abort sibling deliveries.
    """
    db = SessionLocal()
    try:
        sub = db.query(PushSubscription).filter(PushSubscription.id == sub_id).first()
        if sub is None:
            return  # Race: subscription deleted between fan-out and delivery.

        # ── Bounded retry loop ───────────────────────────────────
        # Attempt once + retry on transient. We track the last
        # status so the post-loop branching has a deterministic
        # value even if every attempt raises.
        status_code = 599
        attempts = 1 + len(PUSH_RETRY_BACKOFF_S)
        import time as _time
        for attempt_idx in range(attempts):
            try:
                status_code = _send_one(
                    sub.endpoint, sub.p256dh_key, sub.auth_key, payload,
                )
            except Exception:
                logger.exception(
                    "[push] unexpected error sending to %s (attempt %d/%d)",
                    sub_id, attempt_idx + 1, attempts,
                )
                status_code = 599

            # Success → break out, no more attempts needed.
            if 200 <= status_code < 300:
                break

            # Hard failures - break and let the post-loop handler
            # delete / log.
            if status_code in (404, 410, 401, 403):
                break

            # Transient - sleep + retry. If this was the LAST
            # attempt, fall through to the failure-bump branch.
            if attempt_idx < len(PUSH_RETRY_BACKOFF_S):
                backoff = PUSH_RETRY_BACKOFF_S[attempt_idx]
                logger.info(
                    "[push] transient (status=%s) for sub %s - retrying in %ds "
                    "(attempt %d/%d)",
                    status_code, sub_id, backoff,
                    attempt_idx + 1, attempts,
                )
                _time.sleep(backoff)

        # ── Post-loop status handling ────────────────────────────
        if 200 <= status_code < 300:
            sub.last_pushed_at = datetime.utcnow()
            sub.failure_count = 0
            db.commit()
            return

        if status_code in (404, 410):
            # Subscription is dead - provider explicitly says "this
            # endpoint is gone." Drop the row; client will re-subscribe
            # next time the PWA loads.
            logger.info("[push] sub %s gone (status=%s) - deleting", sub_id, status_code)
            db.delete(sub)
            db.commit()
            return

        # Transient (429, 5xx) - every retry exhausted - OR auth
        # (401/403, which skips retry). Bump failure + log.
        sub.last_failure_at = datetime.utcnow()
        sub.failure_count = (sub.failure_count or 0) + 1
        new_fc = sub.failure_count
        endpoint_for_log = sub.endpoint  # capture before potential delete
        db.commit()

        if status_code in (401, 403):
            logger.error(
                "[push] AUTH FAILURE (status=%s) for sub %s - VAPID key may be wrong "
                "or the claim expired. Investigate immediately.",
                status_code, sub_id,
            )
        else:
            logger.warning(
                "[push] transient failure (status=%s) for sub %s after %d attempt(s); "
                "failure_count=%d",
                status_code, sub_id, attempts, new_fc,
            )

        # ── Dead-letter pruning ─────────────────────────────────
        # If we've failed N times in a row on the same endpoint,
        # auto-delete the subscription. Some push providers stop
        # returning 410 for endpoints they've internally GC'd -
        # without this threshold we'd retry forever. Operator sees
        # the dead-letter log line so they know which subscription
        # got pruned + why.
        if new_fc >= PUSH_DEAD_LETTER_THRESHOLD:
            try:
                # Re-fetch the sub in case the commit above invalidated
                # the in-memory copy.
                stale = db.query(PushSubscription).filter(
                    PushSubscription.id == sub_id
                ).first()
                if stale is not None:
                    db.delete(stale)
                    db.commit()
                    logger.warning(
                        "[push] DEAD-LETTER pruning sub %s (endpoint=%s, "
                        "failure_count=%d ≥ threshold=%d) - last status=%s",
                        sub_id, endpoint_for_log[:60] + "…",
                        new_fc, PUSH_DEAD_LETTER_THRESHOLD, status_code,
                    )
            except Exception:
                logger.exception(
                    "[push] dead-letter prune failed for sub %s", sub_id,
                )
                db.rollback()
    finally:
        db.close()


def _build_payload(report: "Report") -> Dict[str, Any]:
    """Map a Report row to the small notification payload.

    Kept deliberately small - payloads are encrypted but providers
    enforce a ~4 KB ceiling and bigger payloads have higher delivery
    failure rates on flaky links. The PWA's notificationclick handler
    uses `data.url` to open the right deep link.
    """
    status = getattr(report, "status", None)
    status_value = getattr(status, "value", str(status)) if status else "UPDATED"

    # Map status to a user-facing title / body. Localised on the client
    # side via the SW's i18n cache; here we send the canonical status
    # token + the CRISP brand string so the SW can render in any locale.
    if status_value == "RESPONDING":
        default_title = "Help is on the way"
        default_body = "A response team has been dispatched to your report."
    elif status_value == "RESOLVED":
        default_title = "Your report has been resolved"
        default_body = "The reported situation has been handled. Thank you for reporting."
    elif status_value == "FALSE_ALARM":
        default_title = "Report marked as a false alarm"
        default_body = "An analyst reviewed and closed your report."
    else:
        default_title = "Your CRISP report has an update"
        default_body = f"New status: {status_value}"

    report_id = getattr(report, "id", None)
    return {
        "title": default_title,
        "body": default_body,
        "tag": f"crisp-report-{report_id}" if report_id else "crisp-update",
        "data": {
            "report_id": report_id,
            "status": status_value,
            "url": f"/mobile-app/src/?report={report_id}" if report_id else "/mobile-app/src/",
        },
    }


def _subscriptions_for_reporter(
    db,
    *,
    device_hash: Optional[str],
    user_id: Optional[str],
) -> List[PushSubscription]:
    """Look up every PushSubscription that belongs to this reporter.

    A reporter may have multiple subscriptions: same person on phone +
    desktop, or same browser on multiple installs of the PWA. We push
    to all of them - each is one device × one browser instance.

    `OR` semantics: device_hash matches `device_hash IS NOT NULL` rows
    AND user_id matches `user_id IS NOT NULL` rows. A row that has
    BOTH set is matched once (DISTINCT).
    """
    if not device_hash and not user_id:
        return []
    q = db.query(PushSubscription)
    clauses = []
    if device_hash:
        clauses.append(PushSubscription.device_hash == device_hash)
    if user_id:
        clauses.append(PushSubscription.user_id == user_id)
    if len(clauses) == 1:
        q = q.filter(clauses[0])
    else:
        from sqlalchemy import or_
        q = q.filter(or_(*clauses))
    return q.all()


def push_report_status_change(report: "Report") -> int:
    """Fan out a "report status changed" push to the reporter.

    Called from the dispatch / resolve / false-alarm endpoint AFTER
    the DB commit. The caller already returned 200 to the analyst by
    the time we run; pushes happen on the executor pool.

    Returns the number of subscriptions enqueued for delivery (0 if
    VAPID is unconfigured, the reporter has no subscriptions, or the
    report is missing both identity fields).
    """
    global _warned_vapid_missing
    if not _vapid_configured():
        if not _warned_vapid_missing:
            logger.info(
                "[push] VAPID not configured (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / "
                "VAPID_CONTACT_EMAIL to enable) - skipping all reporter notifications."
            )
            _warned_vapid_missing = True
        return 0

    # Resolve the reporter identity. `Report.device_id` is an internal
    # UUID; we need the client-facing `device_hash`. Fetch via the
    # relationship (Device).
    device_hash: Optional[str] = None
    try:
        if report.device is not None:
            device_hash = report.device.device_hash
    except Exception:
        device_hash = None
    user_id: Optional[str] = getattr(report, "user_id", None)

    if not device_hash and not user_id:
        return 0

    db = SessionLocal()
    try:
        subs = _subscriptions_for_reporter(
            db, device_hash=device_hash, user_id=user_id,
        )
        if not subs:
            return 0
        payload = _build_payload(report)
        # Capture the IDs before submitting - we don't want the executor
        # threads holding references to the SQLAlchemy session objects.
        sub_ids = [s.id for s in subs]
    finally:
        db.close()

    for sid in sub_ids:
        _push_executor.submit(_deliver_one, sid, payload)
    logger.info(
        "[push] enqueued %d delivery(ies) for report %s (status=%s)",
        len(sub_ids),
        getattr(report, "id", "?"),
        getattr(getattr(report, "status", None), "value", "?"),
    )
    return len(sub_ids)


# ── Subscribe / unsubscribe ─────────────────────────────────────────────────

def upsert_subscription(
    db,
    *,
    endpoint: str,
    p256dh_key: str,
    auth_key: str,
    device_hash: Optional[str] = None,
    user_id: Optional[str] = None,
    user_agent: Optional[str] = None,
    locale: Optional[str] = None,
) -> PushSubscription:
    """Insert or update a PushSubscription row keyed by `endpoint`.

    The endpoint URL is globally unique per (browser × push provider)
    pair, so we use it as the natural dedup key. A repeat subscribe
    from the same device updates the identity columns (e.g. user
    just logged in - device_hash stays the same but user_id is now
    set). This is idempotent on the client side: the PWA can call
    `POST /api/v1/push/subscribe` on every load without creating
    duplicate rows.
    """
    if not (device_hash or user_id):
        raise ValueError("subscription must have device_hash or user_id")

    sub = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint == endpoint)
        .first()
    )
    if sub is None:
        sub = PushSubscription(
            endpoint=endpoint,
            p256dh_key=p256dh_key,
            auth_key=auth_key,
            device_hash=device_hash,
            user_id=user_id,
            user_agent=(user_agent or None),
            locale=(locale or None),
        )
        db.add(sub)
    else:
        # Refresh the keys (browser may have re-keyed) + identity.
        sub.p256dh_key = p256dh_key
        sub.auth_key = auth_key
        if device_hash:
            sub.device_hash = device_hash
        if user_id:
            sub.user_id = user_id
        if user_agent:
            sub.user_agent = user_agent
        if locale:
            sub.locale = locale
        # Reset transient failure state - the client just told us they
        # exist, so any past 5xx is stale.
        sub.failure_count = 0
        sub.last_failure_at = None
    db.commit()
    db.refresh(sub)
    return sub


def delete_subscription_by_endpoint(db, endpoint: str) -> bool:
    """Remove a subscription by endpoint URL. Returns True if a row was deleted."""
    sub = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint == endpoint)
        .first()
    )
    if sub is None:
        return False
    db.delete(sub)
    db.commit()
    return True
