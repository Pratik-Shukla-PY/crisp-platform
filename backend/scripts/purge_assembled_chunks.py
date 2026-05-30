"""Reclaim media_chunks for already-assembled media (post-assembly cleanup backfill).

Background — May 2026: `media_chunks` rows hold the raw uploaded bytes ONLY for
reassembly. Once a Media row reaches `assembly_status='complete'` with its
assembled file durably in storage, the chunks are dead weight — the public
`GET /media/{id}/file` route serves `media.url` from storage, never the chunks
(and the `pre_blur/` retention store, not chunks, backs any re-blur). They were
historically never deleted, so they accumulated (DB bloat + original bytes at
rest).

`_assemble_media_file` now reclaims them INLINE on completion. This script is the
one-shot backfill for the EXISTING accumulation — rows that completed before the
inline reclaim shipped, or that the inline reclaim skipped because a transient
`storage.exists()` check returned False.

Safety:
  * Acts ONLY on media with `assembly_status='complete'` (failed / pending /
    assembling rows keep their chunks — they may still need them).
  * By default verifies the assembled object is actually present in storage
    (`storage.exists(media.url)`) before deleting that media's chunks; skips +
    logs otherwise. Pass --no-verify-storage to delete on status alone.
  * Dry-run by default — prints what it would do, changes nothing. Pass
    --confirm to act.

Usage:
  python scripts/purge_assembled_chunks.py                      # dry-run
  python scripts/purge_assembled_chunks.py --confirm            # delete (storage-verified)
  python scripts/purge_assembled_chunks.py --confirm --no-verify-storage
  python scripts/purge_assembled_chunks.py --report-id <uuid>   # scope to one report
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

# Same cold-bootstrap path trick as the other ops scripts: make `app...`
# importable when run directly (not via the FastAPI app boot).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("purge_assembled_chunks")


def main(*, dry_run: bool, verify_storage: bool, report_id: str | None) -> int:
    from sqlalchemy import func

    from app.db.session import SessionLocal
    # Register auth models (FKs into users/organizations) before touching
    # Media — same gotcha as the sibling scripts that bypass app-boot.
    from app.models import auth as _auth  # noqa: F401
    from app.models.report import Media, MediaChunk

    storage = None
    if verify_storage:
        try:
            from app.services.storage import get_storage
            storage = get_storage()
        except Exception as e:  # pragma: no cover — defensive
            logger.warning(
                f"storage init failed ({e}) — proceeding WITHOUT storage verification "
                "(delete based on assembly_status alone)"
            )
            storage = None

    db = SessionLocal()
    try:
        q = db.query(Media).filter(Media.assembly_status == "complete")
        if report_id:
            q = q.filter(Media.report_id == report_id)
        complete_media = q.all()

        # Of those, which still carry chunk rows.
        targets: list[tuple[Media, int]] = []
        total_chunks = 0
        for m in complete_media:
            n = (
                db.query(func.count(MediaChunk.id))
                .filter(MediaChunk.media_id == m.id)
                .scalar()
                or 0
            )
            if n:
                targets.append((m, n))
                total_chunks += n

        logger.info(
            f"{len(complete_media)} complete media"
            + (f" for report {report_id}" if report_id else "")
            + f"; {len(targets)} still carry chunks ({total_chunks} chunk rows)."
        )
        if not targets:
            logger.info("Nothing to reclaim.")
            return 0

        reclaimed = 0
        skipped = 0
        for m, n in targets:
            if verify_storage and storage is not None:
                present = False
                try:
                    present = bool(m.url) and storage.exists(m.url)
                except Exception as e:
                    logger.warning(f"  {m.id}: storage.exists raised ({e}) — skipping")
                    present = False
                if not present:
                    logger.warning(
                        f"  {m.id}: assembled object NOT confirmed in storage "
                        f"(url={m.url!r}) — skipping, {n} chunk(s) kept"
                    )
                    skipped += 1
                    continue

            if dry_run:
                logger.info(
                    f"  [dry-run] would reclaim {n} chunk(s) for {m.id} "
                    f"(report {m.report_id})"
                )
                reclaimed += n
                continue

            deleted = (
                db.query(MediaChunk)
                .filter(MediaChunk.media_id == m.id)
                .delete(synchronize_session=False)
            )
            db.commit()
            reclaimed += deleted
            logger.info(f"  reclaimed {deleted} chunk(s) for {m.id}")

        verb = "would reclaim" if dry_run else "reclaimed"
        logger.info(
            f"Done. {verb} {reclaimed} chunk row(s) across "
            f"{len(targets) - skipped} media; {skipped} skipped (storage unconfirmed)."
        )
        if dry_run:
            logger.info("Dry run — nothing deleted. Pass --confirm to act.")
        return 0
    except Exception as e:
        db.rollback()
        logger.error(f"Backfill failed (rolled back): {e}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Reclaim media_chunks for assembled (complete) media."
    )
    parser.add_argument(
        "--confirm", action="store_true",
        help="Actually delete (default: dry-run, changes nothing).",
    )
    parser.add_argument(
        "--no-verify-storage", action="store_true",
        help="Skip the storage.exists() pre-check; delete on assembly_status alone.",
    )
    parser.add_argument(
        "--report-id", default=None, help="Restrict to a single report's media (UUID).",
    )
    args = parser.parse_args()
    sys.exit(
        main(
            dry_run=not args.confirm,
            verify_storage=not args.no_verify_storage,
            report_id=args.report_id,
        )
    )
