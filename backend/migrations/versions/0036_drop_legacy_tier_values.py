"""drop_legacy_tier_values — Phase L L.1b cleanup

Revision ID: 0036_drop_legacy_tier_values
Revises: 0035_resolution_tier_canonical
Create Date: 2026-05-20

Removes the legacy LOW + HIGH values from the `resolutionenum` Postgres
enum type. Pre-Phase-L vocabulary was LOW/MEDIUM/HIGH/ORIGINAL; alembic
0035 added SMALL + backfilled rows (LOW → SMALL, HIGH → ORIGINAL). This
migration finalises the cleanup by dropping the unused legacy values
from the enum type so the application layer's vocabulary == DB layer's
vocabulary (SMALL / MEDIUM / ORIGINAL — three values, no aliases).

Postgres doesn't support ``ALTER TYPE … DROP VALUE``. Standard recipe:

  1. Rename the existing type to a temp name
  2. Create a fresh enum type with only the canonical values
  3. Alter every column using the old type to use the new type
     (string cast via the canonical values is safe because
     alembic 0035 already eliminated LOW/HIGH rows)
  4. Drop the temp type

Pre-condition: SELECT count(*) FROM media WHERE resolution_tier IN
('LOW', 'HIGH') = 0. Verified by inspecting the dev + test DBs post-
0035; the operator's wiped dev DB has 6 SMALL / 5 MEDIUM / 3 ORIGINAL
and crisp_test resets per-test.

If a row referencing LOW or HIGH somehow survived 0035 (e.g. an
in-flight insert during deploy), the ALTER COLUMN cast at step 3
will fail loudly and the migration aborts — operator must investigate
+ either re-run 0035 or hand-patch the row before retrying.
"""
from alembic import op
import sqlalchemy as sa


revision = "0036_drop_legacy_tier_values"
down_revision = "0035_resolution_tier_canonical"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect != "postgresql":
        # SQLite and other dialects don't have first-class enum types;
        # the rename is a no-op there. Application-layer Pydantic
        # validation rejects LOW/HIGH for new writes regardless.
        return

    # Safety check: ensure no legacy rows survived 0035 before we
    # collapse the type. If this raises, operator re-runs 0035 or
    # hand-patches the offending rows.
    legacy_count = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM media "
            "WHERE resolution_tier IN ('LOW', 'HIGH')"
        )
    ).scalar()
    if legacy_count and legacy_count > 0:
        raise RuntimeError(
            f"alembic 0036 refuses to run: {legacy_count} media row(s) "
            "still reference legacy LOW/HIGH tiers. Re-run 0035 to "
            "backfill or hand-patch before retrying."
        )

    # Step 1: rename current enum so we can shadow it.
    op.execute("ALTER TYPE resolutionenum RENAME TO resolutionenum_legacy")

    # Step 2: create fresh canonical enum.
    op.execute(
        "CREATE TYPE resolutionenum AS ENUM ('SMALL', 'MEDIUM', 'ORIGINAL')"
    )

    # Step 3: switch the media.resolution_tier column to the new type.
    # USING clause does a text-cast round-trip; safe because no row
    # carries LOW or HIGH at this point.
    op.execute(
        "ALTER TABLE media "
        "ALTER COLUMN resolution_tier DROP DEFAULT, "
        "ALTER COLUMN resolution_tier TYPE resolutionenum "
        "USING resolution_tier::text::resolutionenum, "
        "ALTER COLUMN resolution_tier SET DEFAULT 'SMALL'"
    )

    # Step 4: drop the now-unused legacy enum type.
    op.execute("DROP TYPE resolutionenum_legacy")


def downgrade() -> None:
    # Adding LOW + HIGH back to the enum is mechanically possible
    # (ALTER TYPE … ADD VALUE) but pointless — the rows that previously
    # held those values have already been backfilled to SMALL/ORIGINAL
    # by 0035, so a downgrade can't restore the original data. Restore
    # from backup if you need to revert further than 0035.
    raise RuntimeError(
        "0036_drop_resolution_legacy_aliases is forward-only. "
        "Operator must restore from backup to revert."
    )
