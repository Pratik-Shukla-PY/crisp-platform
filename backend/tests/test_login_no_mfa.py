"""UNDP demo access: an account provisioned without 2FA (create_admin --no-mfa)
logs in on email + password alone, while MFA-enabled accounts still require the
authenticator code. The dashboard login UI relaxes its client-side code gate to
match this; enforcement stays server-side and per-account."""
import pyotp
from datetime import datetime, timezone

from app.models.auth import User
from app.core.security import hash_password


def _mk(db, email, mfa, secret=None):
    u = db.query(User).filter(User.email == email).first()
    if not u:
        u = User(
            email=email,
            password_hash=hash_password("Pass@1234"),
            full_name="Demo",
            role="SUPER_ADMIN",
            is_active=True,
            is_verified=True,
            mfa_enabled=mfa,
            mfa_secret=secret,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(u)
        db.commit()
        db.refresh(u)
    return u


def test_no_mfa_login_email_password_only(db, client):
    _mk(db, "demo-nomfa@undp.org", False)
    r = client.post(
        "/api/v1/auth/login",
        json={"email": "demo-nomfa@undp.org", "password": "Pass@1234"},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")


def test_mfa_account_still_enforces_code(db, client):
    secret = pyotp.random_base32()
    _mk(db, "demo-mfa@undp.org", True, secret)
    # missing code -> rejected (server enforces per-account, UI relaxation aside)
    r = client.post(
        "/api/v1/auth/login",
        json={"email": "demo-mfa@undp.org", "password": "Pass@1234"},
    )
    assert r.status_code == 400, r.text
    # correct code -> ok
    code = pyotp.TOTP(secret).now()
    r2 = client.post(
        "/api/v1/auth/login",
        json={"email": "demo-mfa@undp.org", "password": "Pass@1234", "totp_code": code},
    )
    assert r2.status_code == 200, r2.text
