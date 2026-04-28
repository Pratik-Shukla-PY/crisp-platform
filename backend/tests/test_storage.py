"""Tests for the media storage abstraction (LocalStorage + S3Storage).

We use moto to mock S3 so the suite never makes real AWS calls. Every
test resets the storage singleton so MEDIA_BACKEND env changes between
tests are honoured.
"""
from __future__ import annotations

import os
import shutil
import tempfile

import pytest

from app.services import storage as storage_module


@pytest.fixture(autouse=True)
def _reset_storage_singleton():
    """Discard the cached storage between tests so env changes apply."""
    storage_module.reset_storage_for_tests()
    yield
    storage_module.reset_storage_for_tests()


@pytest.fixture
def upload_dir():
    """Fresh upload dir per test, wiped on teardown."""
    d = tempfile.mkdtemp(prefix="crisp-storage-test-")
    yield d
    shutil.rmtree(d, ignore_errors=True)


# ── LocalStorage ───────────────────────────────────────────────────────────

class TestLocalStorage:
    def test_save_writes_to_upload_dir_and_returns_static_url(self, upload_dir):
        s = storage_module.LocalStorage(upload_dir=upload_dir)
        url = s.save("photo.jpg", b"\xff\xd8\xff\xe0fakejpg", "image/jpeg")
        assert url == "/static/photo.jpg"
        assert os.path.exists(os.path.join(upload_dir, "photo.jpg"))

    def test_read_returns_bytes_for_static_url(self, upload_dir):
        s = storage_module.LocalStorage(upload_dir=upload_dir)
        s.save("a.bin", b"hello", "application/octet-stream")
        assert s.read("/static/a.bin") == b"hello"

    def test_read_raises_for_s3_url(self, upload_dir):
        s = storage_module.LocalStorage(upload_dir=upload_dir)
        with pytest.raises(FileNotFoundError):
            s.read("s3://media/foo.jpg")

    def test_delete_returns_true_on_existing_false_on_missing(self, upload_dir):
        s = storage_module.LocalStorage(upload_dir=upload_dir)
        s.save("x.bin", b"data", "application/octet-stream")
        assert s.delete("/static/x.bin") is True
        assert s.delete("/static/x.bin") is False  # idempotent

    def test_public_url_pass_through(self, upload_dir):
        s = storage_module.LocalStorage(upload_dir=upload_dir)
        assert s.public_url("/static/photo.jpg") == "/static/photo.jpg"


# ── S3Storage (moto-mocked) ────────────────────────────────────────────────

