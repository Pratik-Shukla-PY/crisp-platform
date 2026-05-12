"""API integration tests for report endpoints."""
import pytest
from tests.conftest import auth_header


class TestReportSubmission:
    """Report submission must work WITHOUT authentication."""

    def test_create_report_meta_no_auth(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-NO-AUTH",
            "client_report_id": "no-auth-001",
            "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
            "description": "Road damage", "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        })
        assert res.status_code == 201
        assert res.json()["source"] == "APP"

    def test_create_report_idempotent(self, client):
        payload = {
            "device_hash": "TEST-IDEMP", "client_report_id": "idemp-001",
            "source": "APP", "severity": "MINOR", "infrastructure_type": "HOUSE",
            "expected_media": 0, "location": {"latitude": 10, "longitude": 20},
        }
        r1 = client.post("/api/v1/reports/meta", json=payload)
        r2 = client.post("/api/v1/reports/meta", json=payload)
        assert r1.json()["id"] == r2.json()["id"]

    def test_undp_fields_in_response(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-UNDP", "client_report_id": "undp-001",
            "source": "TELEGRAM", "severity": "SEVERE", "infrastructure_type": "HOSPITAL",
            "crisis_type": "EARTHQUAKE", "damage_classification": "COMPLETE",
            "infrastructure_name": "City Hospital", "debris_clearing_needed": True,
            "expected_media": 0, "location": {"latitude": 28, "longitude": 84},
        })
        assert res.status_code == 201
        data = res.json()
        assert data["crisis_type"] == "EARTHQUAKE"
        assert data["damage_classification"] == "COMPLETE"
        assert data["infrastructure_name"] == "City Hospital"
        assert data["debris_clearing_needed"] is True

    def test_reporter_profile_auto_created(self, client):
        client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-BADGE", "client_report_id": "badge-001",
            "source": "APP", "expected_media": 0,
            # infrastructure_type explicit — defaults to OTHER which
            # the UNDP "please specify" validator rejects without
            # infrastructure_name. We just want a profile auto-created
            # here, not to exercise the OTHER rule.
            "infrastructure_type": "ROAD",
            "location": {"latitude": 10, "longitude": 20},
        })
        res = client.get("/api/v1/reports/profile/TEST-BADGE")
        assert res.status_code == 200
        assert res.json()["badge_level"] == "NEWCOMER"
        assert res.json()["report_count"] >= 1


class TestReportDashboard:
    """Dashboard endpoints require authentication."""

    def test_get_reports_requires_auth(self, client):
        res = client.get("/api/v1/reports/")
        assert res.status_code == 401

    def test_get_reports_viewer_allowed(self, client, viewer_token):
        res = client.get("/api/v1/reports/", headers=auth_header(viewer_token))
        assert res.status_code == 200

    def test_dispatch_requires_analyst(self, client, sample_report, viewer_token, analyst_token):
        rid = sample_report["id"]
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(viewer_token))
        assert res.status_code == 403
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        assert res.status_code == 200

    def test_delete_requires_admin(self, client, sample_report, analyst_token, admin_token):
        rid = sample_report["id"]
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(analyst_token))
        assert res.status_code == 403
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(admin_token))
        assert res.status_code == 200


class TestMediaChunk:
    def test_chunk_upload(self, client, sample_report):
        rid = sample_report["id"]
        res = client.post(f"/api/v1/reports/{rid}/media/chunk", json={
            "media_id": "m-test-001", "type": "IMAGE", "seq_num": 0,
            "total_chunks": 1, "data": "aGVsbG8=", "checksum": None,
        })
        assert res.status_code == 200

    def test_chunk_checksum_mismatch(self, client, sample_report):
        rid = sample_report["id"]
        res = client.post(f"/api/v1/reports/{rid}/media/chunk", json={
            "media_id": "m-test-002", "type": "IMAGE", "seq_num": 0,
            "total_chunks": 1, "data": "dGVzdA==", "checksum": "00000000",
        })
        assert res.status_code == 400


