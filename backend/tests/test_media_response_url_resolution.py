"""
Regression tests for MediaResponse._resolve_url field_serializer.

Background — May 2026 audio-playback bug: the serializer was registered
only for the `url` field, so partial-streaming audio (which lives under
`media.thumbnail_url`) flowed out as a raw `s3://...` string. The
dashboard's `getMediaUrl()` then prepended BACKEND_HOST and ended up
GETting `https://undp.crisplabs.tech/s3://abc.m4a` → 404. After the fix
both fields go through the same resolver.

May 2026 (HAR-driven rewrite) — the serializer no longer returns
presigned S3 URLs directly. Each poll used to generate a fresh
X-Amz-Signature on the same media bytes, defeating the browser cache
and forcing 98× refetch of identical bytes per dashboard tab. The
serializer now returns STABLE backend-routed URLs of the form
`/api/v1/reports/media/<id>/<file|thumb>`, which a separate endpoint
302-redirects to a fresh presigned URL on demand. The redirect itself
is `Cache-Control: public, max-age=3600`, so a cold cache hits the
backend at most once per image per hour.

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


def _serialize(media_dict):
    """Build a MediaResponse and dump it to a JSON-mode dict.

    Pydantic v2: when_used="json" runs only on `model_dump(mode="json")`
    or `model_dump_json()` — `model_dump()` alone keeps raw values.
    """
    from app.schemas.report import MediaResponse
    return MediaResponse.model_validate(media_dict).model_dump(mode="json")


class TestMediaResponseUrlResolution:
    """The serializer must rewrite `s3://...` for BOTH `url` and `thumbnail_url`."""

    def _row(self, url="", thumb=None, media_id="med-test-1"):
        # Minimum keys MediaResponse expects from an ORM row.
        # Note: MediaBase declares `url: str` (non-Optional) so the
        # default is "" — matching what attach_thumbnail writes for a
        # thumbnail-only row before any chunks have arrived (see
        # endpoints/reports.py line 2332).
        return {
            "id": media_id,
            "type": "AUDIO",
            "url": url,
            "thumbnail_url": thumb,
            "is_synced": True,
            "assembly_status": "complete",
            "completion_pct": 100.0,
        }

    def test_rewrites_s3_url_to_stable_backend_route(self):
        """The HAR fix: `s3://...` becomes a stable `/api/v1/reports/media/<id>/file`.

        Stable URL = same string on every poll = browser cache reuses bytes.
        No more 49 unique presigned signatures across 98 fetches.
        """
        out = _serialize(self._row(url="s3://img-final.jpg", media_id="abc-123"))
        assert out["url"] == "/api/v1/reports/media/abc-123/file"
        # No presigned-signature noise — that's the whole point.
        assert "X-Amz-Signature" not in out["url"]

    def test_rewrites_s3_thumbnail_url_to_stable_thumb_route(self):
        """thumbnail_url uses the `/thumb` suffix to disambiguate from `/file`.

        Same media row may have BOTH `url` (full) and `thumbnail_url` (partial /
        placeholder). Each gets its own stable URL.
        """
        out = _serialize(self._row(thumb="s3://aud-partial.m4a", media_id="def-456"))
        assert out["thumbnail_url"] == "/api/v1/reports/media/def-456/thumb"
        assert "X-Amz-Signature" not in out["thumbnail_url"]

    def test_rewrites_both_url_and_thumbnail_url_in_one_response(self):
        """Field-name disambiguation via SerializationInfo.field_name."""
        out = _serialize(self._row(
            url="s3://img-final.jpg",
            thumb="s3://aud-partial.m4a",
            media_id="ghi-789",
        ))
        assert out["url"] == "/api/v1/reports/media/ghi-789/file"
        assert out["thumbnail_url"] == "/api/v1/reports/media/ghi-789/thumb"
        # Distinct suffixes for the two fields.
        assert out["url"] != out["thumbnail_url"]

    def test_passes_through_legacy_static_paths_unchanged(self):
        """During the migration window a row might still hold /static/...
        Pass it through verbatim so nginx serves it."""
        out = _serialize(self._row(
            url="/static/legacy.jpg", thumb="/static/legacy_thumb.jpg",
        ))
        assert out["url"] == "/static/legacy.jpg"
        assert out["thumbnail_url"] == "/static/legacy_thumb.jpg"

    def test_passes_through_plain_https_url(self):
        """External http(s) URLs (e.g. satellite previews, externally hosted
        thumbnails) are pass-through — no rewrite, no backend round-trip."""
        out = _serialize(self._row(
            url="https://example.com/x.jpg",
            thumb="https://example.com/y.jpg",
        ))
        assert out["url"] == "https://example.com/x.jpg"
        assert out["thumbnail_url"] == "https://example.com/y.jpg"

    def test_handles_empty_url_and_none_thumbnail(self):
        """Pre-thumbnail rows from attach_thumbnail land with url="" and
        thumbnail_url=None until the first chunk lands. The serializer
        must not blow up on these falsy values, and must NOT emit a
        broken `/api/v1/reports/media//file` route."""
        out = _serialize(self._row(url="", thumb=None))
        assert out["url"] == ""
        assert out["thumbnail_url"] is None

    def test_serializer_does_not_call_storage_for_s3_rows(self, monkeypatch):
        """The whole point of the rewrite — schema serialization no longer
        triggers a presigned-URL generation. That's now deferred to the
        /media/<id>/<file|thumb> endpoint, hit only on cache miss.

        If storage.public_url() ever runs during MediaResponse serialization,
        every API poll regenerates fresh signatures and we're back to the
        98×-refetch HAR pathology. Catch any regression at CI time.
        """
        from app.services.storage import LocalStorage

        calls = {"n": 0}
        original = LocalStorage.public_url

        def _track(self, db_url):
            calls["n"] += 1
            return original(self, db_url)

        monkeypatch.setattr(LocalStorage, "public_url", _track)
        # Force the local backend to be the active singleton.
        monkeypatch.setenv("MEDIA_BACKEND", "local")

        out = _serialize(self._row(url="s3://img-final.jpg", thumb="s3://t.jpg"))
        # Stable URL came back —
        assert out["url"] == "/api/v1/reports/media/med-test-1/file"
        # — and storage was NEVER asked to presign during serialization.
        assert calls["n"] == 0

    def test_data_url_passthrough(self):
        """`data:` URLs (rare inline thumbs from chunked-upload thumbnail
        endpoint) must not be rewritten — they don't reference an S3 key."""
        data_url = "data:image/jpeg;base64,/9j/4AAQ..."
        out = _serialize(self._row(thumb=data_url))
        assert out["thumbnail_url"] == data_url
