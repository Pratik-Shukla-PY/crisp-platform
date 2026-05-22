"""media_upload_generation — R2.a: epoch column for zombie-replay defense

Revision ID: 0041_media_upload_generation
Revises: 0040_media_recovered_at_recovery
Create Date: 2026-05-22

Problem this column closes:
  Pre-0041, ``media_id`` (a client-allocated UUID) was the sole stable
  handle for an upload. A stale tab / zombie service-worker / late-fetch
  retry from a no-longer-active session COULD theoretically POST chunks
  against an in-flight media_id after the row had been revived from
  abandonment. Because chunk inserts are idempotent only on
  ``(media_id, seq_num)``, a replayed chunk with a *different* seq_num
  would silently bump ``received_chunks`` and could trip a duplicate
  assembly trigger.

The fix is the canonical epoch pattern: the server tracks an integer
``upload_generation`` per Media row. Clients must echo the current
generation on every chunk POST; the server rejects mismatched
generations with 409 Conflict (response body includes the current
generation so the client can resync). On revival from a soft-abandon,
the server bumps the generation by 1 — any pre-abandonment in-flight
chunk replay now sees a stale generation and 409s harmlessly.

Default value 1 keeps every existing client working — legacy clients
that don't send the header are treated as "epoch 1", which matches the
default-1 column value on every row.

Downgrade drops the column. Loses zombie-replay defense but doesn't
break in-flight uploads.
"""

revision = "0041_media_upload_generation"
down_revision = "0040_media_recovered_at_recovery"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column(
            "upload_generation",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment=(
                "R2.a: epoch / generation counter for the upload "
                "session. Clients echo this on every chunk; server "
                "rejects mismatches with 409 Conflict. Bumped on "
                "soft-abandon revival so zombie chunks from the "
                "pre-revival session can't accidentally race with "
                "the new session's chunks."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("media", "upload_generation")
