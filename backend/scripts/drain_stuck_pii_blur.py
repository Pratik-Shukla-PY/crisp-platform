"""Drain the stuck PII-blur backlog (media pinned at pii_blur_status='pending').

Background - May 2026: a multi-image upload triggered a partial-preview blur
storm (full MediaPipe + easyocr blur on every partial render) that drove the
backend RSS to the host ceiling and OOM-killed uvicorn repeatedly. Each restart
orphaned the in-memory `_ai_executor` blur queue, leaving a subset of Media rows
stranded at `pii_blur_status='pending'`. The public `GET /reports/media/{id}/file`
gate returns **425 Too Early** for as long as a row is 'pending', so the dashboard
re-polls forever and the image shows an amber "Checking PII…" chip indefinitely.

The backend fix (Stage 1-3) kills the storm, caps memory, and adds a periodic +
boot-time recovery sweep that drains the backlog automatically. This script is the
one-shot manual companion for the EXISTING backlog - useful when you need to lift
the 425 **immediately** (e.g. before the fix is deployed) without waiting for the
sweep's cadence.

──────────────────────────────────────────────────────────────────────────────
PII SAFETY (UNDP must-have #7 - never expose a raw face)
──────────────────────────────────────────────────────────────────────────────
The /file gate returns 425 ONLY while status='pending'; EVERY other status -
including 'failed' - falls through to a 302 that serves the stored bytes. So
lifting the gate is only safe when the bytes are already face-redacted:

  • client_blur_applied = TRUE  → the PWA's BlazeFace pass blurred faces BEFORE
    upload. Serving them is PII-safe even if the server blur never ran. This
    script acts on these rows by default.

  • client_blur_applied = FALSE → server blur is the ONLY protection
    (Telegram / WhatsApp / SMS uploads). Lifting the gate here could expose a
    raw face, so these rows are SKIPPED unless you pass --include-unblurred AND
    accept the documented risk. Default behaviour leaves them safely gated.

──────────────────────────────────────────────────────────────────────────────
Modes
──────────────────────────────────────────────────────────────────────────────
  --mode fail  (default)  DB-only. Flip stuck client-blurred 'pending' rows →
                          'failed'. Lifts the 425 instantly; the dashboard shows
                          a red "redaction failed" chip and renders the
                          client-blurred image. No ML deps, no memory pressure -
                          SAFE to run during an active OOM window.

  --mode redrive          Loads the blur stack and re-runs server PII blur
                          SEQUENTIALLY (one row at a time - never concurrent,
                          since concurrent blur is what caused the OOM) so rows
                          land a clean 'complete_*' status (no red chip).
                          Heavier: run post-deploy / post-swap when memory is
                          available. NOTE: the deployed backend's boot+periodic
                          sweep already re-drives client-blurred rows, so you
                          usually do NOT need redrive mode by hand.

Dry-run by default; pass --confirm to actually act.

Idempotent - re-runs are safe (matches zero rows once the backlog is cleared).

Usage:
    cd ~/crisp
    # See what's stuck (changes nothing):
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/drain_stuck_pii_blur.py"

    # Immediately lift the 425 for client-blurred rows (red chip, instant):
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/drain_stuck_pii_blur.py --confirm"

    # Clean re-blur to a green status (heavier; post-deploy):
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/drain_stuck_pii_blur.py --confirm --mode redrive"

    # Target just one report's media:
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/drain_stuck_pii_blur.py --confirm --report-id <uuid>"
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("drain_stuck_pii_blur")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Skip a row if its blur was (re)dispatched within this many minutes - it may be
# actively running; don't race it. Overridable via --min-age-min.
_DEFAULT_MIN_AGE_MIN = 2


def _filename_from_url(url: str) -> str:
    """Storage filename from a media.url tail - works for /static/<f> and
    s3://<f> alike (same derivation the AI pipeline + recovery sweep use)."""
    return url.rsplit("/", 1)[-1].split("://", 1)[-1].rsplit("/", 1)[-1]


