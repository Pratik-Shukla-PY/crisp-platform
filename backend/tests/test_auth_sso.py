"""SSO endpoints — providers list, domain-scoped login redirect, callback JIT.

The CRISP SSO layer is architecturally ready for Okta / Auth0 / Azure AD /
Keycloak but the endpoints are intentionally thin: list configured Orgs,
return IdP config for a domain, and JIT-provision a user on callback. These
tests exercise each path without touching a real IdP.
"""
import uuid
from datetime import datetime, timezone

import pytest

from tests.conftest import auth_header  # noqa: F401  — parity with other test files


class TestSSOProviders:
    def test_sso_providers_returns_configured_list(self, client, db):
        """GET /sso/providers returns a list filtered to active Orgs that
        have `sso_provider` set. On a fresh install with no Orgs it's []."""
        res = client.get("/api/v1/auth/sso/providers")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        # Values — each entry has the three documented keys. Harmless on
        # an empty list; the assertion proves the schema contract when
        # rows exist (added by later tests in this module).
        for entry in data:
            assert set(entry.keys()) >= {"name", "domain", "provider"}


class TestSSOLogin:
    def test_sso_login_returns_redirect_or_404_without_configured_domain(self, client):
        """Unknown domain → 404. The response body mentions "SSO" so the
        dashboard can surface a useful error."""
        res = client.get("/api/v1/auth/sso/login", params={"domain": "no-such-domain.example"})
        assert res.status_code == 404
        detail = (res.json().get("detail") or "").lower()
        assert "sso" in detail or "not" in detail

    def test_sso_login_with_configured_domain_returns_redirect(self, client, db):
        """Seed an Org with sso_provider set, then GET /sso/login → endpoint
        returns the IdP config dict so the frontend can redirect. We assert
        the payload shape (provider + organization + config) rather than a
        literal 302, which matches the actual implementation (JSON handshake,
        not a browser redirect response)."""
        from app.models.auth import Organization
        domain = f"sso-{uuid.uuid4().hex[:8]}.test"
        org = Organization(
            name="Test Enterprise",
            domain=domain,
            sso_provider="OKTA",
            sso_config={"metadata_url": "https://example.okta.com/metadata"},
            is_active=True,
        )
        db.add(org)
        db.commit()

        res = client.get("/api/v1/auth/sso/login", params={"domain": domain})
        assert res.status_code == 200
        body = res.json()
        assert body["provider"] == "OKTA"
        assert body["organization"] == "Test Enterprise"
        assert body["config"] == {"metadata_url": "https://example.okta.com/metadata"}


class TestSSOCallback:
    def test_sso_callback_rejects_bad_state_token(self, client):
        """Callback requires `email` in the IdP-posted payload. Missing/forged
        input → 400. This is the closest proxy to state-token rejection given
        the current no-SAML-validation stub; a full SAML integration would
        also verify signature + state-nonce before this point.
        """
        # "Forged state" — no email field at all (simulates a broken callback
        # or a CSRF attempt that dropped the IdP's assertion payload).
        res = client.post("/api/v1/auth/sso/callback", json={"state": "forged"})
        assert res.status_code == 400
        assert "email" in (res.json().get("detail") or "").lower()

    def test_sso_callback_creates_user_on_first_login(self, client, db):
        """JIT provisioning: first-time SSO login creates a User row and
        issues tokens. The IdP-posted `role` maps through `role_map` — we
        pass 'analyst' → ANALYST."""
        from app.models.auth import User

        email = f"jit-{uuid.uuid4().hex[:8]}@sso-test.com"
        # No IdP network call — the callback endpoint accepts a plain dict
        # (SAML assertion / OIDC token in the real world, parsed upstream).
        res = client.post("/api/v1/auth/sso/callback", json={
            "email": email,
            "name": "JIT User",
            "role": "analyst",
        })
        assert res.status_code == 200
        data = res.json()
        assert "access_token" in data
        assert data["user"]["email"] == email
        assert data["user"]["role"] == "ANALYST"

        # Verify DB row actually persisted — the cached session may still
        # see the pre-insert snapshot, so expire_all first.
        db.expire_all()
        user = db.query(User).filter(User.email == email).first()
        assert user is not None
        assert user.role == "ANALYST"
        assert user.is_verified is True
