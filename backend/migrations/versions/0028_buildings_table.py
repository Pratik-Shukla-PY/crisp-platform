"""buildings table + FK from reports - Phase H.1 foundation

Revision ID: 0028_buildings_table
Revises: 0027_building_versioning
Create Date: 2026-05-18

Phase H.1.a (Dashboard audit follow-up, May 2026).

Adds the `buildings` table as the first-class operational entity for
the Building Intelligence & Response Coordination system. Today,
`Report.building_id` is a String FK with no target table; F.5.c
(migration 0027) shipped the version-ordinal columns but the building
itself remained denormalised. The operator wants buildings to behave
as humanitarian-ops entities with state, scores, monitor/responder/
note satellite tables, and AI summaries - see plan H section in
the design plan.

This migration is the FOUNDATION ONLY:

  1. Create the `buildings` table with all cached-roll-up + state +
     score columns (NULLable for now; the H.1.b SQLAlchemy hook will
     keep them current on every Report write).
  2. Create the `building_id_source` enum (OSM | PROXIMITY | MANUAL)
     so we can record the provenance of each building id.
  3. Widen `reports.building_id` from String(36) to String(64) so
     the FK constraint matches Building.id's width (OSM ids can
     exceed 36 chars with extensions; defensive widening).
  4. Backfill one Building row per distinct `Report.building_id`
     value seen in the current data. Cheap fields only:
       - id, id_source (OSM vs PROXIMITY heuristic on the value
         format)
       - osm_way_id (parsed out of `osm:way:<id>` strings)
       - state = 'ACTIVE'
       - report_count from COUNT(reports)
       - first_report_at / latest_report_at from MIN/MAX timestamps
       - centroid_lat / lng from the FIRST report's Location (best-
         available signal until the H.1.c endpoint caches an
         operator-confirmed footprint)
     Scores + severity_max + crisis_types_top3 stay NULL - they get
     populated by the H.1.b `_apply_building_link` hook on the next
     Report INSERT, or by an explicit one-off re-score sweep.
  5. Add FK constraint `fk_reports_building_id` from
     reports.building_id → buildings.id with ON DELETE SET NULL
     (defensive: if a Building is ever hard-purged, the report's
     building_id quietly becomes NULL rather than orphaning the row).
  6. PostGIS `footprint_geom POLYGON(4326)` column + GiST index.
     Probed for PostGIS availability the same way migration 0023
     does - skips the geom + index if the extension isn't installed
     on the cluster (the application layer's polygon-fetch fallback
     handles the missing column).

This migration is INDEPENDENT of any new model code. The Building
SQLAlchemy model + the `_apply_building_link` hook land in H.1.b as
a separate commit; until then the table exists but is read by no
runtime code. Safe to roll back without touching application logic.
"""
from alembic import op
import sqlalchemy as sa