@pytest.fixture
def s3_bucket(monkeypatch):
    """Create a moto-mocked S3 bucket and return its name."""
    pytest.importorskip("moto")
    # moto v5 unified API
    try:
        from moto import mock_aws  # type: ignore
    except ImportError:
        pytest.skip("moto not installed")
    import boto3

    bucket_name = "crisp-test-bucket"
    region = "ap-south-1"
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", region)

    with mock_aws():
        s3 = boto3.client("s3", region_name=region)
        s3.create_bucket(
            Bucket=bucket_name,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
        yield (bucket_name, region)


class TestS3Storage:
    def test_save_puts_object_and_returns_s3_url(self, s3_bucket, upload_dir):
        bucket, region = s3_bucket
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        url = s.save("foo.jpg", b"jpg-bytes", "image/jpeg")
        assert url == "s3://foo.jpg"
        # And the object is actually in S3.
        import boto3
        client = boto3.client("s3", region_name=region)
        body = client.get_object(Bucket=bucket, Key="foo.jpg")["Body"].read()
        assert body == b"jpg-bytes"

    def test_read_returns_bytes_for_s3_url(self, s3_bucket, upload_dir):
        bucket, region = s3_bucket
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        s.save("hello.bin", b"world", "application/octet-stream")
        assert s.read("s3://hello.bin") == b"world"

    def test_read_falls_back_to_local_for_legacy_static_url(self, s3_bucket, upload_dir):
        """Migration window: a row still has /static/foo.jpg but the file
        is on local disk because the migration script hasn't run yet.
        S3Storage should read it from local disk to keep the dashboard
        functional."""
        bucket, region = s3_bucket
        # Write a legacy file on local disk only (NOT in S3).
        with open(os.path.join(upload_dir, "legacy.jpg"), "wb") as f:
            f.write(b"legacy-bytes")
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        assert s.read("/static/legacy.jpg") == b"legacy-bytes"

    def test_delete_removes_from_s3(self, s3_bucket, upload_dir):
        bucket, region = s3_bucket
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        s.save("trash.bin", b"to-delete", "application/octet-stream")
        assert s.delete("s3://trash.bin") is True
        # GetObject should now 404.
        from botocore.exceptions import ClientError
        import boto3
        client = boto3.client("s3", region_name=region)
        with pytest.raises(ClientError):
            client.get_object(Bucket=bucket, Key="trash.bin")

    def test_public_url_returns_signed_https_url(self, s3_bucket, upload_dir):
        bucket, region = s3_bucket
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        s.save("preview.jpg", b"img", "image/jpeg")
        signed = s.public_url("s3://preview.jpg")
        assert signed.startswith("https://")
        assert "preview.jpg" in signed
        # Presigned URL must include the signature query params.
        assert "X-Amz-Signature" in signed or "Signature" in signed

    def test_public_url_passes_through_legacy_static(self, s3_bucket, upload_dir):
        """During migration, a row may still have /static/. We pass it
        through unchanged so nginx serves it."""
        bucket, region = s3_bucket
        s = storage_module.S3Storage(bucket=bucket, region=region, upload_dir_for_legacy_reads=upload_dir)
        assert s.public_url("/static/legacy.jpg") == "/static/legacy.jpg"


# ── get_storage selection logic ────────────────────────────────────────────

class TestGetStorage:
    def test_default_is_local(self, monkeypatch, upload_dir):
        monkeypatch.delenv("MEDIA_BACKEND", raising=False)
        monkeypatch.setenv("CRISP_UPLOAD_DIR", upload_dir)
        s = storage_module.get_storage()
        assert isinstance(s, storage_module.LocalStorage)

    def test_local_explicit(self, monkeypatch, upload_dir):
        monkeypatch.setenv("MEDIA_BACKEND", "local")
        monkeypatch.setenv("CRISP_UPLOAD_DIR", upload_dir)
        s = storage_module.get_storage()
        assert isinstance(s, storage_module.LocalStorage)

    def test_s3_requires_bucket_and_region(self, monkeypatch):
        monkeypatch.setenv("MEDIA_BACKEND", "s3")
        monkeypatch.delenv("AWS_S3_BUCKET", raising=False)
        monkeypatch.delenv("AWS_REGION", raising=False)
        with pytest.raises(RuntimeError, match="AWS_S3_BUCKET"):
            storage_module.get_storage()

    def test_s3_backend_when_configured(self, monkeypatch, s3_bucket, upload_dir):
        bucket, region = s3_bucket
        monkeypatch.setenv("MEDIA_BACKEND", "s3")
        monkeypatch.setenv("AWS_S3_BUCKET", bucket)
        monkeypatch.setenv("AWS_REGION", region)
        monkeypatch.setenv("CRISP_UPLOAD_DIR", upload_dir)
        s = storage_module.get_storage()
        assert isinstance(s, storage_module.S3Storage)

    def test_singleton_caches_instance(self, monkeypatch, upload_dir):
        monkeypatch.setenv("MEDIA_BACKEND", "local")
        monkeypatch.setenv("CRISP_UPLOAD_DIR", upload_dir)
        s1 = storage_module.get_storage()
        s2 = storage_module.get_storage()
        assert s1 is s2  # same singleton
