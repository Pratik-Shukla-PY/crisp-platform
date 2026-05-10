"""
Tests for the stable media-URL endpoint (May 2026 HAR-driven rewrite).

The endpoint `/api/v1/reports/media/<id>/<file|thumb>` is what
MediaResponse._resolve_url now points at instead of churning presigned
S3 URLs every poll. A 302 redirect to the freshly-presigned target,
with `Cache-Control: public, max-age=3600` so even cold caches only
hit the backend ~once per image per hour.

This module tests:
  • 200/302 return shape (status + redirect target)
  • Cache-Control header is set
  • /file vs /thumb path disambiguation
  • Missing media → 404
  • Missing url field → 404 (not 500)
  • Unguessable-id auth model: no Bearer needed
  • Local-disk pass-through (MEDIA_BACKEND=local) doesn't break
"""
from __future__ import annotations

import pytest

from app.models.report import (
    Device, Media, MediaTypeEnum, ResolutionEnum, Report, SeverityEnum,
    InfraTypeEnum, ReportStatusEnum, SyncStatusEnum,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_parent_report(db, report_id: str = "redir-parent-1"):
    """Reports.media has a NOT NULL FK to reports.id — every Media row
    needs a parent. Use a stable ID per test to avoid cross-test pollution.

    A Device row is also created — `ReportResponse.device_id` is non-Optional,
    so any test running AFTER this one that hits GET /api/v1/reports/ would
    otherwise blow up with a ResponseValidationError if our row leaks through."""
    r = db.query(Report).filter(Report.id == report_id).first()
    if r is None:
        # Device first — Report.device_id is the FK target.
        device_id = f"dev-{report_id}"[:36]
        d = db.query(Device).filter(Device.id == device_id).first()
        if d is None:
            d = Device(
                id=device_id,
                device_hash=f"hash-{report_id}"[:255],
                platform="test",
            )
            db.add(d)
            db.flush()
        r = Report(
            id=report_id,
            source="APP",
            status=ReportStatusEnum.PENDING,
            sync_status=SyncStatusEnum.SYNCED,
            severity=SeverityEnum.UNKNOWN,
            infrastructure_type=InfraTypeEnum.OTHER,
            is_auto_submitted=False,
            expected_media=1,
            received_media=1,
            device_id=device_id,
        )
        db.add(r)
        db.flush()
    return r


def _make_media(db, media_id: str, url: str, thumbnail_url: str | None = None,
                report_id: str = "redir-parent-1"):
    _make_parent_report(db, report_id)
    m = db.query(Media).filter(Media.id == media_id).first()
    if m:
        db.delete(m)
        db.flush()
    m = Media(
        id=media_id,
        report_id=report_id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.MEDIUM,
        url=url,
        thumbnail_url=thumbnail_url,
        is_synced=True,
        assembly_status="complete",
        completion_pct=100.0,
    )
    db.add(m)
    db.commit()
    return m


# ── tests ────────────────────────────────────────────────────────────────────

class TestMediaRedirectEndpoint:
    """The /media/<id>/<file|thumb> endpoint resolves stable URLs to S3."""

    def test_file_route_redirects_with_cache_control(self, client, db):
        # Local backend — `public_url` returns the path verbatim, but the
        # 302 + Cache-Control still applies.
        _make_media(db, "redir-test-001", url="/static/img-final.jpg")

        # follow_redirects=False so we observe the 302 itself, not the body.
        res = client.get("/api/v1/reports/media/redir-test-001/file",
                          follow_redirects=False)
        assert res.status_code == 302, res.text
        assert res.headers["location"] == "/static/img-final.jpg"
        # Critical for the HAR fix: the redirect must be cacheable.
        cache_control = res.headers.get("cache-control", "")
        assert "public" in cache_control
        assert "max-age=3600" in cache_control

    def test_thumb_route_redirects_to_thumbnail_url(self, client, db):
        """/thumb uses thumbnail_url, NOT url. This is the audio-during-
        upload case where `url=""` and the partial bytes live under
        thumbnail_url until the final chunk lands."""
        _make_media(
            db, "redir-test-002",
            url="/static/full.jpg",
            thumbnail_url="/static/thumb-only.jpg",
        )

        res = client.get("/api/v1/reports/media/redir-test-002/thumb",
                          follow_redirects=False)
        assert res.status_code == 302, res.text
        assert res.headers["location"] == "/static/thumb-only.jpg"

    def test_thumb_route_falls_back_to_url_when_no_thumbnail(self, client, db):
        """If thumbnail_url is None but url exists, /thumb still serves
        SOMETHING — better than 404'ing on a placeholder request. This
        matches the dashboard's old "if thumb fails, try main" fallback
        and keeps progressive rendering working."""
        _make_media(
            db, "redir-test-003",
            url="/static/main.jpg",
            thumbnail_url=None,
        )

        res = client.get("/api/v1/reports/media/redir-test-003/thumb",
                          follow_redirects=False)
        # Falls back to url because thumbnail_url is missing.
        assert res.status_code == 302, res.text
        assert res.headers["location"] == "/static/main.jpg"

    def test_unknown_media_id_returns_404(self, client):
        res = client.get("/api/v1/reports/media/does-not-exist/file",
                          follow_redirects=False)
        assert res.status_code == 404
        assert "not found" in res.json()["detail"].lower()

    def test_media_with_no_url_or_thumbnail_returns_404(self, client, db):
        """A meta-only row (no chunks landed yet, no thumbnail attached)
        has url="" and thumbnail_url=None. Hitting /file or /thumb on
        that should 404 cleanly, not 500."""
        _make_media(db, "redir-test-004", url="", thumbnail_url=None)

        for suffix in ("file", "thumb"):
            res = client.get(f"/api/v1/reports/media/redir-test-004/{suffix}",
                              follow_redirects=False)
            assert res.status_code == 404, (suffix, res.text)

    def test_endpoint_does_not_require_auth(self, client, db):
        """Matches the previous behaviour (presigned URLs were embedded
        directly in API responses → anyone holding the URL could fetch
        without auth). Unguessable UUIDs serve as the access control.

        This also unblocks plain `<img src>` rendering — image elements
        don't send Authorization headers."""
        _make_media(db, "redir-test-005", url="/static/x.jpg")

        # Pass NO Authorization header.
        res = client.get("/api/v1/reports/media/redir-test-005/file",
                          follow_redirects=False,
                          headers={})  # explicit empty
        assert res.status_code == 302, res.text

    def test_distinct_polls_emit_identical_urls(self, client, db):
        """The whole point of the HAR-driven rewrite — the URL on poll N
        and poll N+1 must be identical so the browser cache treats them
        as the same resource. No more 49 unique X-Amz-Signatures across
        98 fetches.

        We don't hit the redirect endpoint here — we re-serialize the
        MediaResponse twice and compare. That's the contract that drives
        the dashboard's cache-hit behaviour."""
        from app.schemas.report import MediaResponse

        _make_media(db, "redir-test-006", url="s3://stable.jpg",
                    thumbnail_url="s3://stable_t.jpg")
        m = db.query(Media).filter(Media.id == "redir-test-006").first()

        a = MediaResponse.model_validate(m).model_dump(mode="json")
        b = MediaResponse.model_validate(m).model_dump(mode="json")
        assert a["url"] == b["url"]
        assert a["thumbnail_url"] == b["thumbnail_url"]
        # And the URL points at our stable route, not S3.
        assert a["url"] == "/api/v1/reports/media/redir-test-006/file"
        assert a["thumbnail_url"] == "/api/v1/reports/media/redir-test-006/thumb"
