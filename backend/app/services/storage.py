"""Media storage abstraction — local disk vs. AWS S3.

Apr 2026 — Phase 1 of the UNDP scaling story. Previously every photo,
audio file, partial chunk, and satellite verify thumbnail was written
to a Docker-named-volume on the EC2 instance's local disk
(`uploads:/usr/share/nginx/html/static`). That made EC2 a single
point of failure for media: container restart with the volume
recreated would drop everything, disk-full halted deploys, and the
architecture didn't scale horizontally.

This module abstracts the "where do media bytes live" decision behind
a single MediaStorage protocol. Two backends ship today:

  • LocalStorage  — preserves legacy behaviour (writes to UPLOAD_DIR,
                    serves via nginx /static/). Default for dev / CI.
  • S3Storage     — writes to a private S3 bucket via boto3. Reads
                    return signed presigned URLs with a short TTL.
                    For prod EC2.

Selected by the `MEDIA_BACKEND` env var (default `local`). The S3
backend uses boto3's default credential chain — on EC2 that picks up
the IAM instance profile automatically; locally it falls through to
~/.aws/credentials etc. We never ship static AWS creds in env vars.

DB storage format (`media.url` column):

  • LocalStorage  — `/static/<filename>` (legacy, unchanged)
  • S3Storage     — `s3://<key>` (a marker, not a real URL — backend
                    converts to a signed https:// URL on response
                    serialization via storage.public_url())

Migrating between backends:
  • Adding S3: set `MEDIA_BACKEND=s3`, run scripts/migrate_media_to_s3.py
    (uploads existing files to S3 + rewrites media.url rows).
  • Reverting to local: flip env var back. New uploads land on disk;
    old `s3://` rows still readable as long as S3 is reachable
    (S3Storage.read() handles both formats during migration windows).

The interface is intentionally narrow — just the operations the rest
of the app actually needs. No fancy directory listings, no streaming
uploads (we already buffer in memory anyway for chunk assembly).
"""
from __future__ import annotations

import logging
import os
from typing import Optional, Protocol

logger = logging.getLogger(__name__)


