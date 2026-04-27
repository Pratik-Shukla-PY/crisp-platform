"""satellite_verifications.satellite_images_json — multi-provider fan-out

Revision ID: 0014_sat_multi
Revises: 0013_push_subs
Create Date: 2026-04-27

Apr 2026 — adds JSON list of every satellite-provider image returned
by the multi-source fan-out. Lets the dashboard render a 2×2 grid
showing AWS Sentinel-2, Microsoft Planetary Computer, ESA Copernicus,
and Mapbox results side-by-side instead of a single primary image.

Idempotent — `IF NOT EXISTS` style guard via inspector check.
Backward compatible — column is nullable, existing rows simply have
NULL until they're re-verified.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0014_sat_multi"
down_revision = "0013_push_subs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("satellite_verifications")}
    if "satellite_images_json" not in cols:
        op.add_column(
            "satellite_verifications",
            sa.Column("satellite_images_json", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("satellite_verifications")}
    if "satellite_images_json" in cols:
        op.drop_column("satellite_verifications", "satellite_images_json")
