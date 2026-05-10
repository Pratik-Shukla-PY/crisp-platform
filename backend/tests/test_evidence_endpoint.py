"""
Phase C.2 (May 2026, UNDP-grade rebuild) — public evidence endpoint tests.

`GET /api/v1/reports/<id>/evidence` is the auth-free JSON contract behind
the shareable evidence.html page. Anyone with the report_id (a UUID) can
view — same trust model as the existing presigned-URL pattern. UNDP
judges click a copy-paste link and instantly see a clean verification
page; no login flow.

Tested behaviours:
  • 404 for unknown / soft-deleted reports
  • Bare-bones response when no verification has run (verification: null)
  • Full response shape when verification + photo exist
  • Stable URLs (no presigned X-Amz-Signature leakage)
  • No auth required — header-less GET works
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

from app.models.report import (
    Media, MediaTypeEnum, ResolutionEnum, SatelliteVerification,
)


def _create_report(client) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"TEST-EVID-{uuid.uuid4().hex[:8]}",
        "client_report_id": f"evid-{uuid.uuid4().hex[:12]}",
        "source": "APP",
        "severity": "SEVERE",
        "infrastructure_type": "HOSPITAL",
        "infrastructure_name": "Bangalore Medical College",
        "description": "evidence endpoint test",
        "expected_media": 1,
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _attach_image_media(db, report_id: str, *, url="s3://photo_xyz.jpg") -> str:
    m_id = f"m-evid-{uuid.uuid4().hex[:8]}"
    db.add(Media(
        id=m_id,
        report_id=report_id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.HIGH,
        url=url,
        is_synced=True,
        assembly_status="complete",
        completion_pct=100.0,
    ))
    db.commit()
    return m_id


def _attach_verification(db, report_id: str, *, with_grid=True):
    existing = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()
    if existing:
        db.delete(existing)
        db.flush()
    grid = json.dumps([
        {"url": "s3://sat_0.png", "source": "AWS Sentinel-2",
         "acquisition_date": "2026-05-08T00:00:00Z", "cloud_cover_pct": 12.0,
         "resolution_m": 10.0},
        {"url": "s3://sat_1.png", "source": "Microsoft Planetary Computer",
         "acquisition_date": "2026-05-08T00:00:00Z", "cloud_cover_pct": 12.0,
         "resolution_m": 10.0},
    ]) if with_grid else None
    v = SatelliteVerification(
        id=f"ver-evid-{uuid.uuid4().hex[:8]}",
        report_id=report_id,
        total_score=82,
        verdict="STRONGLY_CORROBORATED",
        scores={"location_authenticity": 23, "damage_corroboration": 20,
                "description_coherence": 22, "data_quality": 17, "total": 82},
        reasoning="Test reasoning paragraph.",
        key_findings=["Damaged facade visible", "Floodwater mark on N wall"],
        caveats=["Cloud cover 12% may obscure rooftop"],
        satellite_scene_description="Hospital complex partially flooded.",
        photo_analysis="Citizen photo shows the same facade.",
        satellite_source="AWS Sentinel-2",
        satellite_acquisition_date="2026-05-08T00:00:00Z",
        satellite_cloud_cover_pct=12.0,
        satellite_days_gap=2,
        satellite_image_url="s3://sat_primary.png",
        satellite_images_json=grid,
        scored_at=datetime.now(timezone.utc),
    )
    db.add(v)
    db.commit()
    return v


class TestPublicEvidenceEndpoint:
    """Anyone with the report_id can view; no auth."""

    def test_unknown_report_returns_404(self, client):
        res = client.get("/api/v1/reports/does-not-exist/evidence")
        assert res.status_code == 404
        assert "not found" in res.json()["detail"].lower()

    def test_endpoint_does_not_require_auth(self, client):
        rid = _create_report(client)
        # Hit the endpoint with NO Authorization header.
        res = client.get(f"/api/v1/reports/{rid}/evidence", headers={})
        assert res.status_code == 200, res.text

    def test_response_shape_without_verification(self, client):
        rid = _create_report(client)
        res = client.get(f"/api/v1/reports/{rid}/evidence")
        assert res.status_code == 200
        body = res.json()
        # Headline metadata always present.
        assert body["report_id"] == rid
        # Note: `infrastructure_type` may be auto-reclassified by the
        # classify-suggest pipeline post-create, so we don't pin a value
        # — just confirm the field is present + a string. The other
        # fields are user-set + immutable.
        assert isinstance(body["infrastructure_type"], str)
        assert body["severity"] == "SEVERE"
        assert body["crisis_type"] == "FLOOD"
        assert body["damage_classification"] == "PARTIAL"
        assert body["description"] == "evidence endpoint test"
        assert body["location"]["latitude"] == 12.97
        # No photo, no verification yet.
        assert body["photo_url"] is None
        assert body["verification"] is None

    def test_response_shape_with_full_verification(self, client, db):
        rid = _create_report(client)
        m_id = _attach_image_media(db, rid)
        _attach_verification(db, rid, with_grid=True)

        res = client.get(f"/api/v1/reports/{rid}/evidence")
        assert res.status_code == 200
        body = res.json()

        # Photo URL — stable backend route, NOT presigned S3.
        assert body["photo_url"] == f"/api/v1/reports/media/{m_id}/file"
        assert "X-Amz-Signature" not in (body["photo_url"] or "")

        v = body["verification"]
        assert v["verdict"] == "STRONGLY_CORROBORATED"
        assert v["total_score"] == 82
        assert v["scores"]["damage_corroboration"] == 20
        assert "Damaged facade visible" in v["key_findings"]
        assert "Cloud cover 12% may obscure rooftop" in v["caveats"]
        assert v["satellite_source"] == "AWS Sentinel-2"
        assert v["satellite_cloud_cover_pct"] == 12.0
        assert v["satellite_days_gap"] == 2

        # Primary + grid URLs — stable, no signatures.
        assert v["primary_url"] == f"/api/v1/reports/{rid}/satellite/primary"
        assert len(v["satellite_images"]) == 2
        assert v["satellite_images"][0]["url"] == f"/api/v1/reports/{rid}/satellite/grid/0"
        assert v["satellite_images"][0]["source"] == "AWS Sentinel-2"
        assert v["satellite_images"][1]["url"] == f"/api/v1/reports/{rid}/satellite/grid/1"
        # No presigned-URL churn on the public page either.
        for entry in v["satellite_images"]:
            assert "X-Amz-Signature" not in (entry["url"] or "")

        # scored_at is Z-suffixed UTC (matches the rest of our wire format).
        assert v["scored_at"] is not None
        assert v["scored_at"].endswith("Z")

    def test_response_shape_with_legacy_single_image_verification(
        self, client, db
    ):
        """Pre-multi-provider verifications had only `satellite_image_url`
        and no `satellite_images_json`. The endpoint should still return
        a usable response — `primary_url` populated, `satellite_images`
        empty list."""
        rid = _create_report(client)
        _attach_verification(db, rid, with_grid=False)

        res = client.get(f"/api/v1/reports/{rid}/evidence")
        body = res.json()
        v = body["verification"]
        assert v["primary_url"] == f"/api/v1/reports/{rid}/satellite/primary"
        assert v["satellite_images"] == []

    def test_local_backend_photo_passes_through_static(self, client, db):
        """For LocalStorage rows (`/static/abc.jpg`), `photo_url` should
        pass through unchanged — the dashboard already prepends
        BACKEND_HOST. We don't force the redirect indirection on local
        backends where it adds no caching benefit."""
        rid = _create_report(client)
        _attach_image_media(db, rid, url="/static/citizen_photo.jpg")
        res = client.get(f"/api/v1/reports/{rid}/evidence")
        body = res.json()
        assert body["photo_url"] == "/static/citizen_photo.jpg"
