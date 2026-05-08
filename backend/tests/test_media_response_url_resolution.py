"""
Regression tests for MediaResponse._resolve_url field_serializer.

Background — May 2026 audio-playback bug: the serializer was registered
only for the `url` field, so partial-streaming audio (which lives under
`media.thumbnail_url`) flowed out as a raw `s3://...` string. The
dashboard's `getMediaUrl()` then prepended BACKEND_HOST and ended up
GETting `https://undp.crisplabs.tech/s3://abc.m4a` → 404. After the fix
both fields go through the same resolver.

These tests pin both fields down so a future refactor that drops
`thumbnail_url` from the decorator gets caught at CI time, not in
production.
"""
from __future__ import annotations

import os
import pytest

from app.services import storage as storage_module


@pytest.fixture(autouse=True)
def _reset_storage_singleton():
    storage_module.reset_storage_for_tests()
    yield
    storage_module.reset_storage_for_tests()


@pytest.fixture
def s3_backend(monkeypatch, tmp_path):
    """Spin up a moto-mocked S3 backend and point get_storage() at it."""
    pytest.importorskip("moto")
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
    monkeypatch.setenv("MEDIA_BACKEND", "s3")
    monkeypatch.setenv("AWS_S3_BUCKET", bucket_name)
    monkeypatch.setenv("AWS_REGION", region)
    monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path))

    with mock_aws():
        s3 = boto3.client("s3", region_name=region)
        s3.create_bucket(
            Bucket=bucket_name,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
        # Pre-stage a couple of objects so presigned URLs reference real keys.
        s3.put_object(Bucket=bucket_name, Key="img-final.jpg", Body=b"jpg")
        s3.put_object(Bucket=bucket_name, Key="aud-partial.m4a", Body=b"m4a")
        yield (bucket_name, region)


def _serialize(media_dict):
    """Build a MediaResponse and dump it to a JSON-mode dict.

    Pydantic v2: when_used="json" runs only on `model_dump(mode="json")`
    or `model_dump_json()` — `model_dump()` alone keeps raw values.
    """
    from app.schemas.report import MediaResponse
    return MediaResponse.model_validate(media_dict).model_dump(mode="json")


class TestMediaResponseUrlResolution:
    """The serializer must rewrite `s3://...` for BOTH `url` and `thumbnail_url`."""

    def _row(self, url="", thumb=None):
        # Minimum keys MediaResponse expects from an ORM row.
        # Note: MediaBase declares `url: str` (non-Optional) so the
        # default is "" — matching what attach_thumbnail writes for a
        # thumbnail-only row before any chunks have arrived (see
        # endpoints/reports.py line 2332).
        return {
            "id": "med-test-1",
            "type": "AUDIO",
            "url": url,
            "thumbnail_url": thumb,
            "is_synced": True,
            "assembly_status": "complete",
            "completion_pct": 100.0,
        }

    def test_resolves_s3_url_to_presigned_https(self, s3_backend):
        out = _serialize(self._row(url="s3://img-final.jpg"))
        assert out["url"].startswith("https://"), out["url"]
        assert "img-final.jpg" in out["url"]
        assert "X-Amz-Signature" in out["url"] or "Signature" in out["url"]

    def test_resolves_s3_thumbnail_url_to_presigned_https(self, s3_backend):
        """The bug we're fixing: thumbnail_url was previously raw s3://."""
        out = _serialize(self._row(thumb="s3://aud-partial.m4a"))
        assert out["thumbnail_url"].startswith("https://"), out["thumbnail_url"]
        assert "aud-partial.m4a" in out["thumbnail_url"]
        assert (
            "X-Amz-Signature" in out["thumbnail_url"]
            or "Signature" in out["thumbnail_url"]
        )

    def test_resolves_both_url_and_thumbnail_url_in_one_response(self, s3_backend):
        out = _serialize(self._row(
            url="s3://img-final.jpg", thumb="s3://aud-partial.m4a"
        ))
        assert out["url"].startswith("https://")
        assert out["thumbnail_url"].startswith("https://")
        # Distinct keys produce distinct signed URLs.
        assert out["url"] != out["thumbnail_url"]

    def test_passes_through_legacy_static_paths_unchanged(self, s3_backend):
        """During the migration window a row might still hold /static/...
        Pass it through verbatim so nginx serves it."""
        out = _serialize(self._row(
            url="/static/legacy.jpg", thumb="/static/legacy_thumb.jpg"
        ))
        assert out["url"] == "/static/legacy.jpg"
        assert out["thumbnail_url"] == "/static/legacy_thumb.jpg"

    def test_passes_through_plain_https_url(self, s3_backend):
        """External http(s) URLs (e.g. satellite previews) are pass-through."""
        out = _serialize(self._row(
            url="https://example.com/x.jpg", thumb="https://example.com/y.jpg"
        ))
        assert out["url"] == "https://example.com/x.jpg"
        assert out["thumbnail_url"] == "https://example.com/y.jpg"

    def test_handles_empty_url_and_none_thumbnail(self, s3_backend):
        """Pre-thumbnail rows from attach_thumbnail land with url="" and
        thumbnail_url=None until the first chunk lands. The serializer
        must not blow up on these falsy values."""
        out = _serialize(self._row(url="", thumb=None))
        assert out["url"] == ""
        assert out["thumbnail_url"] is None

    def test_storage_failure_falls_back_to_raw_value(self, s3_backend, monkeypatch):
        """If presigning explodes (creds revoked / bucket gone) the
        response must still serialise — the consumer can decide how to
        handle the broken URL. We never want a presign blow-up to take
        down the whole /reports response."""
        from app.services.storage import S3Storage

        def _boom(self, db_url):
            raise RuntimeError("S3 down")

        monkeypatch.setattr(S3Storage, "public_url", _boom)
        out = _serialize(self._row(
            url="s3://img-final.jpg", thumb="s3://aud-partial.m4a"
        ))
        # Falls back to the raw db value rather than 500-ing.
        assert out["url"] == "s3://img-final.jpg"
        assert out["thumbnail_url"] == "s3://aud-partial.m4a"
