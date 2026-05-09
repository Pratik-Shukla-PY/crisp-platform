"""Purge accumulated CI smoke-test reports from prod.

Background — May 2026: the GitHub Actions `prod-smoke` Playwright job
ran on every deploy and submitted a synthetic report with
`device_hash = "prod-smoke-<timestamp>"` via POST /reports/meta to
verify the meta endpoint works end-to-end. The test never cleaned up
afterward, so each deploy left one row behind. Over weeks of CI
activity that became visible noise on the analyst dashboard.

This script does a one-time purge of all rows whose owning device's
hash matches `prod-smoke-*`. From the May 2026 sprint onwards the
spec itself wraps in try/finally + DELETE /reports/device/{hash},
so this is needed once for the historical accumulation.

Idempotent — re-runs are safe (matches zero rows on second pass).
Dry-run by default; `--confirm` actually deletes.

Usage:
    cd ~/crisp
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/purge_smoke_test_reports.py"
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \\
      "python /app/backend/scripts/purge_smoke_test_reports.py --confirm"

Match policy:
  Default — `device.hash` LIKE `prod-smoke-%`.
  --include-test-prefix — also matches LIKE `TEST-%` (older test
  fixtures from the SQLite era; should be empty in current prod but
  kept for completeness).
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("purge_smoke_test_reports")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def main(dry_run: bool, include_test_prefix: bool) -> int:
    from app.db.session import SessionLocal
    from app.models.report import Report, Device, Media

    db = SessionLocal()
    try:
        # Build the patterns we recognise as smoke-test garbage.
        patterns = ["prod-smoke-%"]
        if include_test_prefix:
            patterns.append("TEST-%")

        # Find Device rows matching any pattern.
        from sqlalchemy import or_
        device_q = db.query(Device).filter(
            or_(*[Device.device_hash.like(p) for p in patterns])
        )
        devices = device_q.all()
        logger.info(
            f"Devices matching {patterns}: {len(devices)}"
        )
        if not devices:
            logger.info("Nothing to do.")
            return 0

        # Tally reports per device for the dry-run summary.
        device_ids = [d.id for d in devices]
        report_count_by_device: dict[str, int] = {}
        total_reports = 0
        for d in devices:
            n = db.query(Report).filter(Report.device_id == d.id).count()
            report_count_by_device[d.device_hash] = n
            total_reports += n

        logger.info(f"Reports linked to those devices: {total_reports}")
        for hash_str, n in sorted(report_count_by_device.items()):
            logger.info(f"  {hash_str}: {n} report(s)")

        if dry_run:
            logger.info("Dry run — pass --confirm to actually delete.")
            return 0

        # Real run: delete the reports + the devices themselves.
        # Use the existing endpoint helper (delete_device_data) logic
        # rather than duplicating it — same media-file cleanup, same
        # commit semantics. Hits HTTP-internal directly via TestClient
        # would be overkill; raw SQL DELETE is fine since the smoke
        # rows have no associated media files (no chunked upload).
        n_reports_deleted = 0
        n_devices_deleted = 0
        for d in devices:
            # Defensive media cleanup (smoke runs don't upload media,
            # but legacy TEST-* rows might).
            reports = db.query(Report).filter(Report.device_id == d.id).all()
            for r in reports:
                # Cascade: media rows
                db.query(Media).filter(Media.report_id == r.id).delete(
                    synchronize_session=False
                )
                db.delete(r)
                n_reports_deleted += 1
            db.delete(d)
            n_devices_deleted += 1

        db.commit()
        logger.info(
            f"Purged {n_reports_deleted} report(s) + {n_devices_deleted} device(s)."
        )
        return 0
    except Exception as e:
        db.rollback()
        logger.error(f"Purge failed (rolled back): {e}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Actually delete (default dry-run).")
    parser.add_argument(
        "--include-test-prefix",
        action="store_true",
        help="Also match TEST-* device hashes (older fixtures).",
    )
    args = parser.parse_args()
    sys.exit(main(dry_run=not args.confirm, include_test_prefix=args.include_test_prefix))
