"""locations: PostGIS extension + geometry column + GiST index

Revision ID: 0023_postgis_geospatial
Revises: 0022_abuse_appeals
Create Date: 2026-05-16

Phase 5 (docs/NEARBY_REPORTS_PIPELINE.md §9.2) — geospatial scaling
roadmap step G2. Adds:

  • The PostGIS extension (idempotent CREATE EXTENSION IF NOT EXISTS).
    Step G1 of the roadmap.
  • locations.geom (GEOGRAPHY(Point, 4326)) — populated via trigger
    from existing latitude / longitude. Step G2 of the roadmap.
  • A GiST index on the geom column so ST_DWithin queries are
    index-backed.

WHEN DOES THE AGGREGATOR USE THIS?

  Not yet — the aggregator still uses bbox + Python haversine on
  the Float lat/lng columns. This migration ships the SCHEMA + the
  POPULATED COLUMN so a follow-up commit (Phase 5.1) can flip the
  aggregator to ST_DWithin without any data migration. Decoupling
  the schema change from the query change keeps both safe to roll
  back independently.

WHY GEOGRAPHY NOT GEOMETRY?

  Geography type stores lat/lng in degrees + does all distance
  math in metres on the WGS84 ellipsoid — so `ST_DWithin(geom,
  ..., 5000)` is "within 5000 metres" without unit-conversion
  bugs. The roadmap's 500 k-reports-per-crisis scale target wants
  the planner to use the GiST index without per-query coordinate
  transforms, which Geography gives us for free.

If the PostGIS extension is not installable on this Postgres
cluster (some hosted setups disallow CREATE EXTENSION without a
superuser), the migration logs + skips the geom + index steps —
the system continues to function on the bbox + haversine path.
Phase 5.1 is gated on this migration succeeding.
"""
from alembic import op
import sqlalchemy as sa


revision = "0023_postgis_geospatial"
down_revision = "0022_abuse_appeals"
branch_labels = None
depends_on = None


_COL_GEOM = "geom"
_IDX_GEOM = "ix_locations_geom_gist"
_TRG_NAME = "trg_locations_sync_geom"
_TRG_FN = "locations_sync_geom_fn"


def upgrade() -> None:
    bind = op.get_bind()

    # Step G1 — check whether postgis is even available on this
    # cluster before attempting to install. CREATE EXTENSION inside
    # the alembic transaction would abort the txn if the extension
    # binary isn't present, leaving us unable to mark the migration
    # complete. Probe via pg_available_extensions FIRST.
    avail = bind.execute(
        sa.text(
            "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'"
        )
    ).first()
    if avail is None:
        # No PostGIS binary installed on this Postgres cluster. The
        # Phase 5.1 aggregator switch detects missing geom column +
        # stays on the bbox + haversine path. Migration is a recorded
        # no-op so alembic's version table advances cleanly.
        print(
            "[migration 0023] postgis extension not available — "
            "skipping geom column + GiST index. Aggregator stays on "
            "the bbox + haversine path (Phase 5.1 detects + degrades)."
        )
        return

    # PostGIS available → install + add geom column + trigger + index.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("locations")}

    if _COL_GEOM not in existing_cols:
        op.execute(
            "ALTER TABLE locations "
            "ADD COLUMN geom GEOGRAPHY(Point, 4326) "
        )
        # Backfill from existing lat/lng. NULL-safe: rows without
        # a lat/lng (shouldn't exist per schema but be safe) keep
        # NULL geom.
        op.execute(
            "UPDATE locations "
            "SET geom = ST_SetSRID("
            "  ST_MakePoint(longitude, latitude), 4326"
            ")::geography "
            "WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
        )

    # Keep geom in sync via trigger so future inserts / updates
    # don't need the application layer to know about PostGIS.
    op.execute(f"""
        CREATE OR REPLACE FUNCTION {_TRG_FN}()
        RETURNS trigger AS $$
        BEGIN
            IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
                NEW.geom := ST_SetSRID(
                    ST_MakePoint(NEW.longitude, NEW.latitude), 4326
                )::geography;
            ELSE
                NEW.geom := NULL;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute(f"""
        DROP TRIGGER IF EXISTS {_TRG_NAME} ON locations;
        CREATE TRIGGER {_TRG_NAME}
        BEFORE INSERT OR UPDATE OF latitude, longitude ON locations
        FOR EACH ROW EXECUTE FUNCTION {_TRG_FN}();
    """)

    # GiST index for fast ST_DWithin lookups.
    existing_idx = {idx["name"] for idx in inspector.get_indexes("locations")}
    if _IDX_GEOM not in existing_idx:
        op.execute(f"""
            CREATE INDEX IF NOT EXISTS {_IDX_GEOM}
            ON locations USING GIST (geom)
        """)


def downgrade() -> None:
    # Drop the index + trigger + column. Extension stays (other
    # tables may reference it; dropping it would cascade).
    op.execute(f"DROP TRIGGER IF EXISTS {_TRG_NAME} ON locations")
    op.execute(f"DROP FUNCTION IF EXISTS {_TRG_FN}()")
    op.execute(f"DROP INDEX IF EXISTS {_IDX_GEOM}")
    op.execute("ALTER TABLE locations DROP COLUMN IF EXISTS geom")
