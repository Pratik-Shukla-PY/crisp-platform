"""media: add pii_blur_status column

Revision ID: 0005_pii
Revises: 0004_bin
Create Date: 2026-04-21

Tracks server-side PII-blur outcome explicitly so a deployment with
missing MediaPipe / easyocr backends can't silently pass unblurred
images to the dashboard. Values documented on the SQLAlchemy column in
`app.models.report.Media.pii_blur_status`.

Idempotent — same pattern as prior revisions (0002/0003/0004). Safe to
rerun on databases that already have the column.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0005_pii"
down_revision: Union[str, Sequence[str], None] = "0004_bin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _has_column("media", "pii_blur_status"):
        with op.batch_alter_table("media") as batch_op:
            batch_op.add_column(
                sa.Column("pii_blur_status", sa.String(length=16), nullable=True)
            )
            batch_op.create_index(
                "ix_media_pii_blur_status",
                ["pii_blur_status"],
            )

    # Backfill strategy for pre-April-2026 rows:
    #   * rows where client_blur_applied=true → 'not_needed' (client-side
    #     blur happened, server never ran a pass regardless).
    #   * rows where client_blur_applied=false AND assembly_status='complete'
    #     → 'complete' IF the server's async blur worker had already
    #       fired-and-forgotten a successful run; we can't tell from the
    #       DB alone. Mark 'unknown' is worse than 'skipped' for privacy
    #       posture — dashboard should warn on this legacy cohort until
    #       operator reviews.
    # Keep this migration conservative: do NOT backfill 'complete' on old
    # rows. Leave them NULL and let the dashboard treat NULL as "legacy,
    # pre-tracking". Only new writes populate the column.
    op.execute(sa.text(
        "UPDATE media SET pii_blur_status = 'not_needed' "
        "WHERE pii_blur_status IS NULL AND client_blur_applied = 1"
    ))


def downgrade() -> None:
    if _has_column("media", "pii_blur_status"):
        with op.batch_alter_table("media") as batch_op:
            try:
                batch_op.drop_index("ix_media_pii_blur_status")
            except Exception:
                pass
            batch_op.drop_column("pii_blur_status")
