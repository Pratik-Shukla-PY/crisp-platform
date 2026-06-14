"""reports: add blurhash column

Revision ID: 0006_bh
Revises: 0005_pii
Create Date: 2026-04-22

Phase-1 progressive-upload stack. Adds `Report.blurhash` - a compact
~28–32-char string encoding a 4x3 DCT of the main photo. Dashboard
decodes it to a blurred colour impression the instant the meta POST
lands, BEFORE any media chunk arrives; closes the
time-to-first-visual gap from ~2 s down to ~200 ms.

See:
  * `app/models/report.py::Report.blurhash`
  * `app/schemas/report.py::ReportMetaCreate.blurhash`

Idempotent - same pattern as prior revisions (0002/0003/0004/0005).
Safe to rerun on databases that already have the column.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0006_bh"
down_revision: Union[str, Sequence[str], None] = "0005_pii"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    # Idempotent add: only apply if the column is actually missing.
    if not _has_column("reports", "blurhash"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.add_column(
                sa.Column("blurhash", sa.String(length=96), nullable=True)
            )
    # No backfill: pre-Phase-1 reports simply render without a placeholder
    # (dashboard handles NULL blurhash gracefully - falls back to the
    # existing "awaiting media" icon). A backfill would require re-encoding
    # every archived photo; too expensive + no user-facing value.


def downgrade() -> None:
    if _has_column("reports", "blurhash"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.drop_column("blurhash")
