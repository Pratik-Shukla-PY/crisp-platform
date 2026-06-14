"""geocode_cache - persistent cache for reverse + forward geocoding

Revision ID: 0043_geocode_cache
Revises: 0042_media_final_face_boxes
Create Date: 2026-05-25

Backs the new `POST /api/v1/reports/geocode/reverse` route + tightens
the existing `/geocode/describe` forward path: every Mapbox /
Nominatim result is persisted here keyed by direction + rounded
lat/lng + language, with a 7-day TTL.

Why this matters at UNDP scale (must-have #12, 500k reports / crisis):
the Nominatim public service caps third-party apps at ≤ 1 req/s and
explicitly asks heavy users to cache results. Without a persistent
cache, every PWA "Refresh GPS" tap would re-hit the upstream cold.
With it, hot neighbourhoods (the ones where a crisis is unfolding)
resolve from this table in ~3 ms after the first warm-up.

Cache hit semantics:
  WHERE direction = ?
    AND lat_key = ?       -- rounded to 4 decimal places (≈11 m)
    AND lng_key = ?
    AND language = ?
    AND expires_at > now()

Downgrade drops the table; loses the cache but doesn't break any
fetch path - geocoder.py falls through to live Mapbox / Nominatim
calls when the table is empty.
"""

import sqlalchemy as sa
from alembic import op

revision = "0043_geocode_cache"
down_revision = "0042_media_final_face_boxes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "geocode_cache",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("direction", sa.String(length=8), nullable=False),
        sa.Column("lat_key", sa.Float(), nullable=False),
        sa.Column("lng_key", sa.Float(), nullable=False),
        sa.Column("language", sa.String(length=8), nullable=False,
                  server_default="en"),
        sa.Column("location_name", sa.String(length=256), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Hot lookup - 4-col composite covers both reverse + forward
    # query shapes (forward uses hash(text) in lat_key, 0 in lng_key).
    op.create_index(
        "ix_geocode_cache_lookup",
        "geocode_cache",
        ["direction", "lat_key", "lng_key", "language"],
        unique=False,
    )
    # Eviction sweep: WHERE expires_at < now().
    op.create_index(
        "ix_geocode_cache_expires",
        "geocode_cache",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_geocode_cache_expires", table_name="geocode_cache")
    op.drop_index("ix_geocode_cache_lookup", table_name="geocode_cache")
    op.drop_table("geocode_cache")
