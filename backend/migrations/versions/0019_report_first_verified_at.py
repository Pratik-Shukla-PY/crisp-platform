"""reports: add first_verified_at timestamp for idempotent tier-credit

Revision ID: 0019_report_first_verified_at
Revises: 0018_locations_lat_lng_index
Create Date: 2026-05-15

CRISP gamification audit (May 2026) caught a race condition in
``_mark_report_verified_for_credibility``: when two analyst
endpoints (dispatch + resolve) both fire on the same report from
parallel requests, BOTH see ``was_pending=True`` before either
commits → both bump ``ReporterProfile.verified_count`` → reporter's
tier promotes twice for a single report.

The fix is application-side idempotency: stamp
``reports.first_verified_at`` the first time we credit a report
toward verified_count, and short-circuit any subsequent call.
``SELECT … FOR UPDATE`` on the row lock in the credit function
guarantees serialization within a transaction.

This migration adds the column + an index. Indexed because the
admin dashboard's "verified-this-week" leaderboard query (queued
post-submission per docs/UNDP-MODULES.md) will filter on it.

Idempotent — uses the inspector guard pattern from 0013 / 0015 /
0017 / 0018.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0019_report_first_verified_at"
down_revision = "0018_locations_lat_lng_index"
branch_labels = None
depends_on = None


_COLUMN_NAME = "first_verified_at"
_INDEX_NAME = "ix_reports_first_verified_at"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Column may already exist on a re-applied migration; check first.
    existing_cols = {c["name"] for c in inspector.get_columns("reports")}
    if _COLUMN_NAME not in existing_cols:
        op.add_column(
            "reports",
            sa.Column(_COLUMN_NAME, sa.DateTime(timezone=True), nullable=True),
        )

    existing_idx = {idx["name"] for idx in inspector.get_indexes("reports")}
    if _INDEX_NAME not in existing_idx:
        op.create_index(
            _INDEX_NAME,
            "reports",
            [_COLUMN_NAME],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_idx = {idx["name"] for idx in inspector.get_indexes("reports")}
    if _INDEX_NAME in existing_idx:
        op.drop_index(_INDEX_NAME, table_name="reports")

    existing_cols = {c["name"] for c in inspector.get_columns("reports")}
    if _COLUMN_NAME in existing_cols:
        op.drop_column("reports", _COLUMN_NAME)
