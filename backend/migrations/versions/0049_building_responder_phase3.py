"""Phase 3 — extend building_responders for operation-level + org-typed responders

Revision ID: 0049_building_responder_phase3
Revises: 0048_crisis_event_idx
Create Date: 2026-06-13 (Operations redesign Phase 3a)

Option B of the Operations redesign: a responder can now target an OPERATION
(CrisisEvent) as well as a building, with NO separate Team/Org entity.
  - crisis_event_id : the operation this responder serves (NULL for building rows)
  - target_type     : BUILDING | OPERATION (legacy rows backfilled to BUILDING)
  - org_type        : GOV | NGO | VOLUNTEER | INTERNAL | OTHER (app-validated vocab)
  - building_id relaxed to nullable so OPERATION-target rows need no phantom building

All additive-nullable (metadata-only on Postgres — no table rewrite). The
backfill UPDATE + the building_id nullable relax are safe inline: the responder
roster is small (operator-assigned), not report-scale.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0049_building_responder_phase3"
down_revision: Union[str, Sequence[str], None] = "0048_crisis_event_idx"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("building_responders",
                  sa.Column("crisis_event_id", sa.String(length=36), nullable=True))
    op.add_column("building_responders",
                  sa.Column("target_type", sa.String(length=16), nullable=True))
    op.add_column("building_responders",
                  sa.Column("org_type", sa.String(length=16), nullable=True))
    op.create_foreign_key(
        "fk_building_responders_crisis_event_id", "building_responders",
        "crisis_events", ["crisis_event_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_building_responders_crisis_event_id",
                    "building_responders", ["crisis_event_id"])
    # Every pre-existing responder is building-targeted.
    op.execute("UPDATE building_responders SET target_type = 'BUILDING' "
               "WHERE target_type IS NULL")
    # building_id is no longer mandatory (OPERATION-target rows carry none).
    op.alter_column("building_responders", "building_id",
                    existing_type=sa.String(length=64), nullable=True)


def downgrade() -> None:
    # NOTE forward-only caveat: re-imposing NOT NULL fails if any OPERATION-target
    # rows (building_id NULL) exist. Acceptable for Phase 3.
    op.alter_column("building_responders", "building_id",
                    existing_type=sa.String(length=64), nullable=False)
    op.drop_index("ix_building_responders_crisis_event_id", table_name="building_responders")
    op.drop_constraint("fk_building_responders_crisis_event_id",
                       "building_responders", type_="foreignkey")
    op.drop_column("building_responders", "org_type")
    op.drop_column("building_responders", "target_type")
    op.drop_column("building_responders", "crisis_event_id")
