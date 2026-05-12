"""Add full_asset_checksum column to media for end-to-end integrity

Revision ID: 0017_full_asset_checksum
Revises: 0016_undp_crisis_norm
Create Date: 2026-05-12

Defence-in-depth for the original-tier delivery path. Per-chunk djb2
already protects each chunk on the wire, and the `UniqueConstraint`
on `(media_id, seq_num)` rejects duplicate-seq writes — so wire
fidelity is solid today.

What this column buys: a guard against future regressions inside
`_assemble_media_file()` (sort logic, base64 decode, concat). The
PWA computes `djb2_bytes(originalBytes)` ONCE before chunking each
variant and sends it on chunk 0; the backend stores it here. After
assembly, the backend re-computes djb2 over the final file bytes
and compares — mismatch => assembly_status='failed' + Prometheus
counter. Catches a whole class of "assembler shipped garbage" bugs
before they reach the dashboard.

Optional column — legacy rows + clients without the new field write
NULL and skip the check. Backward compatible.

Idempotent — re-running is a no-op once the column exists.
"""
from alembic import op
import sqlalchemy as sa


revision = "0017_full_asset_checksum"
down_revision = "0016_undp_crisis_norm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # djb2 output is a 32-bit value rendered as 8-char hex; 16 bytes is
    # generous (room for a future bump to djb2_64 or sha256-truncated
    # without another migration).
    op.add_column(
        "media",
        sa.Column("full_asset_checksum", sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("media", "full_asset_checksum")
