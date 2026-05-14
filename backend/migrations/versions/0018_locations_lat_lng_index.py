"""locations: composite (latitude, longitude) index for nearby-reports bbox queries

Revision ID: 0018_locations_lat_lng_index
Revises: 0017_full_asset_checksum
Create Date: 2026-05-14

The "Verified Reports Nearby" feature (/api/v1/reports/nearby) does a
bounding-box pre-filter on Location.latitude + Location.longitude
BEFORE running haversine. Without an index that pre-filter is a full
table scan on `locations`, which scales to ~O(n) per query — exactly
what we want to avoid for the home-stage poll path (one request per
boot per device).

A composite btree on (latitude, longitude) lets Postgres handle the
`BETWEEN ... AND ...` on the leading column directly via index range
scan, then narrow with the trailing column. For a 5 km radius query
in a city with 50k reports, this drops the query from a 50k-row scan
to ~50-500 candidates (the bbox).

Phase 3 (post-submission) will swap this for a PostGIS GIST index +
ST_DWithin — better for true radius (vs bbox) but requires the
PostGIS extension. This btree is the pre-PostGIS speedup that gets
us through the UNDP demo deadline.

Idempotent — `CREATE INDEX IF NOT EXISTS` semantics via the inspector
guard pattern used in 0013_push_subscriptions / 0015_geo_conf /
0017_full_asset_checksum.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0018_locations_lat_lng_index"
down_revision = "0017_full_asset_checksum"
branch_labels = None
depends_on = None


_INDEX_NAME = "ix_locations_lat_lng"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {idx["name"] for idx in inspector.get_indexes("locations")}
    if _INDEX_NAME in existing:
        return
    op.create_index(
        _INDEX_NAME,
        "locations",
        ["latitude", "longitude"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {idx["name"] for idx in inspector.get_indexes("locations")}
    if _INDEX_NAME not in existing:
        return
    op.drop_index(_INDEX_NAME, table_name="locations")
