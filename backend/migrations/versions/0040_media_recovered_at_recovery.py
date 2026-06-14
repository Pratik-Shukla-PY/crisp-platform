"""media_recovered_at_recovery - R1: distinguish abandoned-and-recovered from abandoned-forever

Revision ID: 0040_media_recovered_at_recovery
Revises: 0039_media_pre_blur_retention
Create Date: 2026-05-22

Problem this column closes:
  Pre-0040, a Media row that was abandoned by the assembly-recovery sweep
  (Action ②/③) and later resumed by a returning client would end up in
  ``assembly_status='complete'`` but with ``abandoned_at`` + ``abandon_reason``
  still populated. The dashboard chip predicate ("Upload abandoned") read
  ``abandon_reason`` directly, so successfully-recovered uploads were
  permanently rendered as abandoned - a contradiction the operator hit on
  iPhone Safari multi-photo capture in May 2026.

The fix preserves the audit trail (``abandoned_at`` + ``abandon_reason``
remain write-once at abandonment) and adds a third column that the
assembly worker stamps on successful post-abandon recovery:

  - ``recovered_at: TIMESTAMPTZ NULL`` - set by ``_try_full_assembly_bg``
    when assembly succeeds AND the row was previously abandoned. NULL
    means either (a) never abandoned, or (b) abandoned and not yet
    recovered.

Dashboard chip predicate flips from ``abandon_reason`` to
``abandon_reason AND recovered_at IS NULL``. Recovered rows fall back to
the standard chip rules.

Backfill: any row currently in ``assembly_status='complete'`` with
``abandoned_at IS NOT NULL`` is the exact population this bug already
produced - chunks landed after the abandon stamp, assembly succeeded, but
the chip stayed wrong. Stamp ``recovered_at = updated_at`` for these so
they clear immediately post-deploy. ``updated_at`` is the closest
approximation to the actual completion timestamp (assembly worker bumps
it via ``onupdate=func.now()`` on every column change including the
status flip).

Downgrade drops the column + index + leaves abandoned-but-recovered rows
in their pre-0040 contradictory state. Safe but loses the chip-cleanup.
"""

revision = "0040_media_recovered_at_recovery"
down_revision = "0039_media_pre_blur_retention"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column(
            "recovered_at",
            sa.DateTime(timezone=True),
            nullable=True,
            comment=(
                "R1: stamped by the assembly worker when an "
                "abandoned-but-resumed upload completes successfully. "
                "NULL means either (a) never abandoned, or (b) abandoned "
                "and not yet recovered. Dashboard chip predicate uses "
                "(abandon_reason AND recovered_at IS NULL)."
            ),
        ),
    )
    # Partial index - most rows have recovered_at IS NULL; only the
    # recovered population is interesting. Partial indexes keep storage
    # cost flat as the table grows.
    op.create_index(
        "ix_media_recovered_at",
        "media",
        ["recovered_at"],
        unique=False,
        postgresql_where=sa.text("recovered_at IS NOT NULL"),
    )
    # Backfill: rows that are 'complete' AND had been abandoned previously
    # are the bug's existing footprint. Set recovered_at = updated_at so
    # the dashboard chip clears them on next paint.
    op.execute(
        "UPDATE media "
        "   SET recovered_at = updated_at "
        " WHERE assembly_status = 'complete' "
        "   AND abandoned_at IS NOT NULL "
        "   AND recovered_at IS NULL"
    )


def downgrade() -> None:
    op.drop_index("ix_media_recovered_at", table_name="media")
    op.drop_column("media", "recovered_at")
