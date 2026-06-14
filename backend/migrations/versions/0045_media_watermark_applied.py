"""media.watermark_applied - server-side geotag burn-in idempotency (HC98)

Adds a boolean flag set once the geotag caption + GPS EXIF have been stamped
into a media's stored bytes, so the PII-blur worker can't double-stamp on retry.
Additive + defaulted → safe online migration (no backfill, no lock churn).

Revision ID: 0045_media_watermark
Revises: 0044_media_perf
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa

revision = "0045_media_watermark"
down_revision = "0044_media_perf"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "media",
        sa.Column(
            "watermark_applied",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade():
    op.drop_column("media", "watermark_applied")
