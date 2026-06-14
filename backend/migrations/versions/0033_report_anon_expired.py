"""report_anon_due_expired_token - Phase K K.2.e

Revision ID: 0033_report_anon_due_expired_token
Revises: 0032_media_abandoned
Create Date: 2026-05-20

Adds one boolean column on `reports`:

  * submitted_as_anonymous_due_to_expired_token - TRUE when the
    client presented a Bearer token but it had expired beyond the
    auth-grace window. The report is still accepted (anonymous
    submission is a UNDP must-have #9 invariant) but the flag
    surfaces to operators via the K.5.a dashboard chip
    "🔓 Attribution lost" so the reporter doesn't get silently
    de-credited.

The column defaults to FALSE so legacy rows behave correctly without
a backfill.
"""
from alembic import op
import sqlalchemy as sa


revision = "0033_report_anon_expired"
down_revision = "0032_media_abandoned"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column(
            "submitted_as_anonymous_due_to_expired_token",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("reports", "submitted_as_anonymous_due_to_expired_token")
