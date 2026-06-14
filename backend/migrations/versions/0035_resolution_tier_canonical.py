"""resolution_tier_canonical - Phase L L.1.b

Revision ID: 0035_resolution_tier_canonical
Revises: 0034_ai_retry_queue
Create Date: 2026-05-20

Phase L taxonomy cleanup. The pre-L vocabulary used LOW/MEDIUM/HIGH/ORIGINAL
for `media.resolution_tier` even though only LOW/MEDIUM/HIGH were ever
actually written; ORIGINAL existed in the enum but was never used. After
this migration the canonical vocabulary is SMALL/MEDIUM/ORIGINAL - three
values, each with explicit meaning:

    SMALL    - preview-quality (~50 KB), always required
    MEDIUM   - ~720p (~250 KB)
    ORIGINAL - raw camera bytes if ≤ 5 MB, else best-effort re-encoded

The pre-L LOW and HIGH values remain in the Postgres enum type so SQLAlchemy
load-time validation continues to work for any rows that escape the backfill
(e.g. a row inserted between the migration starting and the pre-L app
container being replaced). The Pydantic write-path normalizer rewrites them
on every NEW insert so the DB converges on the canonical 3-value vocabulary.

Idempotent:
  * `ALTER TYPE … ADD VALUE IF NOT EXISTS` (Postgres 9.6+) - safe to re-run.
  * `UPDATE … WHERE resolution_tier IN (…)` - once the rows are converted,
    the second run touches zero rows.

Down-revision intentionally NULL on the alembic_op - there's no
``downgrade()`` that recovers the original values because the conversion is
lossy (we can't tell post-migration which SMALL rows used to be LOW vs which
were always SMALL). Operator must restore from backup to undo.
"""
from alembic import op
import sqlalchemy as sa


revision = "0035_resolution_tier_canonical"
down_revision = "0034_ai_retry_queue"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        # Add the new canonical SMALL value. ORIGINAL already exists in
        # the enum from the original schema (was unused pre-L).
        # ALTER TYPE … ADD VALUE cannot run inside a transaction block
        # so we explicitly commit + reconnect via autocommit isolation.
        op.execute("COMMIT")
        op.execute(
            "ALTER TYPE resolutionenum ADD VALUE IF NOT EXISTS 'SMALL'"
        )

        # Backfill historical rows. The pre-L mapping was:
        #   PWA 'small' → DB 'LOW'   → canonical 'SMALL'
        #   PWA 'large' → DB 'HIGH'  → canonical 'ORIGINAL'
        # MEDIUM was already canonical (unchanged).
        op.execute(
            "UPDATE media SET resolution_tier = 'SMALL' "
            "WHERE resolution_tier = 'LOW'"
        )
        op.execute(
            "UPDATE media SET resolution_tier = 'ORIGINAL' "
            "WHERE resolution_tier = 'HIGH'"
        )
    else:
        # Non-Postgres dialect (e.g. SQLite if a test fixture ever lands
        # against one - defensive). Just the UPDATEs.
        op.execute(
            "UPDATE media SET resolution_tier = 'SMALL' "
            "WHERE resolution_tier = 'LOW'"
        )
        op.execute(
            "UPDATE media SET resolution_tier = 'ORIGINAL' "
            "WHERE resolution_tier = 'HIGH'"
        )


def downgrade() -> None:
    # See module docstring - backfill is lossy, no safe recovery path.
    # Operator restores from backup to undo. Migration is idempotent
    # forward, so re-running upgrade() after a partial-success rollback
    # is safe.
    raise RuntimeError(
        "0035_resolution_tier_canonical is forward-only. "
        "Operator must restore from backup to revert."
    )