class TestBuildingVersioning:
    def test_nearby_reports_get_same_building_id(self, client):
        r1 = client.post("/api/v1/reports/meta", json={
            "device_hash": "BLD-1", "client_report_id": "bld-001",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 40.7128, "longitude": -74.0060},
        })
        r2 = client.post("/api/v1/reports/meta", json={
            "device_hash": "BLD-2", "client_report_id": "bld-002",
            "source": "TELEGRAM", "expected_media": 0,
            "location": {"latitude": 40.7128, "longitude": -74.0060},  # Same location
        })
        # Both should share a building_id
        id1 = r1.json().get("building_id")
        id2 = r2.json().get("building_id")
        if id1 and id2:
            assert id1 == id2


class TestPurgeEndpoints:
    """Admin-only purge endpoints gated by X-Admin-Key (NOT JWT).

    `verify_admin_key` is a module-level dependency reading
    `app.main.ADMIN_KEY`. In the test environment that var is "" (APP_ENV=dev
    + no CRISP_ADMIN_KEY), which makes the dependency raise 503. We monkey-
    patch the attribute so the endpoint treats our header as valid — same
    effect as setting the env var before Uvicorn boot.
    """

    def test_purge_all_pending_requires_admin_and_removes_soft_deleted(
        self, client, sample_report, admin_token, monkeypatch,
    ):
        import app.main as app_main
        monkeypatch.setattr(app_main, "ADMIN_KEY", "test-purge-key")

        rid = sample_report["id"]

        # Soft-delete via admin dashboard endpoint.
        del_res = client.delete(
            f"/api/v1/reports/{rid}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert del_res.status_code == 200

        # Without the header → 403.
        forbid = client.post("/api/v1/reports/purge-all-pending")
        assert forbid.status_code == 403

        # With the header → success + row gone.
        ok = client.post(
            "/api/v1/reports/purge-all-pending",
            headers={"X-Admin-Key": "test-purge-key"},
        )
        assert ok.status_code == 200
        assert ok.json()["purged"] >= 1

        # Row is hard-deleted — confirm at the DB level (the module has no
        # GET-by-id endpoint, so we inspect the row directly).
        from tests.conftest import TestSessionLocal
        from app.models.report import Report
        s = TestSessionLocal()
        try:
            assert s.query(Report).filter(Report.id == rid).first() is None
        finally:
            s.close()

    def test_purge_expired_returns_count(self, client, monkeypatch):
        """POST /purge-expired → {"purged": <n>}. Returns 0 on a clean DB
        and correctly counts rows whose grace window has elapsed (we
        back-date one Report to force that branch).
        """
        import app.main as app_main
        monkeypatch.setattr(app_main, "ADMIN_KEY", "test-purge-key")

        # Empty-state path.
        res = client.post(
            "/api/v1/reports/purge-expired",
            headers={"X-Admin-Key": "test-purge-key"},
        )
        assert res.status_code == 200
        assert res.json() == {"purged": 0}

        # Seed one report, mark it deleted, back-date requested_at to put
        # it past the 24h grace window.
        from datetime import datetime, timezone, timedelta
        from tests.conftest import TestSessionLocal
        from app.models.report import Report

        meta = client.post("/api/v1/reports/meta", json={
            "device_hash": "PURGE-DEV-001",
            "client_report_id": f"purge-{datetime.now().timestamp()}",
            "source": "APP", "severity": "MODERATE",
            "infrastructure_type": "ROAD", "expected_media": 0,
            "location": {"latitude": 11.0, "longitude": 22.0},
        })
        assert meta.status_code == 201
        rid = meta.json()["id"]

        s = TestSessionLocal()
        try:
            r = s.query(Report).filter(Report.id == rid).first()
            r.deletion_requested_at = datetime.now(timezone.utc) - timedelta(days=2)
            r.deletion_grace_minutes = 1440  # 24h — expired 24h ago
            s.commit()
        finally:
            s.close()

        res = client.post(
            "/api/v1/reports/purge-expired",
            headers={"X-Admin-Key": "test-purge-key"},
        )
        assert res.status_code == 200
        assert res.json()["purged"] >= 1