class MediaStorage(Protocol):
    """The contract every storage backend implements.

    `db_url` is whatever was previously written into media.url
    (a relative path on local, an `s3://...` marker on S3).
    `filename` is the bare object name without any prefix.
    """

    def save(self, filename: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        """Persist `data` under `filename`. Return the value to store
        in DB (media.url). Idempotent — overwriting an existing key
        is fine for chunked-upload reassembly."""
        ...

    def read(self, db_url: str) -> bytes:
        """Read back the bytes given the DB-stored URL. Backends are
        forgiving — S3Storage will read legacy `/static/...` rows from
        local disk if the bytes haven't been migrated yet, so the
        migration window doesn't break readers."""
        ...

    def delete(self, db_url: str) -> bool:
        """Remove the object. Returns True on success, False if the
        object didn't exist (idempotent — purge / GDPR-delete callers
        treat both the same)."""
        ...

    def public_url(self, db_url: str) -> str:
        """Convert a DB-stored URL to something a browser can fetch.
        For local: pass-through (the dashboard prepends BACKEND_HOST).
        For S3: signed presigned URL (~15 min TTL)."""
        ...


# ── Local-disk backend ──────────────────────────────────────────────────────

class LocalStorage:
    """Writes to UPLOAD_DIR, served by nginx via /static/<filename>.
    Preserves the exact behaviour of the pre-Apr-2026 code so dev / CI
    keep working unchanged."""

    def __init__(self, upload_dir: str):
        self.upload_dir = upload_dir
        os.makedirs(upload_dir, exist_ok=True)

    def save(self, filename: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        path = os.path.join(self.upload_dir, filename)
        with open(path, "wb") as f:
            f.write(data)
        return f"/static/{filename}"

    def read(self, db_url: str) -> bytes:
        if db_url.startswith("/static/"):
            path = os.path.join(self.upload_dir, db_url.replace("/static/", "", 1))
            with open(path, "rb") as f:
                return f.read()
        if db_url.startswith("s3://"):
            # Cross-backend read: someone flipped MEDIA_BACKEND back to
            # local but a row still has an s3:// URL. Without S3 creds
            # we can't fetch it; raise loudly so the operator sees it.
            raise FileNotFoundError(
                f"LocalStorage cannot read s3:// URL: {db_url}. "
                "Set MEDIA_BACKEND=s3 to read this row, or run the "
                "reverse migration script."
            )
        # Bare filename or legacy oddity — try as a relative path.
        path = os.path.join(self.upload_dir, db_url.lstrip("/"))
        with open(path, "rb") as f:
            return f.read()

    def delete(self, db_url: str) -> bool:
        if not db_url.startswith("/static/"):
            return False
        path = os.path.join(self.upload_dir, db_url.replace("/static/", "", 1))
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return False

    def public_url(self, db_url: str) -> str:
        # Pass through — dashboard's getMediaUrl() prepends BACKEND_HOST
        # to relative paths starting with `/`.
        return db_url


# ── AWS S3 backend ──────────────────────────────────────────────────────────

class S3Storage:
    """Writes to a private S3 bucket via boto3. Reads return short-TTL
    presigned URLs so the dashboard fetches directly from S3 without
    exposing the bucket publicly.

    Credentials: we rely on boto3's default chain. In prod that's the
    EC2 instance-profile attached IAM role; locally it falls through
    to ~/.aws/credentials, env vars, or container metadata. We never
    accept static creds in our own env vars — keeps the rotation
    surface aligned with AWS-native practice.
    """

    PRESIGN_TTL_SEC = 900  # 15 minutes

    def __init__(self, bucket: str, region: str, upload_dir_for_legacy_reads: Optional[str] = None):
        # Lazy import so dev environments without boto3 don't blow up
        # at module-import time.
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore

        self.bucket = bucket
        self.region = region
        # Keep a reference to the local upload dir so we can read
        # legacy /static/ rows during the migration window. The
        # migration script walks that dir and uploads each file; until
        # then, S3Storage.read() falls back to local disk for those.
        self.legacy_local_dir = upload_dir_for_legacy_reads
        # explicit `addressing_style='virtual'` + regional
        # endpoint URL forces boto3 to generate virtual-hosted-regional
        # URLs (`<bucket>.s3.<region>.amazonaws.com/...`) instead of the
        # legacy global form (`<bucket>.s3.amazonaws.com/...`). Without
        # this, presigned URLs got a 307 redirect to the regional
        # endpoint at request time — fine for direct fetches, but the
        # dashboard's CSP check happens BEFORE the redirect fires, so
        # we had to whitelist both hosts. SigV4 is required for
        # ap-south-1 + later regions and is the future-default anyway.
        self.s3 = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=f"https://s3.{region}.amazonaws.com",
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
            ),
        )

    def save(self, filename: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        # Object key matches the filename — keeps debug + grep simple
        # ("just look for sat_xyz_2.png" works in the bucket too).
        # ServerSideEncryption=AES256 is the default but explicit for
        # compliance auditing. No ACL set; bucket-default-private.
        self.s3.put_object(
            Bucket=self.bucket,
            Key=filename,
            Body=data,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
        return f"s3://{filename}"

    def read(self, db_url: str) -> bytes:
        if db_url.startswith("s3://"):
            key = db_url.replace("s3://", "", 1)
            resp = self.s3.get_object(Bucket=self.bucket, Key=key)
            return resp["Body"].read()
        if db_url.startswith("/static/") and self.legacy_local_dir:
            # Migration window: row not yet copied to S3, read from
            # local disk so the blur worker / verify endpoint don't
            # break mid-migration.
            path = os.path.join(self.legacy_local_dir, db_url.replace("/static/", "", 1))
            with open(path, "rb") as f:
                return f.read()
        raise FileNotFoundError(f"S3Storage cannot resolve {db_url}")

    def delete(self, db_url: str) -> bool:
        if db_url.startswith("s3://"):
            key = db_url.replace("s3://", "", 1)
            try:
                self.s3.delete_object(Bucket=self.bucket, Key=key)
                return True
            except Exception as exc:
                logger.warning(f"S3 delete failed for {key}: {exc}")
                return False
        if db_url.startswith("/static/") and self.legacy_local_dir:
            path = os.path.join(self.legacy_local_dir, db_url.replace("/static/", "", 1))
            try:
                os.remove(path)
                return True
            except FileNotFoundError:
                return False
        return False

    def public_url(self, db_url: str) -> str:
        if db_url.startswith("s3://"):
            key = db_url.replace("s3://", "", 1)
            try:
                return self.s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": self.bucket, "Key": key},
                    ExpiresIn=self.PRESIGN_TTL_SEC,
                )
            except Exception as exc:
                logger.warning(f"S3 presign failed for {key}: {exc}")
                # Best-effort fallback so the response still includes
                # SOMETHING. The dashboard will 403 on this URL but
                # at least the rest of the response renders.
                return db_url
        # Legacy /static/ pass-through — dashboard prepends BACKEND_HOST.
        return db_url


# ── Module-level singleton, selected by env ─────────────────────────────────

_storage: Optional[MediaStorage] = None


def get_storage() -> MediaStorage:
    """Return (and lazily build) the singleton storage backend.

    Selection rule:
      MEDIA_BACKEND=s3  →  S3Storage with AWS_S3_BUCKET + AWS_REGION
      otherwise         →  LocalStorage (default, current behaviour)

    Lazy because we want app boot to succeed even if MEDIA_BACKEND=s3
    is set but boto3 isn't installed (e.g. CI without the AWS extras).
    The ImportError surfaces on the first save/read call, not at import.
    """
    global _storage
    if _storage is not None:
        return _storage

    backend = os.getenv("MEDIA_BACKEND", "local").strip().lower()
    upload_dir = os.environ.get(
        "CRISP_UPLOAD_DIR",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "uploads")),
    )

    if backend == "s3":
        bucket = os.getenv("AWS_S3_BUCKET", "").strip()
        region = os.getenv("AWS_REGION", "").strip()
        if not bucket or not region:
            raise RuntimeError(
                "MEDIA_BACKEND=s3 requires AWS_S3_BUCKET and AWS_REGION env vars. "
                "On EC2 the IAM instance profile provides credentials automatically; "
                "no AWS_ACCESS_KEY_ID is needed. See docs/S3-MEDIA-MIGRATION.md."
            )
        logger.info(f"Media storage: S3 backend (bucket={bucket}, region={region})")
        _storage = S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
    else:
        logger.info(f"Media storage: local backend (upload_dir={upload_dir})")
        _storage = LocalStorage(upload_dir=upload_dir)

    return _storage


def reset_storage_for_tests() -> None:
    """Test-only: discard the cached singleton so each test can pick
    a fresh backend via monkeypatched env vars."""
    global _storage
    _storage = None
