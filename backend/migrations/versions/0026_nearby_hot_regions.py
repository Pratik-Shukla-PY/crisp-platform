"""nearby_hot_regions — per-region pre-aggregated snapshots

Revision ID: 0026_nearby_hot_regions
Revises: 0025_locations_h3_idx
Create Date: 2026-05-16

Phase 5.1 (docs/NEARBY_REPORTS_PIPELINE.md §9.5) — geospatial scaling
roadmap step G4. Adds the `nearby_hot_regions` table for materialised
per-region /nearby snapshots, used to absorb 1 M+-report regions
under active disaster (UNDP must-have #12).

Design (matches the model in app/models/report.py::NearbyHotRegion):

  - Single regular Postgres table, not a CREATE MATERIALIZED VIEW.
    A regular table is multi-worker-safe, survives instance restarts
    without a REFRESH MATERIALIZED VIEW, and the cache invalidator
    just rewrites the row instead of locking the view.
  - One row per hot region. snapshot_json is JSONB — the literal
    response payload the /nearby endpoint would have computed.
  - refreshed_at + refresh_interval_min let the endpoint decide
    "snapshot fresh enough?" without an external scheduler. Stale
    snapshots fall through to the live aggregator.

OPT-IN:

  The /nearby read path only consults this table when
  CRISP_NEARBY_HOT_REGIONS=1 is set in env. Default deployments stay
  on the live aggregate path — this is a scale-readiness feature,
  not a default behaviour change.

ADMIN SURFACE:

  CRUD + refresh endpoints land in a separate commit
  (api/endpoints/hot_regions.py). They use `require_admin`; rows are
  intentionally NOT public — disclosing where the hot regions are
  configured would leak operator capacity planning.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0026_nearby_hot_regions"
down_revision = "0025_locations_h3_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if "nearby_hot_regions" in existing_tables:
        return
    op.create_table(
        "nearby_hot_regions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=64), unique=True, nullable=False),
        sa.Column("centre_lat", sa.Float(), nullable=False),
        sa.Column("centre_lng", sa.Float(), nullable=False),
        sa.Column("radius_km", sa.Float(), nullable=False, server_default="5.0"),
        sa.Column("refresh_interval_min", sa.Integer(), nullable=False, server_default="15"),
        sa.Column("snapshot_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("refreshed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    op.create_index(
        "ix_nearby_hot_regions_enabled",
        "nearby_hot_regions",
        ["is_enabled"],
    )


def downgrade() -> None:
    op.drop_index("ix_nearby_hot_regions_enabled",
                  table_name="nearby_hot_regions")
    op.drop_table("nearby_hot_regions")
