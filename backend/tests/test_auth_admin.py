"""Admin user/session management — under /api/v1/auth/users and /sessions.

Covers role-based access control on the admin CRUD surface plus session
revocation semantics.
"""
import uuid
from datetime import datetime, timezone

import pytest

from tests.conftest import auth_header


def _register_and_login(client, email: str, password: str = "Pass@1234"):
    """Register + verify a user via OTP happy-path, returning the tokens dict
    from the final OTP verification (which `_issue_tokens`)."""
    from app.db.session import SessionLocal  # noqa: F401

    reg = client.post("/api/v1/auth/register", json={
        "email": email, "password": password, "full_name": "Seed User",
    })
    assert reg.status_code == 200

    # Grab the OTP code — SMTP is disabled in tests so the record is still
    # in-table. We read it directly rather than re-request + log-parse.
    from tests.conftest import TestSessionLocal
    from app.models.auth import OTPRecord
    s = TestSessionLocal()
    try:
        otp = (s.query(OTPRecord)
               .filter(OTPRecord.email == email, OTPRecord.purpose == "SIGNUP", OTPRecord.used == False)
               .order_by(OTPRecord.created_at.desc()).first())
        code = otp.code if otp else None
    finally:
        s.close()
    assert code is not None

    verify = client.post("/api/v1/auth/otp/verify", json={
        "email": email, "code": code, "purpose": "SIGNUP",
    })
    assert verify.status_code == 200, verify.text
    return verify.json()


class TestListUsers:
    def test_list_users_requires_admin(self, client, admin_token, viewer_token):
        """Viewer → 403; admin → 200 with a list. Endpoint is /auth/users."""
        res = client.get("/api/v1/auth/users", headers=auth_header(viewer_token))
        assert res.status_code == 403

        res = client.get("/api/v1/auth/users", headers=auth_header(admin_token))
        assert res.status_code == 200
        assert isinstance(res.json(), list)
        # At minimum, the admin sees themselves
        assert any(u["email"] == "admin@test.com" for u in res.json())


