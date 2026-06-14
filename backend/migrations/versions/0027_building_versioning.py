"""building_version_ordinal + building_is_latest - UNDP must-have #8

Revision ID: 0027_building_versioning
Revises: 0026_nearby_hot_regions
Create Date: 2026-05-18

Phase F.5.c (Dashboard-audit batch, May 2026).

`the project invariants` declares UNDP must-have #8 as a never-regress invariant:

  > 8. Building versioning - multiple reports for same building_id
  >    bias to latest COMPLETE; older versions kept for audit
  >    (building_version_ordinal, building_is_latest).

Reality at audit time: the `reports` table carried `building_id` (FK
to the OSM way id) but had no version ordinal or "is latest" flag.
The dashboard reconstructed "latest version" by sorting reports per
building on the fly - which means under high concurrency two analysts
could pick different "latest" versions, and the operator-facing chip
"Version 3 of 7 · Latest" had no canonical column to read from.

This migration:

  1. Adds the two columns:
       - `building_version_ordinal` INTEGER, nullable (NULL for rows
         without a building_id, which is the dominant case in the
         current corpus - only PWA reports that tapped an OSM
         footprint carry a building_id).
       - `building_is_latest` BOOLEAN, default false, server_default
         'false', NOT NULL. We default to false so the backfill below
         can flip exactly one row per (building_id) group atomically;
         a NULL-default would force a special "unfilled" state to
         coexist with real values.

  2. Adds an index on `(building_id, building_is_latest)` so the
     dashboard's frequent "latest version of this building" lookup
     is O(log n) rather than a partition scan.

  3. Backfills existing rows with a single window-function UPDATE:
       - ROW_NUMBER() OVER (PARTITION BY building_id ORDER BY
         server_created_at ASC, id ASC) → ordinal (1-indexed).
       - The MAX(ordinal) per group → that row's `building_is_latest`
         flips to true.
     Rows with `building_id IS NULL` are untouched (ordinal stays
     NULL; is_latest stays false). Idempotent: running this multiple
     times re-stamps to the same values.

The companion SQLAlchemy hook + schema change land in a follow-up
commit (NOT this migration) so the rollback story stays linear:
  - This migration is the ONLY DB-shape change for F.5.c
  - The model + hook + dashboard wiring update is purely Python
    + JS
  - If the dashboard wiring needs revert, the columns can stay
    populated harmlessly (no app reads them yet)

Risk:
  - The backfill is a single transactional UPDATE wrapped in
    op.execute(); on a 500k-report DB it should complete in <10 s.
    For larger corpuses (millions), the batched-update pattern from
    migration 0024 should be templated in - not needed here yet.
  - Composite index on (building_id, building_is_latest) is < 1MB
    per million rows; safe.
"""
from alembic import op
import sqlalchemy as sa


revision = "0027_building_versioning"
down_revision = "0026_nearby_hot_regions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add the two columns. building_version_ordinal stays nullable
    #    (a NULL means "no building_id, no ordinal"); building_is_latest
    #    is NOT NULL with a server-side default of false so the backfill
    #    is just an UPDATE rather than an UPDATE-then-ALTER-COLUMN-SET-
    #    NOT-NULL two-step that would temporarily violate the schema.
    op.add_column(
        "reports",
        sa.Column("building_version_ordinal", sa.Integer(), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column(
            "building_is_latest",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # 2. Composite index - the typical query is
    #      SELECT * FROM reports WHERE building_id = ? AND building_is_latest;
    #    so the index leads with building_id (the high-selectivity
    #    column) and tails with the boolean. Partial index on
    #    is_latest=true would be smaller still but harder to use
    #    when the dashboard also wants the full version list
    #    (Version 3 of 7) - the regular composite covers both queries.
    op.create_index(
        "ix_reports_building_latest",
        "reports",
        ["building_id", "building_is_latest"],
        unique=False,
    )

    # 3. Backfill - single transactional UPDATE using ROW_NUMBER over
    #    each building_id partition, ordered by server_created_at then
    #    id (deterministic tie-breaker when two reports share an
    #    identical timestamp). Two passes:
    #      a) assign ordinals to every row in a non-NULL building_id
    #         partition
    #      b) flip building_is_latest=true on the row whose ordinal
    #         equals the partition's max
    #    Rows without a building_id stay ordinal=NULL, is_latest=false.
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY building_id
                    ORDER BY server_created_at ASC, id ASC
                ) AS ord,
                COUNT(*) OVER (PARTITION BY building_id) AS total
            FROM reports
            WHERE building_id IS NOT NULL
        )
        UPDATE reports r
        SET building_version_ordinal = ranked.ord,
            building_is_latest = (ranked.ord = ranked.total)
        FROM ranked
        WHERE r.id = ranked.id;
        """
    )


def downgrade() -> None:
    # Drop the index first, then the columns. The server_default on
    # building_is_latest is implicit-dropped with the column.
    op.drop_index("ix_reports_building_latest", table_name="reports")
    op.drop_column("reports", "building_is_latest")
    op.drop_column("reports", "building_version_ordinal")
