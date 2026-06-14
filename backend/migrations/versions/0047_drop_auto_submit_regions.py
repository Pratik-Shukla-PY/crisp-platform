"""Drop the auto-submit-regions feature

Removes the `auto_submit_regions` config table and the `reports.is_auto_submitted`
flag. The feature (admin geofence → 2-minute countdown → auto-submit) was dormant
in the V4 report flow on every client and is being deleted to simplify the app.

Both drops are safe:
- `auto_submit_regions` has no inbound FK (only `created_by → users` ON DELETE
  SET NULL), so dropping it can't orphan or block any other row.
- `reports.is_auto_submitted` was a passive flag - written at ingest, read only
  by a now-removed cosmetic dashboard badge (never in exports, scoring, or
  filtering). Postgres DROP COLUMN is metadata-only (no table rewrite / lock
  churn), so it's cheap even on a large reports table.

Revision ID: 0047_drop_auto_submit_regions
Revises: 0046_crisis_forms
Create Date: 2026-06-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0047_drop_auto_submit_regions"
down_revision = "0046_crisis_forms"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_column("reports", "is_auto_submitted")
    op.drop_table("auto_submit_regions")


def downgrade():
    # Recreate the table exactly as the baseline schema defined it.
    op.create_table(
        "auto_submit_regions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("center_lat", sa.Float(), nullable=False),
        sa.Column("center_lng", sa.Float(), nullable=False),
        sa.Column("radius_meters", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.add_column(
        "reports",
        sa.Column("is_auto_submitted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