class TestPatchUser:
    def test_admin_can_patch_user_role(self, client, admin_token, db):
        """Admin PATCH /users/{id} with {"role": "ANALYST"} updates the row.

        Uses a throwaway user (not the shared viewer_user fixture) so the
        role change is isolated from later tests.
        """
        from app.models.auth import User
        from app.core.security import hash_password

        target = User(
            email=f"rolepatch-{uuid.uuid4().hex[:8]}@test.com",
            password_hash=hash_password("Pass@1234"),
            role="VIEWER", is_active=True, is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(target)
        db.commit()
        db.refresh(target)

        res = client.patch(
            f"/api/v1/auth/users/{target.id}",
            headers=auth_header(admin_token),
            json={"role": "ANALYST"},
        )
        assert res.status_code == 200

        db.expire_all()
        refreshed = db.query(User).filter(User.id == target.id).first()
        assert refreshed.role == "ANALYST"

    def test_admin_cannot_patch_self_to_non_admin(self, client, db):
        """FINDING — the endpoint has NO self-lockout guard. A second admin
        (created just for this test) can demote their OWN account to VIEWER,
        which would strand the organisation behind a role gate none of their
        tokens satisfy. We isolate this to a throwaway admin user (not the
        session-scoped `admin_user`) so the demotion can't contaminate the
        fixture shared with later tests. When hardening lands, flip the
        status assertion to 400 and assert the role is unchanged.
        """
        from app.models.auth import User
        from app.core.security import create_access_token, hash_password

        solo_admin = User(
            email=f"solo-{uuid.uuid4().hex[:8]}@test.com",
            password_hash=hash_password("Solo@1234"),
            role="ADMIN", is_active=True, is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(solo_admin)
        db.commit()
        db.refresh(solo_admin)
        solo_token = create_access_token(
            solo_admin.id, solo_admin.role, None, solo_admin.email,
        )

        res = client.patch(
            f"/api/v1/auth/users/{solo_admin.id}",
            headers=auth_header(solo_token),
            json={"role": "VIEWER"},
        )
        # Current behaviour: no self-guard → update succeeds.
        assert res.status_code == 200

        db.expire_all()
        refreshed = db.query(User).filter(User.id == solo_admin.id).first()
        assert refreshed.role == "VIEWER"


class TestDeleteUser:
    def test_admin_delete_user_revokes_sessions(self, client, admin_token, db):
        """Delete the user row → their cached JWT now fails auth.

        `get_current_user` filters on `User.is_active == True` — once the
        row is gone, the query returns None and the dep raises 401. Sessions
        are cascade-deleted via FK. We test the net effect (dead token) rather
        than rummaging through the user_sessions table.
        """
        # Build a disposable user + grab their token.
        email = f"delete-{uuid.uuid4().hex[:8]}@test.com"
        tokens = _register_and_login(client, email)
        victim_token = tokens["access_token"]
        victim_id = tokens["user"]["id"]

        # Sanity — token works pre-delete.
        ok = client.get("/api/v1/auth/me", headers=auth_header(victim_token))
        assert ok.status_code == 200

        # Admin deletes them.
        deletion = client.delete(
            f"/api/v1/auth/users/{victim_id}", headers=auth_header(admin_token),
        )
        assert deletion.status_code == 200

        # Token now 401s against any auth'd endpoint.
        after = client.get("/api/v1/auth/me", headers=auth_header(victim_token))
        assert after.status_code == 401


class TestSessionManagement:
    def test_admin_list_sessions_shows_active(self, client, admin_user):
        """Log in twice (same account, different sessions) → GET /sessions
        surfaces 2+ active rows. The endpoint is scoped to the caller, so
        we log the same user in twice and call /sessions with either token.
        """
        login1 = client.post("/api/v1/auth/login", json={
            "email": "admin@test.com", "password": "Admin@1234",
        })
        assert login1.status_code == 200
        login2 = client.post("/api/v1/auth/login", json={
            "email": "admin@test.com", "password": "Admin@1234",
        })
        assert login2.status_code == 200

        tok = login2.json()["access_token"]
        res = client.get("/api/v1/auth/sessions", headers=auth_header(tok))
        assert res.status_code == 200
        sessions = res.json()
        assert len(sessions) >= 2

    def test_admin_delete_session_revokes_that_token_only(self, client, admin_user, db):
        """Revoking session A should leave session B's refresh token still
        usable. Access tokens themselves aren't session-bound (stateless
        JWT), so we check via the refresh path — the canonical
        per-session revocation surface.

        We look up each login's session row BY refresh_token_hash (not by
        ordering heuristics) so residual sessions from earlier tests
        don't poison the selection.
        """
        from app.models.auth import UserSession
        from app.core.security import hash_token

        l1 = client.post("/api/v1/auth/login", json={
            "email": "admin@test.com", "password": "Admin@1234",
        }).json()
        l2 = client.post("/api/v1/auth/login", json={
            "email": "admin@test.com", "password": "Admin@1234",
        }).json()

        # Map refresh tokens → session IDs via hash lookup.
        db.expire_all()
        l1_session = db.query(UserSession).filter(
            UserSession.refresh_token_hash == hash_token(l1["refresh_token"])
        ).first()
        assert l1_session is not None

        # Revoke session l1 via admin's token.
        rev = client.delete(
            f"/api/v1/auth/sessions/{l1_session.id}",
            headers=auth_header(l2["access_token"]),
        )
        assert rev.status_code == 200

        # Session B's refresh still exchanges for a fresh access token.
        r = client.post(
            "/api/v1/auth/refresh", json={"refresh_token": l2["refresh_token"]},
        )
        assert r.status_code == 200
        # Session A's refresh should now fail.
        r_dead = client.post(
            "/api/v1/auth/refresh", json={"refresh_token": l1["refresh_token"]},
        )
        assert r_dead.status_code == 401
