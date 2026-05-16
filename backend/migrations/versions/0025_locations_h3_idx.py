"""locations.h3_idx + index — H3 hexagonal indexing scaffold

Revision ID: 0025_locations_h3_idx
Revises: 0024_device_telemetry_summary
Create Date: 2026-05-16

Phase 5.1 (docs/NEARBY_REPORTS_PIPELINE.md §9.4) — geospatial scaling
roadmap step G3. Adds:

  • `locations.h3_idx VARCHAR(16)` — nullable. Stores the H3 resolution-9
    cell index (~175 m hex edge, ~110k m² area) for the row's
    latitude / longitude. Populated app-side at report creation; rows
    that predate the backfill stay NULL.

  • B-tree index `ix_locations_h3_idx` so a `WHERE h3_idx IN (cells)`
    query against the centre cell + 1-ring neighbours is an indexed
    lookup.

The aggregator only consumes this column when CRISP_NEARBY_H3_MODE=1
AND the h3 Python wheel is installed. The default path stays bbox +
ST_DWithin (Phase G1 / G2) — H3 is the next-tier-up perf knob the
operator flips when /nearby p95 > 500 ms with PostGIS in play
(§9.6 trigger table).

WHY APP-SIDE POPULATION INSTEAD OF A PG TRIGGER?

  - PostgreSQL needs the `h3-pg` extension for a server-side trigger;
    bundling another C extension on top of PostGIS is a big install-
    footprint commitment. App-side computation works on every
    Postgres cluster.
  - Backfilling a billion-row table mid-migration is risky. Doing it
    app-side lets ops batch-backfill with a separate script + control
    the rate.

BACKFILL:

  Existing rows stay NULL. Run
      python -m app.scripts.backfill_locations_h3 [--batch=10000]
  (separate followup) to populate them. The /nearby H3 path
  transparently falls back to ST_DWithin / bbox for any candidate row
  whose h3_idx is NULL — so a partial backfill is safe; you just don't
  get the H3 perf win for the un-backfilled rows.
"""
from alembic import op
import sqlalchemy as sa


revision = "0025_locations_h3_idx"
down_revision = "0024_device_telemetry_summary"
branch_labels = None
depends_on = None


_COL_NAME = "h3_idx"
_IDX_NAME = "ix_locations_h3_idx"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("locations")}
    if _COL_NAME not in existing_cols:
        op.add_column(
            "locations",
            sa.Column(_COL_NAME, sa.String(length=16), nullable=True),
        )
    existing_idx = {i["name"] for i in inspector.get_indexes("locations")}
    if _IDX_NAME not in existing_idx:
        op.create_index(_IDX_NAME, "locations", [_COL_NAME])


def downgrade() -> None:
    op.drop_index(_IDX_NAME, table_name="locations")
    op.drop_column("locations", _COL_NAME)
