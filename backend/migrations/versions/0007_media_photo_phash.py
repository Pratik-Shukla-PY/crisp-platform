"""media: add photo_phash column + index for redundancy detection

Revision ID: 0007_phash
Revises: 0006_bh
Create Date: 2026-04-22

UNDP nice-to-have #3: "Redundancy detection to spot duplicates with the
same time-stamp of submission, or over-reporting". Adds a 16-char hex
column storing the perceptual hash (imagehash.phash → 64-bit → hex) of
each assembled photo. Computed post-assembly in the AI executor; nullable
for audio / video / legacy rows.

Indexed so the dashboard's "find near-duplicates in the same building
within the last 24 h" query is O(log n) on the hash prefix. True Hamming-
distance comparison still happens in Python after the prefix narrow-down
(64-bit popcount isn't standard SQL), but the index is enough to keep
the candidate set tiny for any realistic crisis.

Idempotent - same pattern as 0004/0005/0006. Safe to rerun.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0007_phash"
down_revision: Union[str, Sequence[str], None] = "0006_bh"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def _has_index(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(idx["name"] == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_column("media", "photo_phash"):
        with op.batch_alter_table("media") as batch_op:
            batch_op.add_column(
                sa.Column("photo_phash", sa.String(length=16), nullable=True)
            )
    # create_index separately because some path (like pyshp-testdb) can
    # leave `_has_column` true + the index missing.
    if not _has_index("media", "ix_media_photo_phash"):
        op.create_index(
            "ix_media_photo_phash",
            "media",
            ["photo_phash"],
        )
    # No backfill - legacy rows stay NULL. The dashboard treats NULL as
    # "not-yet-scanned" (not "unique"); a future admin endpoint can
    # re-hash on demand.


def downgrade() -> None:
    if _has_index("media", "ix_media_photo_phash"):
        op.drop_index("ix_media_photo_phash", table_name="media")
    if _has_column("media", "photo_phash"):
        with op.batch_alter_table("media") as batch_op:
            batch_op.drop_column("photo_phash")
