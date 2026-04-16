"""API integration tests for auth endpoints."""
import pytest
from tests.conftest import auth_header


class TestRegister:
    def test_register_new_user(self, client):
        res = client.post("/api/v1/auth/register", json={"email": "new@test.com"})
        assert res.status_code == 200
        assert "OTP sent" in res.json()["message"] or "Registration" in res.json()["message"]

    def test_register_duplicate_email(self, client):
        client.post("/api/v1/auth/register", json={"email": "dup@test.com"})
        res = client.post("/api/v1/auth/register", json={"email": "dup@test.com"})
        assert res.status_code == 409

    def test_register_with_weak_password(self, client):
        res = client.post("/api/v1/auth/register", json={"email": "weak@test.com", "password": "123"})
        assert res.status_code == 400

    def test_register_with_strong_password(self, client):
        res = client.post("/api/v1/auth/register", json={"email": "strong@test.com", "password": "Strong@1234"})
        assert res.status_code == 200


class TestLogin:
    def test_login_correct_password(self, client, admin_user):
        res = client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "Admin@1234"})
        assert res.status_code == 200
        data = res.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["user"]["role"] == "SUPER_ADMIN"

    def test_login_wrong_password(self, client, admin_user):
        res = client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "Wrong@1234"})
        assert res.status_code == 401

    def test_login_nonexistent_user(self, client):
        res = client.post("/api/v1/auth/login", json={"email": "nobody@test.com", "password": "Test@1234"})
        assert res.status_code == 401


class TestOTP:
    def test_otp_request(self, client, admin_user):
        res = client.post("/api/v1/auth/otp/request", json={"email": "admin@test.com", "purpose": "LOGIN"})
        assert res.status_code == 200

    def test_otp_verify_wrong_code(self, client, admin_user):
        client.post("/api/v1/auth/otp/request", json={"email": "admin@test.com", "purpose": "LOGIN"})
        res = client.post("/api/v1/auth/otp/verify", json={"email": "admin@test.com", "code": "000000", "purpose": "LOGIN"})
        assert res.status_code == 400


class TestTokenRefresh:
    def test_refresh_valid(self, client, admin_user):
        login = client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "Admin@1234"})
        refresh = login.json()["refresh_token"]
        res = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
        assert res.status_code == 200
        assert "access_token" in res.json()

    def test_refresh_invalid_token(self, client):
        res = client.post("/api/v1/auth/refresh", json={"refresh_token": "invalid"})
        assert res.status_code == 401


class TestProfile:
    def test_get_profile(self, client, admin_token):
        res = client.get("/api/v1/auth/me", headers=auth_header(admin_token))
        assert res.status_code == 200
        assert res.json()["email"] == "admin@test.com"

    def test_get_profile_no_token(self, client):
        res = client.get("/api/v1/auth/me")
        assert res.status_code == 401


class TestRBAC:
    def test_admin_can_list_users(self, client, admin_token):
        res = client.get("/api/v1/auth/users", headers=auth_header(admin_token))
        assert res.status_code == 200

    def test_viewer_cannot_list_users(self, client, viewer_token):
        res = client.get("/api/v1/auth/users", headers=auth_header(viewer_token))
        assert res.status_code == 403


class TestGDPR:
    def test_data_export(self, client, admin_token):
        res = client.get("/api/v1/auth/me/data-export", headers=auth_header(admin_token))
        assert res.status_code == 200
        data = res.json()
        assert "user" in data
        assert "sessions" in data
