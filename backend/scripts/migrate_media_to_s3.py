"""Migrate existing local media files to S3 + rewrite media.url rows.

Apr 2026 - UNDP scaling: Phase 1 of the S3 + CloudFront migration.
This script is run ONCE per environment after `MEDIA_BACKEND=s3` is
flipped on. It walks the local UPLOAD_DIR, uploads each file to the
configured S3 bucket, and rewrites the corresponding `media.url` row
(and `satellite_verifications.satellite_image_url*`) so the dashboard
keeps showing existing media without 404s.

Idempotent - re-running is safe. Each object is checked via S3 HEAD
before upload; existing keys are skipped (assumed already-migrated)
and the DB row is still rewritten if it points at a /static/ path.

Usage:
    cd ~/crisp
    docker compose -f docker-compose.prod.yml exec -T backend bash -c "
      python /app/backend/scripts/migrate_media_to_s3.py --dry-run
    "
    # Review the printed plan, then for real:
    docker compose -f docker-compose.prod.yml exec -T backend bash -c "
      python /app/backend/scripts/migrate_media_to_s3.py --confirm
    "

Flags:
    --dry-run    print what would happen, don't upload or rewrite (default).
    --confirm    actually do the work.
    --limit N    process at most N files (useful for canary runs).

Operator runbook: docs/S3-MEDIA-MIGRATION.md.
"""
from __future__ import annotations

import argparse
import os
import sys
import logging
from typing import Optional

# Make `app.*` importable when run directly via the docker exec wrapper.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("migrate_media_to_s3")


def _content_type_for(filename: str) -> str:
    f = (filename or "").lower()
    if f.endswith(".jpg") or f.endswith(".jpeg"): return "image/jpeg"
    if f.endswith(".png"):                         return "image/png"
    if f.endswith(".webp"):                        return "image/webp"
    if f.endswith(".m4a"):                         return "audio/mp4"
    if f.endswith(".webm"):                        return "audio/webm"
    if f.endswith(".ogg"):                         return "audio/ogg"
    if f.endswith(".wav"):                         return "audio/wav"
    if f.endswith(".mp3"):                         return "audio/mpeg"
    return "application/octet-stream"


