"""
GET /api/v1/reports/{report_id}/verification — satellite truth-verification
read path.

Covers:
  * 404 when the report (or its verification row) does not exist
  * Seeded-record happy path through the VerificationResponse schema
  * Auth posture — the read endpoint is *public* today (no Depends
    on require_viewer), matching the pattern used for the public
    submit/undo-delete endpoints. This test pins that choice so an
    accidental add-a-Depends refactor would fail CI.

The companion POST /verify endpoint is NOT exercised here — it calls
Sentinel-Hub + Claude multimodal, both of which are network-heavy and
covered by dedicated integration tests.
"""
import uuid
import pytest

from tests.conftest import auth_header
from app.models.report import SatelliteVerification


class TestSatelliteVerificationRead:

    def test_verification_returns_404_for_nonexistent_report(self, client):
        """A random UUID that matches no row → 404 with the expected
        detail string."""
        bogus_id = str(uuid.uuid4())
        res = client.get(f"/api/v1/reports/{bogus_id}/verification")
        assert res.status_code == 404
        assert res.json()["detail"] == "No verification result yet"

    def test_verification_returns_empty_when_none_exists(
            self, client, sample_report):
        """Report exists, but no verification has been run yet. The
        handler treats "no row" as 404 rather than returning a blank
        object — same shape as (1). This pins the current behaviour.
        If the product ever decides to return a null-ish 200 stub
        instead, this test locks in the change."""
        res = client.get(
            f"/api/v1/reports/{sample_report['id']}/verification")
        assert res.status_code == 404
        assert res.json()["detail"] == "No verification result yet"

    def test_verification_returns_seeded_record(
            self, client, db, sample_report):
        """Insert a SatelliteVerification row directly via the ORM and
        assert the endpoint serialises every field of interest."""
        v = SatelliteVerification(
            report_id=sample_report["id"],
            total_score=82,
            verdict="LIKELY_AUTHENTIC",
            scores={
                "location_authenticity": 90,
                "damage_corroboration": 75,
                "temporal_consistency": 80,
            },
            reasoning="Strong match between user photo and Sentinel-2 tile.",
            key_findings=["Road damage visible in sat imagery",
                          "Cloud cover below 10%"],
            caveats=["Satellite resolution is 10m/pixel"],
            satellite_scene_description="Semi-urban area, visible debris.",
            photo_analysis="User photo shows road collapse; lighting natural.",
            satellite_source="Sentinel-2",
            satellite_acquisition_date="2026-04-18",
            satellite_cloud_cover_pct=8.5,
            satellite_resolution_m=10.0,
            satellite_days_gap=-2,
            satellite_image_url="/static/sat_test_report.png",
            satellite_image_url_alt=None,
        )
        db.add(v)
        db.commit()
        # Cross-session visibility: the API uses a different session
        # than the test's `db` fixture. Commit above is enough for
        # Postgres readers outside this transaction.

        res = client.get(
            f"/api/v1/reports/{sample_report['id']}/verification")
        assert res.status_code == 200, res.text
        body = res.json()

        assert body["report_id"] == sample_report["id"]
        assert body["total_score"] == 82
        assert body["verdict"] == "LIKELY_AUTHENTIC"
        assert body["scores"]["location_authenticity"] == 90
        assert body["scores"]["damage_corroboration"] == 75
        assert "Road damage visible in sat imagery" in body["key_findings"]
        assert body["satellite_source"] == "Sentinel-2"
        assert body["satellite_acquisition_date"] == "2026-04-18"
        assert body["satellite_cloud_cover_pct"] == pytest.approx(8.5)
        assert body["satellite_resolution_m"] == pytest.approx(10.0)
        assert body["satellite_days_gap"] == -2
        assert body["satellite_image_url"] == "/static/sat_test_report.png"
        assert body["reasoning"].startswith("Strong match")

    def test_verification_respects_auth(
            self, client, db, sample_report, viewer_token):
        """Pins today's public-read posture of the verification
        endpoint. Neither unauthenticated nor viewer-token requests
        should be rejected — the handler has no `Depends(require_*)`.
        A future restriction (PR-gated) would fail this test and
        force a conscious choice."""
        # Unauth → 404 because we haven't seeded the row yet. The
        # important assertion is that the response is NOT 401/403,
        # which is what an auth requirement would produce.
        res_unauth = client.get(
            f"/api/v1/reports/{sample_report['id']}/verification")
        assert res_unauth.status_code != 401
        assert res_unauth.status_code != 403

        # Seed a row and re-query with a viewer token. Must be 200.
        v = SatelliteVerification(
            report_id=sample_report["id"],
            total_score=55, verdict="INCONCLUSIVE",
            scores={"location_authenticity": 50},
        )
        db.add(v)
        db.commit()

        res_viewer = client.get(
            f"/api/v1/reports/{sample_report['id']}/verification",
            headers=auth_header(viewer_token),
        )
        assert res_viewer.status_code == 200, res_viewer.text
        assert res_viewer.json()["verdict"] == "INCONCLUSIVE"
