"""building assessments + building confidence cache (Building as a first-class operational entity)

Revision ID: 0060_building_assessment
Revises: 0059_backfill_incidents
Create Date: 2026-06-21 (Building-level Assessment / Report / cascade Actions)

Additive + reversible:
  - new `building_assessments` table (append-only history of building-level AI
    assessment runs: the consolidated confidence roll-up + per-incident breakdown);
  - two denormalised cache columns on `buildings` (`building_confidence_score`,
    `building_assessment_at`) for the hot list/detail read path.

No data backfill - the table is populated on demand by POST /buildings/{id}/assess.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0060_building_assessment"
down_revision: Union[str, Sequence[str], None] = "0059_backfill_incidents"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "building_assessments",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("building_id", sa.String(length=64),
                  sa.ForeignKey("buildings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("building_confidence_score", sa.Float(), nullable=True),
        sa.Column("building_confidence_band", sa.String(length=20), nullable=True),
        sa.Column("incident_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("assessed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("queued_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recommendation", sa.String(length=40), nullable=True),
        sa.Column("per_incident", sa.JSON(), nullable=True),
        sa.Column("distribution", sa.JSON(), nullable=True),
        sa.Column("actor_user_id", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    # Index names mirror the model (column index=True → ix_<table>_<col>) so the
    # conftest create_all schema and the migration agree.
    op.create_index("ix_building_assessments_building_id", "building_assessments", ["building_id"])
    op.create_index("ix_building_assessments_created_at", "building_assessments", ["created_at"])
    op.create_index("ix_building_assessments_building_created",
                    "building_assessments", ["building_id", "created_at"])

    op.add_column("buildings", sa.Column("building_confidence_score", sa.Float(), nullable=True))
    op.add_column("buildings", sa.Column("building_assessment_at",
                  sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("buildings", "building_assessment_at")
    op.drop_column("buildings", "building_confidence_score")
    op.drop_index("ix_building_assessments_building_created", table_name="building_assessments")
    op.drop_index("ix_building_assessments_created_at", table_name="building_assessments")
    op.drop_index("ix_building_assessments_building_id", table_name="building_assessments")
    op.drop_table("building_assessments")