def main(dry_run: bool, limit: Optional[int]) -> int:
    bucket = os.getenv("AWS_S3_BUCKET", "").strip()
    region = os.getenv("AWS_REGION", "").strip()
    upload_dir = os.environ.get(
        "CRISP_UPLOAD_DIR",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "uploads")),
    )

    if not bucket or not region:
        logger.error(
            "AWS_S3_BUCKET and AWS_REGION must be set. "
            "On EC2: ensure the IAM instance profile is attached + the env "
            "vars are in .env.production."
        )
        return 2

    if not os.path.isdir(upload_dir):
        logger.error(f"Local upload dir does not exist: {upload_dir}")
        return 2

    logger.info(f"Source dir:  {upload_dir}")
    logger.info(f"Target bucket: s3://{bucket}/ (region={region})")
    logger.info(f"Mode: {'DRY-RUN (no changes)' if dry_run else 'CONFIRM (will upload + rewrite DB)'}")

    # Lazy imports so --help works without boto3 / DB env.
    import boto3
    from botocore.exceptions import ClientError
    from app.db.session import SessionLocal
    from app.models.report import Media, SatelliteVerification

    s3 = boto3.client("s3", region_name=region)

    # ── Inventory: walk the upload dir, build the migration plan ──────────
    files = sorted(os.listdir(upload_dir))
    total = len(files)
    logger.info(f"Local file count: {total}")
    if limit is not None and limit < total:
        files = files[:limit]
        logger.info(f"Limited to first {limit} files for this run")

    n_uploaded = 0
    n_skipped_existing = 0
    n_failed = 0
    rewritten_media: list[tuple[str, str, str]] = []  # (id, old, new)

    db = SessionLocal()
    try:
        # ── Pass 1: upload files to S3 ────────────────────────────────
        for fname in files:
            local_path = os.path.join(upload_dir, fname)
            if not os.path.isfile(local_path):
                continue

            # Idempotency: if key already in S3, skip the upload.
            already_in_s3 = False
            try:
                s3.head_object(Bucket=bucket, Key=fname)
                already_in_s3 = True
            except ClientError as e:
                if e.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                    logger.warning(f"head_object error for {fname}: {e}")

            if already_in_s3:
                n_skipped_existing += 1
                logger.info(f"  [{fname}] already in S3 (skipped upload)")
            else:
                if dry_run:
                    logger.info(f"  [{fname}] WOULD upload ({os.path.getsize(local_path):,} bytes)")
                else:
                    try:
                        with open(local_path, "rb") as f:
                            data = f.read()
                        s3.put_object(
                            Bucket=bucket,
                            Key=fname,
                            Body=data,
                            ContentType=_content_type_for(fname),
                            ServerSideEncryption="AES256",
                        )
                        n_uploaded += 1
                        logger.info(f"  [{fname}] uploaded ({len(data):,} bytes)")
                    except Exception as e:
                        n_failed += 1
                        logger.error(f"  [{fname}] upload FAILED: {e}")

        # ── Pass 2: rewrite media.url rows pointing at /static/ ───────
        legacy_rows = (
            db.query(Media)
            .filter(Media.url.like("/static/%"))
            .all()
        )
        logger.info(f"Media rows still pointing at /static/: {len(legacy_rows)}")
        for m in legacy_rows:
            old = m.url
            fname = old.replace("/static/", "", 1)
            new = f"s3://{fname}"
            if dry_run:
                logger.info(f"  [{m.id[:8]}] WOULD rewrite {old} → {new}")
            else:
                m.url = new
                logger.info(f"  [{m.id[:8]}] rewrote {old} → {new}")
            rewritten_media.append((m.id, old, new))

        # ── Pass 2b: rewrite media.thumbnail_url rows pointing at /static/ ──
        # original migration only rewrote `media.url`. The
        # `thumbnail_url` column (set by attach_thumbnail for image
        # fast-previews and by _try_partial_audio_bg for streaming
        # audio) still pointed at the old /static/ path even though
        # Pass 1 already uploaded the file to S3. The dashboard's
        # MediaResponse._resolve_url field_serializer
        # then signed an /static/-pass-through URL - works only while
        # the local UPLOAD_DIR still has the file. Once we GC the
        # local mirror, those rows would 404.
        legacy_thumb_rows = (
            db.query(Media)
            .filter(Media.thumbnail_url.like("/static/%"))
            .all()
        )
        logger.info(
            f"Media rows still pointing thumbnail_url at /static/: "
            f"{len(legacy_thumb_rows)}"
        )
        for m in legacy_thumb_rows:
            old_t = m.thumbnail_url
            fname_t = old_t.replace("/static/", "", 1)
            new_t = f"s3://{fname_t}"
            # Defensive: only rewrite when the key actually exists in S3
            # (Pass 1 uploads everything in UPLOAD_DIR, so this should
            # always be true - but a row might reference a name that
            # was deleted from disk before migration ran). Without the
            # head_object check we'd happily rewrite a row to point at
            # a 404, breaking the partial-preview render path.
            try:
                s3.head_object(Bucket=bucket, Key=fname_t)
                exists_in_s3 = True
            except ClientError as e:
                code = e.response["Error"]["Code"]
                if code in ("404", "NoSuchKey", "NotFound"):
                    exists_in_s3 = False
                else:
                    logger.warning(
                        f"  [{m.id[:8]}.thumbnail_url] head_object error "
                        f"for {fname_t}: {e} - skipping rewrite to be safe"
                    )
                    exists_in_s3 = False

            if not exists_in_s3:
                logger.warning(
                    f"  [{m.id[:8]}.thumbnail_url] {old_t} not in S3 - leaving as-is"
                )
                continue

            if dry_run:
                logger.info(f"  [{m.id[:8]}.thumbnail_url] WOULD rewrite {old_t} → {new_t}")
            else:
                m.thumbnail_url = new_t
                logger.info(f"  [{m.id[:8]}.thumbnail_url] rewrote {old_t} → {new_t}")

        # ── Pass 3: rewrite satellite_verifications URLs ─────────────
        legacy_sat = (
            db.query(SatelliteVerification)
            .filter(SatelliteVerification.satellite_image_url.like("/static/%"))
            .all()
        )
        logger.info(f"SatelliteVerification rows still pointing at /static/ (primary): {len(legacy_sat)}")
        for v in legacy_sat:
            for attr in ("satellite_image_url", "satellite_image_url_alt"):
                old = getattr(v, attr, None)
                if old and old.startswith("/static/"):
                    fname = old.replace("/static/", "", 1)
                    new = f"s3://{fname}"
                    if dry_run:
                        logger.info(f"  [{v.id[:8]}.{attr}] WOULD rewrite {old} → {new}")
                    else:
                        setattr(v, attr, new)
                        logger.info(f"  [{v.id[:8]}.{attr}] rewrote {old} → {new}")

            # The satellite_images_json field - JSON list with `url` per entry.
            if v.satellite_images_json:
                import json as _json
                try:
                    parsed = _json.loads(v.satellite_images_json)
                    changed = False
                    if isinstance(parsed, list):
                        for entry in parsed:
                            if isinstance(entry, dict):
                                u = entry.get("url")
                                if u and u.startswith("/static/"):
                                    entry["url"] = f"s3://{u.replace('/static/', '', 1)}"
                                    changed = True
                    if changed:
                        if dry_run:
                            logger.info(f"  [{v.id[:8]}.satellite_images_json] WOULD rewrite {len(parsed)} entries")
                        else:
                            v.satellite_images_json = _json.dumps(parsed)
                            logger.info(f"  [{v.id[:8]}.satellite_images_json] rewrote {len(parsed)} entries")
                except Exception as e:
                    logger.warning(f"  [{v.id[:8]}] satellite_images_json parse failed: {e}")

        if not dry_run:
            db.commit()
            logger.info("DB commit successful.")
        else:
            db.rollback()

    finally:
        db.close()

    logger.info("─" * 60)
    logger.info(f"Files uploaded:         {n_uploaded}")
    logger.info(f"Files already in S3:    {n_skipped_existing}")
    logger.info(f"Upload failures:        {n_failed}")
    logger.info(f"Media rows rewritten:   {len(rewritten_media)}")
    logger.info("─" * 60)
    if dry_run:
        logger.info("DRY-RUN complete. Re-run with --confirm to apply.")
    else:
        logger.info("Migration complete.")
    return 0 if n_failed == 0 else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="Default. Print plan, don't change anything.")
    p.add_argument("--confirm", action="store_true", help="Actually upload + rewrite. Mutually exclusive with --dry-run.")
    p.add_argument("--limit", type=int, default=None, help="Process at most N files.")
    args = p.parse_args()
    if args.confirm and args.dry_run:
        print("Pick one: --dry-run OR --confirm.")
        sys.exit(2)
    is_dry = not args.confirm
    sys.exit(main(dry_run=is_dry, limit=args.limit))
