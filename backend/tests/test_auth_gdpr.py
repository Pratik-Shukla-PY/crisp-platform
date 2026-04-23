"""GDPR surfaces — /me/data-export + /me/delete-account.

The current implementation of account deletion is a SOFT delete with a
30-day grace window: the row stays but `is_active` flips to False and
`gdpr_deletion_requested_at` is stamped. Tests pin that behaviour.
"""
import uuid
from datetime import datetime, timezone

import pytest

from tests.conftest import auth_header


class TestDataExport:
    def test_data_export_returns_user_data_shape(self, client, admin_token):
        """GET /me/data-export → JSON with the documented top-level keys.
        We assert key *presence*, not exact values — login_count, session
        history, etc. vary with test ordering.
        """
        res = client.get(
            "/api/v1/auth/me/data-export",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200
        data = res.json()
        assert set(data.keys()) >= {"user", "sessions", "audit_log"}
        # User block carries the required PII fields so the subject can
        # actually read their data.
        assert data["user"]["email"] == "admin@test.com"
        assert "id" in data["user"]
        assert "role" in data["user"]
        assert isinstance(data["sessions"], list)
        assert isinstance(data["audit_log"], list)

    def test_data_export_viewer_gets_own_data_not_others(self, client, viewer_token, admin_token):
        """A VIEWER hitting /me/data-export must see their own record,
        NOT the admin's. Since `user` is scalar (not a list), the assertion
        reduces to: email matches the token's subject.
        """
        # Viewer export
        viewer_res = client.get(
            "/api/v1/auth/me/data-export",
            headers=auth_header(viewer_token),
        )
        assert viewer_res.status_code == 200
        viewer_data = viewer_res.json()
        assert viewer_data["user"]["email"] == "viewer@test.com"
        assert viewer_data["user"]["role"] == "VIEWER"

        # Cross-check: admin's export is definitely NOT what the viewer got.
        admin_res = client.get(
            "/api/v1/auth/me/data-export",
            headers=auth_header(admin_token),
        )
        assert admin_res.status_code == 200
        assert admin_res.json()["user"]["id"] != viewer_data["user"]["id"]


class TestAccountDeletion:
    def test_delete_account_removes_user_and_data(self, client, db):
        """Current implementation is a SOFT delete: is_active=False and
        `gdpr_deletion_requested_at` is stamped. The row is kept for 30 days
        so the user can reverse their decision by logging in again.
        """
        from app.models.auth import User
        from app.core.security import hash_password, create_access_token

        email = f"deleteme-{uuid.uuid4().hex[:8]}@test.com"
        victim = User(
            email=email,
            password_hash=hash_password("Pass@1234"),
            role="VIEWER", is_active=True, is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(victim)
        db.commit()
        db.refresh(victim)
        token = create_access_token(victim.id, "VIEWER", None, email)

        res = client.post(
            "/api/v1/auth/me/delete-account",
            headers=auth_header(token),
        )
        assert res.status_code == 200

        db.expire_all()
        refreshed = db.query(User).filter(User.id == victim.id).first()
        # Row still present — 30-day grace — but flagged + deactivated.
        assert refreshed is not None
        assert refreshed.is_active is False
        assert refreshed.gdpr_deletion_requested_at is not None

        # The (now-inactive) user's token stops working on auth'd endpoints.
        me = client.get("/api/v1/auth/me", headers=auth_header(token))
        assert me.status_code == 401

    def test_delete_account_requires_confirmation(self, client, db):
        """FINDING — the endpoint does NOT require a confirmation field.
        A single authenticated POST with NO body starts the 30-day deletion
        clock. Test asserts current behaviour (no confirmation needed) so a
        future hardening PR can add a required `confirm: "DELETE"` field
        and flip this assertion.
        """
        from app.models.auth import User
        from app.core.security import hash_password, create_access_token

        email = f"noconfirm-{uuid.uuid4().hex[:8]}@test.com"
        user = User(
            email=email,
            password_hash=hash_password("Pass@1234"),
            role="VIEWER", is_active=True, is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        token = create_access_token(user.id, "VIEWER", None, email)

        # No body at all — current implementation accepts it.
        res = client.post(
            "/api/v1/auth/me/delete-account",
            headers=auth_header(token),
        )
        assert res.status_code == 200
        body = res.json()
        assert "30 days" in body.get("message", "") or "deletion" in body.get("message", "").lower()
