"""users.mfa_secret - TOTP authenticator-app shared secret

Revision ID: 0011_mfa
Revises: 0010_auth
Create Date: 2026-04-25

Apr 2026 - Single-admin dashboard lockdown. Adds the column that stores
the base32-encoded TOTP shared secret per RFC 6238. Verified via
``pyotp.TOTP(secret).verify(code)`` in the /auth/login endpoint when
``users.mfa_enabled = True``.

Additive-only:
  - New column is nullable (existing rows keep `mfa_secret = NULL`,
    which combined with `mfa_enabled = False` means they're unaffected).
  - No data backfill - only the operator(s) who explicitly enrol via
    the provisioning script populate this column.
  - Idempotent: re-running on a DB that already has the column is a
    no-op (we inspect the live schema first).

Rollback path: drop the column. Any user with `mfa_enabled = True` will
fail to log in afterwards (the login code branch reads NULL secret →
500). In practice, also flip `mfa_enabled = False` for those users
before downgrade.
"""
from alembic import op
import sqlalchemy as sa


revision = "0011_mfa"
down_revision = "0010_auth"
branch_labels = None
depends_on = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = [c["name"] for c in inspector.get_columns(table_name)]
    return column_name in cols


def upgrade() -> None:
    if not _has_column("users", "mfa_secret"):
        op.add_column(
            "users",
            sa.Column("mfa_secret", sa.String(length=64), nullable=True),
        )


def downgrade() -> None:
    if _has_column("users", "mfa_secret"):
        op.drop_column("users", "mfa_secret")
