"""performance indexes for media-table sweep + report-detail queries

Revision ID: 0044_media_perf
Revises: 0043_geocode_cache
Create Date: 2026-05-28 (Sprint 3B, May 2026 — DB index audit)

DB index audit during Sprint 3B (post-HC91) identified three gaps in
the `media` table indexing that show up under load:

  1. `media.report_id` — declared as a Foreign Key but Postgres does
     NOT auto-create indexes for FK columns (only the parent's primary
     key). Every report-detail load + every dashboard variant lookup
     scans `media` linearly to find rows for a given report. At pilot
     scale (< 10k reports total) the planner sometimes prefers seq scan
     and it's fine. At 500k+ rows it becomes a hot path with O(N) cost.

  2. `media.assembly_status` — used in every sweep tick (Actions ⓪/①/
     ②/③ all filter on this) AND in the public reports listing's
     "received_media" counter (joined Media subquery filters by
     assembly_status='complete'). Currently a seq scan.

  3. Composite partial `(assembly_status, updated_at, created_at)
     WHERE abandoned_at IS NULL` — covers the WHERE clauses of all
     four sweep actions in a single index lookup. Partial because
     abandoned rows aren't candidates for any sweep action, so we
     can keep this index narrow.

All three created with CONCURRENTLY so the upgrade doesn't lock the
`media` table on a live PROD migration. Alembic must run this
migration outside its default transaction (the @-comment below).

Verified locally with EXPLAIN ANALYZE on a 100k-row seeded `media`:
  Pre:   `Seq Scan on media (cost=0.00..3245.00 rows=100000 width=...)`
  Post:  `Index Scan using ix_media_active_sweep ... rows=247 width=...`
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0044_media_perf"
down_revision: Union[str, Sequence[str], None] = "0043_geocode_cache"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Run OUTSIDE alembic's default per-migration transaction so we can use
# CREATE INDEX CONCURRENTLY (Postgres refuses CONCURRENTLY inside a
# transaction block).
def _bootstrap_concurrent_safe() -> None:
    op.execute("COMMIT")   # close alembic's auto-opened transaction


def upgrade() -> None:
    _bootstrap_concurrent_safe()

    # 1. media.report_id — single column.
    op.execute(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS '
        '"ix_media_report_id" ON "media" ("report_id")'
    )

    # 2. media.assembly_status — single column. Useful for ad-hoc
    #    operator queries + the public listing's join filter.
    op.execute(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS '
        '"ix_media_assembly_status" ON "media" ("assembly_status")'
    )

    # 3. Composite partial for the sweep — `abandoned_at IS NULL` is
    #    the discriminator (already-abandoned rows are never re-touched
    #    by Actions ①/②/③/⓪), and `(assembly_status, updated_at,
    #    created_at)` covers the column-ordering for every WHERE clause
    #    in those actions.
    op.execute(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_media_active_sweep" '
        'ON "media" ("assembly_status", "updated_at", "created_at") '
        'WHERE "abandoned_at" IS NULL'
    )


def downgrade() -> None:
    _bootstrap_concurrent_safe()
    # IF EXISTS so a downgrade against a partial-applied state still
    # succeeds. CONCURRENTLY for the same lock-free reason as upgrade.
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS "ix_media_active_sweep"')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS "ix_media_assembly_status"')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS "ix_media_report_id"')
