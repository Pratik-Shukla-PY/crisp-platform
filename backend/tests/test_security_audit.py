"""Security audit tests — brute force, rate limiting, role escalation."""
import pytest
from tests.conftest import auth_header


class TestBruteForce:
    def test_account_locks_after_5_failures(self, client, admin_user):
        for i in range(5):
            client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": f"Wrong@{i}"})
        res = client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "Wrong@6"})
        assert res.status_code == 423  # Locked


class TestTokenSecurity:
    def test_expired_token_rejected(self, client):
        # Craft a token that's already expired
        from app.core.security import JWT_SECRET, JWT_ALGORITHM
        from jose import jwt
        from datetime import datetime, timezone, timedelta
        expired = jwt.encode({"sub": "u1", "role": "ADMIN", "type": "access",
                              "exp": datetime.now(timezone.utc) - timedelta(hours=1)},
                             JWT_SECRET, algorithm=JWT_ALGORITHM)
        res = client.get("/api/v1/reports/", headers=auth_header(expired))
        assert res.status_code == 401

    def test_invalid_token_rejected(self, client):
        res = client.get("/api/v1/reports/", headers=auth_header("garbage.token.here"))
        assert res.status_code == 401

    def test_no_token_rejected(self, client):
        res = client.get("/api/v1/reports/")
        assert res.status_code == 401


class TestRoleEscalation:
    def test_viewer_cannot_dispatch(self, client, sample_report, viewer_token):
        rid = sample_report["id"]
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(viewer_token))
        assert res.status_code == 403

    def test_analyst_cannot_delete(self, client, sample_report, analyst_token):
        rid = sample_report["id"]
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(analyst_token))
        assert res.status_code == 403

    def test_viewer_cannot_manage_users(self, client, viewer_token):
        res = client.get("/api/v1/auth/users", headers=auth_header(viewer_token))
        assert res.status_code == 403


class TestInputValidation:
    def test_chunk_max_size_enforced(self, client, sample_report):
        rid = sample_report["id"]
        res = client.post(f"/api/v1/reports/{rid}/media/chunk", json={
            "media_id": "sec-001", "type": "IMAGE", "seq_num": 0,
            "total_chunks": 1, "data": "x" * 1100000,  # Over 1MB limit
        })
        assert res.status_code == 422  # Pydantic validation error

    def test_description_max_length(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "SEC-1", "client_report_id": "sec-desc-001",
            "description": "x" * 5001,  # Over 5000 char limit
            "expected_media": 0, "location": {"latitude": 0, "longitude": 0},
        })
        assert res.status_code == 422