def main(
    *,
    dry_run: bool,
    mode: str,
    include_unblurred: bool,
    min_age_min: int,
    report_id: str | None,
) -> int:
    from datetime import datetime, timezone, timedelta

    from app.db.session import SessionLocal
    # Register the auth models (users/organizations) before touching Media,
    # which has FKs into them - same cold-bootstrap gotcha as the other
    # scripts that bypass the FastAPI app-boot path.
    from app.models import auth as _auth  # noqa: F401
    from app.models.report import Media

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=min_age_min)

    db = SessionLocal()
    try:
        def _base():
            q = db.query(Media).filter(
                Media.pii_blur_status == "pending",
                Media.assembly_status == "complete",
                Media.updated_at < cutoff,
            )
            if report_id:
                q = q.filter(Media.report_id == report_id)
            return q

        client_blurred = _base().filter(Media.client_blur_applied.is_(True)).all()
        not_blurred = _base().filter(Media.client_blur_applied.is_(False)).all()

        logger.info(
            f"Stuck 'pending' media older than {min_age_min}m"
            + (f" for report {report_id}" if report_id else "")
            + f": {len(client_blurred)} client-blurred (PII-safe to clear), "
            f"{len(not_blurred)} NOT client-blurred (server blur is sole protection)."
        )
        for m in client_blurred[:20]:
            logger.info(f"  client-blurred  {m.id}  (report {m.report_id})")
        if len(client_blurred) > 20:
            logger.info(f"  … +{len(client_blurred) - 20} more client-blurred")
        for m in not_blurred[:20]:
            logger.info(f"  NOT-blurred     {m.id}  (report {m.report_id})")
        if len(not_blurred) > 20:
            logger.info(f"  … +{len(not_blurred) - 20} more NOT-blurred")

        # Build the working set per the PII-safety policy.
        targets = list(client_blurred)
        if include_unblurred:
            if not_blurred:
                logger.warning(
                    "\n"
                    "  ╔══════════════════════════════════════════════════════════════╗\n"
                    "  ║  --include-unblurred: acting on NON-client-blurred rows.       ║\n"
                    "  ║  Server blur is the ONLY face protection for these. Lifting    ║\n"
                    "  ║  the 425 (fail mode) serves the stored bytes AS-IS, which may   ║\n"
                    "  ║  contain RAW, UNBLURRED FACES. Only proceed if you have         ║\n"
                    "  ║  confirmed the source is trusted / contains no people.          ║\n"
                    "  ╚══════════════════════════════════════════════════════════════╝"
                )
            targets += list(not_blurred)
        elif not_blurred:
            logger.info(
                f"Leaving {len(not_blurred)} NOT-client-blurred row(s) gated at 425 "
                "(safe). Pass --include-unblurred to act on them too (risk above)."
            )

        if not targets:
            logger.info("Nothing to do.")
            return 0

        if dry_run:
            logger.info(
                f"Dry run - would {mode} {len(targets)} row(s). "
                "Pass --confirm to act."
            )
            return 0

        if mode == "fail":
            # DB-only: flip → 'failed'. Lifts the 425; client-blurred bytes are
            # served (PII-safe); dashboard shows the red "redaction failed" chip.
            ids = [m.id for m in targets]
            n = (
                db.query(Media)
                .filter(Media.id.in_(ids))
                .update({"pii_blur_status": "failed"}, synchronize_session=False)
            )
            db.commit()
            logger.info(f"Flipped {n} row(s) → 'failed' (425 lifted).")
            return 0

        # mode == "redrive": re-run server blur SEQUENTIALLY. _run_server_pii_blur
        # never raises and writes its own terminal status in a fresh session, so
        # we just call it once per row with a small breather between heavy runs.
        from app.api.endpoints.reports import _run_server_pii_blur

        done = 0
        for m in targets:
            url = m.url or ""
            if not url:
                logger.warning(f"  skip {m.id}: empty url")
                continue
            fn = _filename_from_url(url)
            logger.info(f"  re-blurring {m.id} ({fn}) …")
            _run_server_pii_blur(m.id, url, fn)  # synchronous; writes terminal status
            done += 1
            time.sleep(0.5)  # bound peak memory - never overlap two blurs
        logger.info(f"Re-drove {done} row(s) through server PII blur.")
        return 0
    except Exception as e:
        db.rollback()
        logger.error(f"Drain failed (rolled back): {e}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Drain stuck pii_blur_status='pending' media.")
    parser.add_argument(
        "--confirm", action="store_true",
        help="Actually act (default: dry-run, changes nothing).",
    )
    parser.add_argument(
        "--mode", choices=["fail", "redrive"], default="fail",
        help="fail (default): DB-only flip → 'failed', instant 425 lift, red chip. "
             "redrive: re-run server blur sequentially → clean status (heavier).",
    )
    parser.add_argument(
        "--include-unblurred", action="store_true",
        help="Also act on client_blur_applied=false rows. RISK: may expose raw "
             "faces (server blur is their only protection). See header.",
    )
    parser.add_argument(
        "--min-age-min", type=int, default=_DEFAULT_MIN_AGE_MIN,
        help=f"Only act on rows not updated within this many minutes "
             f"(default {_DEFAULT_MIN_AGE_MIN}; avoids racing an active blur).",
    )
    parser.add_argument(
        "--report-id", default=None,
        help="Restrict to a single report's media (UUID).",
    )
    args = parser.parse_args()
    sys.exit(
        main(
            dry_run=not args.confirm,
            mode=args.mode,
            include_unblurred=args.include_unblurred,
            min_age_min=args.min_age_min,
            report_id=args.report_id,
        )
    )