revision = "0028_buildings_table"
down_revision = "0027_building_versioning"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # ── Step 1: create the buildings table ─────────────────────────
    # SQLAlchemy's sa.Enum auto-creates the Postgres ENUM TYPE at
    # table-create time (default create_type=True). No separate
    # DO block needed - the type lifecycle is managed alongside
    # the table.
    op.create_table(
        "buildings",
        # Identity. String(64) accommodates `osm:way:<id>` (longest
        # plausible: ~30 chars) and UUIDs (36 chars) with headroom.
        sa.Column("id", sa.String(64), primary_key=True),

        # Provenance. The H.1.b hook derives this from the id format
        # when populating new rows; the backfill below sets it for
        # existing data.
        sa.Column(
            "id_source",
            sa.Enum("OSM", "PROXIMITY", "MANUAL", name="building_id_source"),
            nullable=False,
            server_default="OSM",
        ),

        # OSM-derived metadata (nullable for proximity-clustered rows).
        sa.Column("osm_way_id", sa.BigInteger, nullable=True),
        sa.Column("osm_node_id", sa.BigInteger, nullable=True),
        sa.Column("osm_name", sa.String(200), nullable=True),
        sa.Column("osm_building_type", sa.String(40), nullable=True),
        sa.Column("osm_addr_full", sa.String(400), nullable=True),

        # Cached footprint (GeoJSON Feature) + centroid. The PostGIS
        # geometry column is added separately below (conditional on
        # the extension being installed).
        sa.Column("footprint_geojson", sa.JSON, nullable=True),
        sa.Column("centroid_lat", sa.Float, nullable=True),
        sa.Column("centroid_lng", sa.Float, nullable=True),

        # Operational state. String(20) rather than a Postgres enum
        # for forward-compatibility with new states (ADD COLUMN ... TYPE
        # ENUM is heavyweight). The H.1.b hook + state-transition
        # endpoint enforce the BuildingStateEnum invariants at the
        # application layer.
        sa.Column("state", sa.String(20), nullable=False,
                  server_default="ACTIVE"),

        # Computed intelligence scores (0–100). All NULLable until the
        # H.1.b hook + initial sweep populate them; NULL means "not
        # yet scored" and the dashboard renders a "-" placeholder.
        sa.Column("severity_score", sa.Float, nullable=True),
        sa.Column("confidence_score", sa.Float, nullable=True),
        sa.Column("activity_score", sa.Float, nullable=True),
        sa.Column("escalation_risk", sa.Float, nullable=True),
        sa.Column("humanitarian_priority", sa.Float, nullable=True),

        # Roll-ups. report_count is the canonical "how many constituent
        # reports does this building have"; the others are filtered
        # sub-counts. All non-null with server_default 0 so a fresh
        # INSERT can omit them.
        sa.Column("report_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("verified_report_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("responding_report_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("resolved_report_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("severity_max", sa.String(20), nullable=True),
        sa.Column("damage_class_max", sa.String(20), nullable=True),
        sa.Column("crisis_types_top3", sa.JSON, nullable=True),
        sa.Column("debris_clearing_needed_count", sa.Integer,
                  nullable=False, server_default="0"),
        sa.Column("estimated_people_affected", sa.Integer, nullable=True),

        # Lifecycle timestamps. first_report_at + latest_report_at are
        # nullable because a Building can in principle exist with zero
        # constituent reports (during the brief window between FK
        # cascade SET NULL and an operator's archive sweep).
        sa.Column("first_report_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("latest_report_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state_changed_by_user_id", sa.String(36), nullable=True),

        # AI summary cache. JSON blob shape documented in the plan file.
        sa.Column("ai_summary", sa.JSON, nullable=True),
        sa.Column("ai_summary_at", sa.DateTime(timezone=True), nullable=True),

        # Soft archive. Set when all constituent reports are deleted
        # within grace - Building survives as a tombstone for audit.
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── Step 2: PostGIS geometry column + GiST index (conditional) ──
    # Probe pg_available_extensions exactly as migration 0023 does.
    # If PostGIS isn't installed the column + index are skipped; the
    # H.1.b application layer detects + degrades to lat/lng-only
    # queries.
    pg_postgis = bind.execute(sa.text(
        "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'"
    )).first()
    if pg_postgis is not None:
        op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        op.execute(
            "ALTER TABLE buildings ADD COLUMN footprint_geom "
            "geometry(POLYGON, 4326)"
        )
        op.execute(
            "CREATE INDEX ix_buildings_footprint_geom "
            "ON buildings USING GIST (footprint_geom)"
        )
    else:
        print(
            "[migration 0028] postgis extension not available - "
            "skipping footprint_geom column + GiST index. Operator-"
            "facing polygon queries will fall through to lat/lng-only "
            "filters until PostGIS is installed."
        )

    # ── Step 3: standard btree indexes ─────────────────────────────
    # state index drives the "show only MONITORED / RESPONDING / ESCALATED"
    # operator queries on the buildings list endpoint.
    op.create_index("ix_buildings_state", "buildings", ["state"])
    # latest_report_at drives "show buildings active in last 24h".
    op.create_index("ix_buildings_latest_report_at", "buildings",
                    ["latest_report_at"])
    # Score-driven sorts on the list endpoint.
    op.create_index("ix_buildings_severity_score", "buildings",
                    ["severity_score"])
    op.create_index("ix_buildings_humanitarian_priority", "buildings",
                    ["humanitarian_priority"])
    # Spatial fallback when PostGIS isn't available.
    op.create_index("ix_buildings_centroid", "buildings",
                    ["centroid_lat", "centroid_lng"])
    # OSM way id lookups (e.g. dashboard "find building by OSM way 123").
    op.create_index("ix_buildings_osm_way_id", "buildings",
                    ["osm_way_id"])

    # ── Step 4: widen reports.building_id to match Building.id width ──
    op.alter_column(
        "reports", "building_id",
        existing_type=sa.String(36),
        type_=sa.String(64),
        existing_nullable=True,
    )

    # ── Step 5: backfill one Building row per distinct id ───────────
    # Single SQL pass to keep the migration atomic. The osm_way_id
    # parsing uses SPLIT_PART; bad-formatted values stay NULL rather
    # than throwing. Centroid comes from the FIRST report's Location
    # (operator-confirmed footprints land via the H.1.c endpoint
    # later; this is a best-available initial seed).
    op.execute("""
        INSERT INTO buildings (
            id,
            id_source,
            osm_way_id,
            state,
            report_count,
            first_report_at,
            latest_report_at,
            centroid_lat,
            centroid_lng
        )
        SELECT
            r.building_id AS id,
            CASE
                WHEN r.building_id LIKE 'osm:%' THEN 'OSM'::building_id_source
                ELSE 'PROXIMITY'::building_id_source
            END AS id_source,
            CASE
                WHEN r.building_id ~ '^osm:way:[0-9]+$'
                    THEN CAST(SPLIT_PART(r.building_id, ':', 3) AS BIGINT)
                ELSE NULL
            END AS osm_way_id,
            'ACTIVE'::varchar AS state,
            COUNT(*) AS report_count,
            MIN(r.server_created_at) AS first_report_at,
            MAX(r.server_created_at) AS latest_report_at,
            AVG(l.latitude) AS centroid_lat,
            AVG(l.longitude) AS centroid_lng
        FROM reports r
        LEFT JOIN locations l ON l.report_id = r.id
        WHERE r.building_id IS NOT NULL
          AND r.deletion_requested_at IS NULL
        GROUP BY r.building_id
        ON CONFLICT (id) DO NOTHING;
    """)

    # ── Step 6: FK constraint reports.building_id → buildings.id ────
    # ON DELETE SET NULL: defensive - if a building is ever hard-
    # purged (admin action), the reports just lose their FK rather
    # than cascade-deleting. Operators can re-link manually.
    op.create_foreign_key(
        "fk_reports_building_id",
        source_table="reports",
        referent_table="buildings",
        local_cols=["building_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    # Drop the FK first so the column type-change in reverse step can
    # complete without constraint violations.
    op.drop_constraint("fk_reports_building_id", "reports", type_="foreignkey")

    # Narrow reports.building_id back to String(36). This will FAIL if
    # any existing row exceeds 36 chars - by design (downgrade should
    # not silently truncate data; operator can resolve by trimming the
    # offending row first).
    op.alter_column(
        "reports", "building_id",
        existing_type=sa.String(64),
        type_=sa.String(36),
        existing_nullable=True,
    )

    op.drop_index("ix_buildings_osm_way_id", table_name="buildings")
    op.drop_index("ix_buildings_centroid", table_name="buildings")
    op.drop_index("ix_buildings_humanitarian_priority", table_name="buildings")
    op.drop_index("ix_buildings_severity_score", table_name="buildings")
    op.drop_index("ix_buildings_latest_report_at", table_name="buildings")
    op.drop_index("ix_buildings_state", table_name="buildings")

    bind = op.get_bind()
    pg_postgis = bind.execute(sa.text(
        "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'"
    )).first()
    if pg_postgis is not None:
        op.execute("DROP INDEX IF EXISTS ix_buildings_footprint_geom")

    op.drop_table("buildings")

    # Drop the enum LAST - Postgres rejects DROP TYPE if any column
    # still references it. After table drop the enum is unreferenced.
    op.execute("DROP TYPE IF EXISTS building_id_source")
