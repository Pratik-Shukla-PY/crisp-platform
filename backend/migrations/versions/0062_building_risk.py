"""building risk score — one consolidated act-first metric (+ factor breakdown)

Revision ID: 0062_building_risk
Revises: 0061_command_center
Create Date: 2026-06-21 (consolidate the building console into ONE Building Risk Score)

Additive + reversible: the consolidated Building RISK score (fuses severity + the
aggregated incident credibility + corroboration/evidence/recency) and its transparent
factor breakdown. The legacy building_confidence_score + humanitarian_priority columns
are KEPT (back-compat + hot-list sorting); only their on-console display is removed.

  - buildings: building_risk_score (int) + building_risk_band (denormalised cache);
  - building_assessments: building_risk_score + building_risk_band + risk_factors (JSON).

No backfill - populated on the next POST /buildings/{id}/assess run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0062_building_risk"
down_revision: Union[str, Sequence[str], None] = "0061_command_center"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("buildings", sa.Column("building_risk_score", sa.Integer(), nullable=True))
    op.add_column("buildings", sa.Column("building_risk_band", sa.String(length=20), nullable=True))
    op.add_column("building_assessments", sa.Column("building_risk_score", sa.Integer(), nullable=True))
    op.add_column("building_assessments", sa.Column("building_risk_band", sa.String(length=20), nullable=True))
    op.add_column("building_assessments", sa.Column("risk_factors", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("building_assessments", "risk_factors")
    op.drop_column("building_assessments", "building_risk_band")
    op.drop_column("building_assessments", "building_risk_score")
    op.drop_column("buildings", "building_risk_band")
    op.drop_column("buildings", "building_risk_score")
