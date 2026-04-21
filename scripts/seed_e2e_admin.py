#!/usr/bin/env python3
"""
CRISP — Seed a deterministic SUPER_ADMIN user for end-to-end tests.

The public /auth/register endpoint always assigns RoleEnum.VIEWER and leaves
the user unverified — fine for real users, unusable for E2E because every
admin-scoped test would fail on 403. This script writes the user directly
via SQLAlchemy and promotes them in a single transaction.

Idempotent: re-running updates the existing row's password + role rather
than 500'ing on duplicate email.

Invoked from test.sh before Playwright starts; safe to run standalone:

    cd backend && source venv/bin/activate && python ../scripts/seed_e2e_admin.py

The user created here matches helpers/api.ts:ADMIN — if either side
changes, both must change.
"""
import sys, os
from datetime import datetime, timezone

# Allow running from repo root or from backend/
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend')))

# Default to dev env if caller didn't set it; the backend's security layer
# refuses to boot in production without a proper JWT_SECRET.
os.environ.setdefault("APP_ENV", "dev")

from app.db.session import SessionLocal  # noqa: E402
from app.models.auth import User, RoleEnum  # noqa: E402
from app.core.security import hash_password  # noqa: E402

ADMIN_EMAIL = "e2e-admin@crisp-e2e-tests.org"
ADMIN_PASSWORD = "E2eAdmin!2026"
ADMIN_NAME = "E2E Admin"


def main() -> int:
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == ADMIN_EMAIL).first()
        if existing:
            # Keep the ID stable; rotate password + role only.
            existing.password_hash = hash_password(ADMIN_PASSWORD)
            existing.role = RoleEnum.SUPER_ADMIN.value
            existing.is_active = True
            existing.is_verified = True
            existing.full_name = ADMIN_NAME
            action = "updated"
        else:
            user = User(
                email=ADMIN_EMAIL,
                password_hash=hash_password(ADMIN_PASSWORD),
                full_name=ADMIN_NAME,
                role=RoleEnum.SUPER_ADMIN.value,
                is_active=True,
                is_verified=True,
                gdpr_consent_at=datetime.now(timezone.utc),
            )
            db.add(user)
            action = "created"
        db.commit()
        print(f"✓ E2E admin {action}: {ADMIN_EMAIL}")
        return 0
    except Exception as e:
        db.rollback()
        print(f"✗ seed_e2e_admin failed: {e}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
