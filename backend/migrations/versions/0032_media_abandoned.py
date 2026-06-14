"""media_abandoned - Phase F image-reliability: terminal state for stuck uploads

Revision ID: 0032_media_abandoned
Revises: 0031_building_notes
Create Date: 2026-05-19

Adds two columns on `media` so a stuck assembly can reach a TERMINAL state:

  * abandoned_at      - timestamp at which the periodic recovery sweep
                        gave up and flipped the row to assembly_status='failed'.
                        NULL on all other rows (complete, pending, assembling).
  * abandon_reason    - short token describing why we gave up:
                          chunks_never_arrived - received_chunks < chunk_count
                                                 + updated_at older than the
                                                 abandon-stale window
                          assembly_worker_lost - stuck in 'assembling' past
                                                 the worker-deadline window
                                                 (boot-sweep retry exhausted)
                          checksum_mismatch    - full-asset djb2 failed
                                                 (already used today, surfaced
                                                 here for parity)
                          operator_manual      - operator clicked
                                                 "Mark abandoned" in the F3
                                                 reclaim endpoint
                        NULL on all rows that haven't been abandoned.

Why this matters: today the dashboard treats `assembly_status != 'complete'`
identically - pending / assembling / failed all render as "Original uploading
…" with a pulsing spinner for up to 14 days. After this migration + the
companion periodic sweep, stuck rows actually reach `assembly_status='failed'`
with `abandon_reason` populated, and the dashboard can finally render
"Original lost (network timeout)" so the operator stops waiting forever.

Index: ix_media_abandoned_at is for the periodic sweep's "find old failed
rows" query. Not a foreign-key index; just a date-range probe.

This migration is a pure column add - zero data backfill required. Existing
'failed' rows that happened pre-migration leave both columns NULL; the
dashboard renders them as a generic "Original lost" with no reason chip,
which is the correct degraded behaviour.
"""
from alembic import op
import sqlalchemy as sa


revision = "0032_media_abandoned"
down_revision = "0031_building_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column("abandoned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("abandon_reason", sa.String(40), nullable=True),
    )
    op.create_index(
        "ix_media_abandoned_at",
        "media",
        ["abandoned_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_media_abandoned_at", table_name="media")
    op.drop_column("media", "abandon_reason")
    op.drop_column("media", "abandoned_at")
