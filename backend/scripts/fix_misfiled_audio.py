"""Fix S3 audio objects with mismatched extension/Content-Type.

Background — May 2026 audio playback bug. The legacy single-shot base64
attach path used `ext = "jpg" if "image" in header else "webm"`, so every
audio data: URL got renamed to `.webm` regardless of what the client
actually recorded. iOS records as MP4/AAC; the server stored those bytes
under a `.webm` key with Content-Type=audio/webm. The dashboard fed MP4
bytes into a WebM decoder → "Uncaught NotSupportedError: Failed to load
because no supported source was found".

This script scans every audio key in the bucket, sniffs the magic bytes,
and:
  - If the bytes match the extension + content-type → leave alone.
  - If the bytes mismatch → CopyObject to a renamed key with the correct
    Content-Type, update the corresponding `media.url` row, and delete
    the old key.

Idempotent — re-running just no-ops over already-correct files.

Usage:
    cd backend
    AWS_S3_BUCKET=... AWS_REGION=... python scripts/fix_misfiled_audio.py
    AWS_S3_BUCKET=... AWS_REGION=... python scripts/fix_misfiled_audio.py --confirm

Operator runs on EC2:
    docker compose -f docker-compose.prod.yml exec -T backend bash -c \
      "python /app/backend/scripts/fix_misfiled_audio.py --confirm"
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("fix_misfiled_audio")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


# Mirror the magic-byte detection in app.api.endpoints.reports
# (kept in sync, same checks).
def _sniff(raw: bytes) -> tuple[str, str] | None:
    if len(raw) >= 12 and raw[4:8] == b"ftyp":
        return ("m4a", "audio/mp4")
    if len(raw) >= 4 and raw[0:4] == b"\x1a\x45\xdf\xa3":
        return ("webm", "audio/webm")
    if len(raw) >= 4 and raw[0:4] == b"OggS":
        return ("ogg", "audio/ogg")
    if len(raw) >= 4 and raw[0:4] == b"RIFF":
        return ("wav", "audio/wav")
    if len(raw) >= 4 and raw[0:4] == b"caff":
        return ("caf", "audio/x-caf")
    if len(raw) >= 3 and (raw[:3] == b"ID3" or raw[0:1] == b"\xff"):
        return ("mp3", "audio/mpeg")
    return None


_AUDIO_EXTS = (".m4a", ".webm", ".wav", ".ogg", ".mp3", ".caf")


def main(dry_run: bool) -> int:
    bucket = os.getenv("AWS_S3_BUCKET", "").strip()
    region = os.getenv("AWS_REGION", "").strip()
    if not bucket or not region:
        logger.error("AWS_S3_BUCKET and AWS_REGION must be set.")
        return 2

    import boto3
    from botocore.config import Config
    from app.db.session import SessionLocal
    from app.models.report import Media

    s3 = boto3.client(
        "s3",
        region_name=region,
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
        ),
    )

    db = SessionLocal()
    n_scanned = 0
    n_ok = 0
    n_fixed = 0
    n_failed = 0
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                if not key.lower().endswith(_AUDIO_EXTS):
                    continue
                n_scanned += 1
                cur_ext = key.rsplit(".", 1)[-1].lower()

                # Read first 32 bytes to sniff.
                try:
                    body = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-31")["Body"].read()
                except Exception as e:
                    logger.warning(f"  [{key}] head read failed: {e}")
                    n_failed += 1
                    continue

                sniff = _sniff(body)
                if not sniff:
                    logger.info(f"  [{key}] unrecognisable magic bytes — skipping")
                    n_ok += 1
                    continue
                actual_ext, actual_ct = sniff

                if actual_ext == cur_ext:
                    # Extension already correct. Belt-and-braces: also
                    # verify the stored Content-Type matches; if not,
                    # patch in place via copy-to-self.
                    head = s3.head_object(Bucket=bucket, Key=key)
                    cur_ct = head.get("ContentType", "")
                    if cur_ct == actual_ct:
                        n_ok += 1
                        continue
                    logger.info(
                        f"  [{key}] ext matches but Content-Type "
                        f"{cur_ct!r} != {actual_ct!r}"
                    )
                    if dry_run:
                        logger.info(f"  [{key}]   WOULD copy-to-self with new content-type")
                        n_fixed += 1
                    else:
                        try:
                            s3.copy_object(
                                Bucket=bucket,
                                Key=key,
                                CopySource={"Bucket": bucket, "Key": key},
                                ContentType=actual_ct,
                                MetadataDirective="REPLACE",
                                ServerSideEncryption="AES256",
                            )
                            n_fixed += 1
                            logger.info(f"  [{key}]   patched content-type → {actual_ct}")
                        except Exception as e:
                            logger.error(f"  [{key}]   copy_object failed: {e}")
                            n_failed += 1
                    continue

                # Extension mismatch — rename + update DB row.
                stem = key.rsplit(".", 1)[0]
                new_key = f"{stem}.{actual_ext}"
                logger.info(
                    f"  [{key}] MISMATCH: stored as .{cur_ext} but bytes are "
                    f".{actual_ext} → rename to {new_key}"
                )

                if dry_run:
                    logger.info(f"  [{key}]   WOULD copy → {new_key}, update DB, delete old")
                    n_fixed += 1
                    continue

                try:
                    # 1. Copy to new key with correct content-type
                    s3.copy_object(
                        Bucket=bucket,
                        Key=new_key,
                        CopySource={"Bucket": bucket, "Key": key},
                        ContentType=actual_ct,
                        MetadataDirective="REPLACE",
                        ServerSideEncryption="AES256",
                    )
                    # 2. Update any DB row pointing at the old key.
                    # `media.url` and `media.thumbnail_url` are the two
                    # places audio URLs land. After Phase B the legacy
                    # /static/ path is also rewritten so we cover s3://
                    # exclusively.
                    old_db_url = f"s3://{key}"
                    new_db_url = f"s3://{new_key}"
                    n_url = (
                        db.query(Media)
                        .filter(Media.url == old_db_url)
                        .update({"url": new_db_url}, synchronize_session=False)
                    )
                    n_thumb = (
                        db.query(Media)
                        .filter(Media.thumbnail_url == old_db_url)
                        .update({"thumbnail_url": new_db_url}, synchronize_session=False)
                    )
                    logger.info(
                        f"  [{key}]   db rows updated: url={n_url}, thumbnail_url={n_thumb}"
                    )
                    # 3. Delete the old key only after DB commit succeeds.
                    db.commit()
                    s3.delete_object(Bucket=bucket, Key=key)
                    n_fixed += 1
                    logger.info(f"  [{key}]   renamed → {new_key} ({actual_ct})")
                except Exception as e:
                    db.rollback()
                    logger.error(f"  [{key}]   FAILED: {e}")
                    n_failed += 1
                    # Best-effort cleanup of the new key so we don't leave
                    # both copies on a partial failure.
                    try:
                        s3.delete_object(Bucket=bucket, Key=new_key)
                    except Exception:
                        pass

        logger.info("─" * 60)
        logger.info(f"Scanned: {n_scanned}, OK: {n_ok}, Fixed: {n_fixed}, Failed: {n_failed}")
        return 0 if n_failed == 0 else 1
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="Apply (default is dry-run).")
    args = parser.parse_args()
    sys.exit(main(dry_run=not args.confirm))
