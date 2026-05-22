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

    # ── B-F (May 2026) — internal-only store for pre-blur retention ──
    # These methods write/read/delete from a sibling namespace that is
    # NEVER exposed via public routes. Used by the retroactive blur
    # upgrade path: when a higher-tier arrival detects additional PII,
    # the worker fetches the lower tier's pre-blur bytes from here,
    # re-blurs with the union, and overwrites the public copy.

    def save_internal(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        """Persist `data` under a private `pre_blur/` namespace. Return
        a key (relative) for later read/delete. NEVER exposed to a
        browser route or via public_url()."""
        ...

    def read_internal(self, key: str) -> bytes:
        """Read back bytes from `pre_blur/<key>`. Raises if expired or
        never existed."""
        ...

    def delete_internal(self, key: str) -> bool:
        """Remove `pre_blur/<key>`. Idempotent."""
        ...

    # ── R3.b (May 2026) — disk-orphan reconciliation surface ──
    # The daemon's Action ⑦ walks the storage backend and cross-
    # references against live Media.url rows. Anything older than
    # CRISP_HARD_ABANDON_DAYS with no live referrer is deleted.

    def list_keys(
        self, *, prefix: str = "", older_than_unix_ts: float | None = None,
        limit: int = 1000,
    ) -> list[tuple[str, float]]:
        """Return up to ``limit`` (key, mtime_unix) tuples under ``prefix``.

        ``key`` is the bare filename / S3 object key (no scheme, no
        leading prefix). ``mtime_unix`` is the storage object's
        last-modified timestamp.

        If ``older_than_unix_ts`` is supplied, only entries with
        ``mtime <= older_than_unix_ts`` are returned — this lets the
        daemon avoid pulling fresh entries it would never delete.

        Implementations MUST be paginated under the hood (S3 buckets
        can have millions of objects) but always return a single
        flat list capped at ``limit``. The daemon calls multiple
        times if it wants more results."""
        ...


# ── Local-disk backend ──────────────────────────────────────────────────────

_PRE_BLUR_PREFIX = "pre_blur"


class LocalStorage:
    """Writes to UPLOAD_DIR, served by nginx via /static/<filename>.
    Preserves the exact behaviour of the pre-Apr-2026 code so dev / CI
    keep working unchanged."""

    def __init__(self, upload_dir: str):
        self.upload_dir = upload_dir
        os.makedirs(upload_dir, exist_ok=True)
        # B-F (May 2026): internal store for pre-blur retention.
        # Lives under a subdir of the same upload root so dev backups
        # cover it, but nginx is NOT configured to serve from it
        # (the /static/ alias maps to upload_dir, not pre_blur/).
        # Bytes here are never exposed publicly.
        self.pre_blur_dir = os.path.join(upload_dir, _PRE_BLUR_PREFIX)
        os.makedirs(self.pre_blur_dir, exist_ok=True)

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

    # ── B-F internal-store interface ──────────────────────────────────
    # The pre_blur/ subdir is for storing un-blurred assembled bytes
    # during the 24h retroactive-upgrade window. Bytes are NEVER served
    # publicly (nginx alias `/static/` maps to upload_dir only, not
    # this subdir). The sweep daemon purges entries after retention
    # expires.

    def save_internal(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        """Persist `data` under the internal pre_blur/ prefix.
        Returns a relative key (NOT a public URL) for later read /
        delete. Idempotent overwrite."""
        path = os.path.join(self.pre_blur_dir, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return key

    def read_internal(self, key: str) -> bytes:
        """Read back bytes from the pre_blur/ prefix. Raises
        FileNotFoundError if the entry was purged or never existed."""
        path = os.path.join(self.pre_blur_dir, key)
        with open(path, "rb") as f:
            return f.read()

    def delete_internal(self, key: str) -> bool:
        """Remove a pre_blur/ entry. Idempotent."""
        path = os.path.join(self.pre_blur_dir, key)
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return False

    # ── R3.b — disk-orphan reconciliation surface (local) ──────────
    def list_keys(
        self, *, prefix: str = "", older_than_unix_ts: float | None = None,
        limit: int = 1000,
    ) -> list[tuple[str, float]]:
        """List up to ``limit`` (filename, mtime_unix) under ``upload_dir``.

        The ``prefix`` semantics: an empty string lists the upload_dir
        root (the public assembled files). ``prefix=_PRE_BLUR_PREFIX``
        lists the internal pre_blur namespace. Anything else is treated
        as a literal subdir under upload_dir.

        The pre_blur dir is skipped from a root-prefix scan so the
        daemon's public-storage GC doesn't see internal bytes.
        """
        if prefix == _PRE_BLUR_PREFIX:
            root = self.pre_blur_dir
        elif prefix:
            root = os.path.join(self.upload_dir, prefix)
        else:
            root = self.upload_dir
        if not os.path.isdir(root):
            return []
        out: list[tuple[str, float]] = []
        for name in os.listdir(root):
            # Skip the pre_blur subdir when scanning the root.
            if prefix == "" and name == _PRE_BLUR_PREFIX:
                continue
            path = os.path.join(root, name)
            if not os.path.isfile(path):
                continue
            try:
                mtime = os.stat(path).st_mtime
            except OSError:
                continue
            if older_than_unix_ts is not None and mtime > older_than_unix_ts:
                continue
            out.append((name, mtime))
            if len(out) >= limit:
                break
        return out


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

    # ── B-F internal-store interface ──────────────────────────────────
    # Pre-blur internal store. Lives under a `pre_blur/` prefix in the
    # SAME bucket. The bucket-level policy does NOT have any public
    # readability on this prefix; even the existing `media.url` public
    # routes don't resolve here — these bytes never leave the
    # server-internal sphere.

    def save_internal(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        """Persist `data` under `pre_blur/<key>` in S3. Returns the
        relative key for later read/delete."""
        s3_key = f"{_PRE_BLUR_PREFIX}/{key}"
        self.s3.put_object(
            Bucket=self.bucket,
            Key=s3_key,
            Body=data,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
        return key

    def read_internal(self, key: str) -> bytes:
        """Read back bytes from `pre_blur/<key>`. Raises on 404."""
        s3_key = f"{_PRE_BLUR_PREFIX}/{key}"
        resp = self.s3.get_object(Bucket=self.bucket, Key=s3_key)
        return resp["Body"].read()

    def delete_internal(self, key: str) -> bool:
        """Remove `pre_blur/<key>`. Idempotent."""
        s3_key = f"{_PRE_BLUR_PREFIX}/{key}"
        try:
            self.s3.delete_object(Bucket=self.bucket, Key=s3_key)
            return True
        except Exception as exc:
            logger.warning(f"S3 delete_internal failed for {s3_key}: {exc}")
            return False

    # ── R3.b — disk-orphan reconciliation surface (S3) ────────────
    def list_keys(
        self, *, prefix: str = "", older_than_unix_ts: float | None = None,
        limit: int = 1000,
    ) -> list[tuple[str, float]]:
        """List up to ``limit`` (key, mtime_unix) entries in the bucket
        under the given prefix.

        Paginates via list_objects_v2 ContinuationToken; honours the
        prefix-skip-pre_blur convention for empty-prefix scans.
        """
        out: list[tuple[str, float]] = []
        kwargs = {"Bucket": self.bucket, "MaxKeys": min(1000, max(1, limit))}
        if prefix:
            kwargs["Prefix"] = prefix
        continuation = None
        while True:
            if continuation:
                kwargs["ContinuationToken"] = continuation
            try:
                resp = self.s3.list_objects_v2(**kwargs)
            except Exception as exc:
                logger.warning(f"S3 list_objects_v2 failed (prefix={prefix!r}): {exc}")
                return out
            for obj in resp.get("Contents", []):
                key = obj["Key"]
                # Skip the pre_blur namespace from an empty-prefix scan
                # so the daemon's public-storage GC doesn't see internal
                # bytes.
                if not prefix and key.startswith(f"{_PRE_BLUR_PREFIX}/"):
                    continue
                last_modified = obj.get("LastModified")
                if last_modified is None:
                    continue
                mtime = last_modified.timestamp()
                if older_than_unix_ts is not None and mtime > older_than_unix_ts:
                    continue
                out.append((key, mtime))
                if len(out) >= limit:
                    return out
            if not resp.get("IsTruncated"):
                break
            continuation = resp.get("NextContinuationToken")
            if not continuation:
                break
        return out


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
