"""locations.geocoding_confidence + geocoding_source - text-channel geocode metadata

Revision ID: 0015_geo_conf
Revises: 0014_sat_multi
Create Date: 2026-05-11

Phase 23 - IVR / SMS / WhatsApp transcripts get geocoded text→lat/lng
via messaging_bot/sms/geocoder.py which returns {confidence: str,
source: str}. Previously the confidence/source were discarded after
deriving accuracy_meters; the dashboard couldn't show whether an IVR
report's pin was a high-confidence Mapbox match or a low-confidence
Nominatim fallback.

This migration adds two nullable columns:
  geocoding_confidence - float in [0.0, 1.0] (mapped from "low/med/
                         high" → 0.3/0.6/0.9 by the IVR webhook)
  geocoding_source     - short string: "mapbox" | "nominatim" |
                         "claude-mapbox" | "manual" | …

NULL for GPS-captured PWA / native-app locations (the default).
Idempotent - `IF NOT EXISTS` style guard via inspector check.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0015_geo_conf"
down_revision = "0014_sat_multi"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("locations")}
    if "geocoding_confidence" not in cols:
        op.add_column(
            "locations",
            sa.Column("geocoding_confidence", sa.Float(), nullable=True),
        )
    if "geocoding_source" not in cols:
        op.add_column(
            "locations",
            sa.Column("geocoding_source", sa.String(length=32), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("locations")}
    if "geocoding_source" in cols:
        op.drop_column("locations", "geocoding_source")
    if "geocoding_confidence" in cols:
        op.drop_column("locations", "geocoding_confidence")
