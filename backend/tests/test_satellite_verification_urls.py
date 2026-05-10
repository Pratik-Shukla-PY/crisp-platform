"""
Phase A.1 (May 2026, satellite-verification rebuild) — stable URL tests.

Background — the dashboard previously broke on PROD whenever
MEDIA_BACKEND=s3, because the backend's `VerificationResponse` returned
fresh presigned `https://s3.../...?X-Amz-Signature=...` URLs and the
dashboard hard-coded `${BACKEND_HOST}${v.satellite_image_url}` at 11
render sites — producing `https://undp/.../https://s3.../...` → 404.

Phase 1 fixed the same pathology for media URLs by emitting stable
`/api/v1/reports/media/<id>/<file|thumb>` paths. This module pins the
same contract for satellite imagery:

  • `satellite_image_url` (s3://...) → `/api/v1/reports/<rid>/satellite/primary`
  • `satellite_image_url_alt`        → `.../satellite/alt`
  • `satellite_images[idx].url`      → `.../satellite/grid/<idx>`

And tests the redirect endpoints behind those URLs (302 with 1h cache).
"""
from __future__ import annotations

import json
import uuid
import pytest

from app.models.report import (
    Device, Report, SatelliteVerification, SeverityEnum, InfraTypeEnum,
    ReportStatusEnum, SyncStatusEnum,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_report(db, report_id: str | None = None) -> Report:
    """Insert a Report with an attached Device.

    A Device row is required because ReportResponse.device_id is non-
    Optional — any test that hits GET /api/v1/reports/ would otherwise
    blow up with ResponseValidationError. We're not testing /reports/
    here but other tests in the same session might."""
    rid = report_id or f"rep-{uuid.uuid4().hex[:8]}"
    did = f"dev-{rid}"[:36]
    if db.query(Device).filter(Device.id == did).first() is None:
        db.add(Device(id=did, device_hash=f"hash-{rid}"[:255], platform="test"))
        db.flush()
    if db.query(Report).filter(Report.id == rid).first() is None:
        db.add(Report(
            id=rid,
            source="APP",
            status=ReportStatusEnum.PENDING,
            sync_status=SyncStatusEnum.SYNCED,
            severity=SeverityEnum.UNKNOWN,
            infrastructure_type=InfraTypeEnum.OTHER,
            is_auto_submitted=False,
            expected_media=0,
            received_media=0,
            device_id=did,
        ))
        db.flush()
    db.commit()
    return db.query(Report).filter(Report.id == rid).one()


def _make_verification(
    db,
    report_id: str,
    *,
    primary_url: str | None = "/static/sat_primary.png",
    alt_url: str | None = None,
    grid_entries: list[dict] | None = None,
) -> SatelliteVerification:
    """Insert a SatelliteVerification row with the supplied URLs."""
    existing = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()
    if existing:
        db.delete(existing)
        db.flush()
    v = SatelliteVerification(
        id=f"ver-{uuid.uuid4().hex[:8]}",
        report_id=report_id,
        total_score=70,
        verdict="LIKELY_AUTHENTIC",
        satellite_image_url=primary_url,
        satellite_image_url_alt=alt_url,
        satellite_images_json=json.dumps(grid_entries) if grid_entries else None,
    )
    db.add(v)
    db.commit()
    return v


def _serialize_verification(v):
    """Run the Pydantic v2 JSON-mode serializer."""
    from app.schemas.report import VerificationResponse
    return VerificationResponse.model_validate(v).model_dump(mode="json")


# ── schema serializer tests (no HTTP) ────────────────────────────────────────

class TestVerificationSchemaStableURLs:
    """The serializer must rewrite `s3://...` for primary/alt/grid fields."""

    def test_s3_primary_url_rewrites_to_satellite_primary_route(self, db):
        r = _make_report(db)
        v = _make_verification(db, r.id, primary_url="s3://sat_xyz.png")

        out = _serialize_verification(v)
        assert out["satellite_image_url"] == f"/api/v1/reports/{r.id}/satellite/primary"
        assert "X-Amz-Signature" not in (out["satellite_image_url"] or "")

    def test_s3_alt_url_rewrites_to_satellite_alt_route(self, db):
        r = _make_report(db)
        v = _make_verification(
            db, r.id,
            primary_url="s3://sat_xyz.png",
            alt_url="s3://sat_alt_xyz.png",
        )

        out = _serialize_verification(v)
        assert out["satellite_image_url_alt"] == f"/api/v1/reports/{r.id}/satellite/alt"

    def test_s3_grid_entries_rewrite_to_satellite_grid_routes(self, db):
        r = _make_report(db)
        grid = [
            {"url": "s3://sat_0.png", "source": "AWS Sentinel-2"},
            {"url": "s3://sat_1.png", "source": "Microsoft Planetary Computer"},
            {"url": "s3://sat_2.png", "source": "ESA Copernicus"},
            {"url": "s3://sat_3.png", "source": "Mapbox"},
        ]
        v = _make_verification(db, r.id, grid_entries=grid)

        out = _serialize_verification(v)
        assert len(out["satellite_images"]) == 4
        for i, entry in enumerate(out["satellite_images"]):
            assert entry["url"] == f"/api/v1/reports/{r.id}/satellite/grid/{i}"
            # Source label preserved.
            assert entry["source"] is not None

    def test_static_paths_pass_through_unchanged(self, db):
        """Local backend stores `/static/...` in the URL columns — the
        dashboard already handles those via getMediaUrl()."""
        r = _make_report(db)
        v = _make_verification(
            db, r.id,
            primary_url="/static/sat_xyz.png",
            alt_url="/static/sat_alt.png",
        )

        out = _serialize_verification(v)
        assert out["satellite_image_url"] == "/static/sat_xyz.png"
        assert out["satellite_image_url_alt"] == "/static/sat_alt.png"

    def test_external_https_passes_through_unchanged(self, db):
        """External provider URLs (e.g. legacy direct fetches) shouldn't
        be rewritten."""
        r = _make_report(db)
        v = _make_verification(
            db, r.id,
            primary_url="https://example.com/sat.png",
        )

        out = _serialize_verification(v)
        assert out["satellite_image_url"] == "https://example.com/sat.png"

    def test_distinct_polls_emit_identical_urls(self, db):
        """The whole point of the stable-URL contract — same data, same
        URL across polls. No more X-Amz-Signature churn. Browser cache
        reuses the bytes; redirect endpoint hit ≤ once per hour per
        image."""
        from app.schemas.report import VerificationResponse
        r = _make_report(db)
        v = _make_verification(db, r.id, primary_url="s3://sat_stable.png")
        a = VerificationResponse.model_validate(v).model_dump(mode="json")
        b = VerificationResponse.model_validate(v).model_dump(mode="json")
        assert a["satellite_image_url"] == b["satellite_image_url"]


# ── redirect endpoint tests (HTTP) ───────────────────────────────────────────

class TestSatelliteRedirectEndpoints:
    """The `/satellite/<slot>` endpoints 302-redirect with 1h cache headers."""

    def test_primary_route_redirects_with_cache_control(self, client, db):
        r = _make_report(db)
        _make_verification(db, r.id, primary_url="/static/sat_primary.png")

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/primary",
            follow_redirects=False,
        )
        assert res.status_code == 302, res.text
        assert res.headers["location"] == "/static/sat_primary.png"
        cache_control = res.headers.get("cache-control", "")
        assert "public" in cache_control
        assert "max-age=3600" in cache_control

    def test_alt_route_redirects_to_alt_url(self, client, db):
        r = _make_report(db)
        _make_verification(
            db, r.id,
            primary_url="/static/sat_primary.png",
            alt_url="/static/sat_alt.png",
        )

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/alt",
            follow_redirects=False,
        )
        assert res.status_code == 302, res.text
        assert res.headers["location"] == "/static/sat_alt.png"

    def test_grid_route_redirects_to_indexed_entry(self, client, db):
        r = _make_report(db)
        _make_verification(db, r.id, grid_entries=[
            {"url": "/static/sat_0.png", "source": "AWS"},
            {"url": "/static/sat_1.png", "source": "Microsoft"},
        ])

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/grid/0",
            follow_redirects=False,
        )
        assert res.status_code == 302
        assert res.headers["location"] == "/static/sat_0.png"

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/grid/1",
            follow_redirects=False,
        )
        assert res.status_code == 302
        assert res.headers["location"] == "/static/sat_1.png"

    def test_unknown_report_id_returns_404(self, client):
        res = client.get(
            "/api/v1/reports/does-not-exist/satellite/primary",
            follow_redirects=False,
        )
        assert res.status_code == 404
        assert "verification" in res.json()["detail"].lower()

    def test_grid_index_out_of_range_returns_404(self, client, db):
        r = _make_report(db)
        _make_verification(db, r.id, grid_entries=[
            {"url": "/static/sat_0.png", "source": "AWS"},
        ])

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/grid/5",
            follow_redirects=False,
        )
        assert res.status_code == 404

    def test_missing_url_field_returns_404(self, client, db):
        """If the verification row exists but the slot is empty (e.g. alt
        was never saved), 404 cleanly rather than redirect to garbage."""
        r = _make_report(db)
        _make_verification(db, r.id, primary_url="/static/sat_primary.png", alt_url=None)

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/alt",
            follow_redirects=False,
        )
        assert res.status_code == 404

    def test_endpoint_does_not_require_auth(self, client, db):
        """Matches the existing presigned-URL trust model — anyone with
        the report_id (a UUID) can fetch. Necessary because <img src>
        elements don't send Authorization headers."""
        r = _make_report(db)
        _make_verification(db, r.id, primary_url="/static/sat_primary.png")

        res = client.get(
            f"/api/v1/reports/{r.id}/satellite/primary",
            follow_redirects=False,
            headers={},  # explicit empty
        )
        assert res.status_code == 302, res.text
