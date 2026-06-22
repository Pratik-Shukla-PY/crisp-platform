"""command center — set-based cascade audit/undo + operation/global AI assessment

Revision ID: 0061_command_center
Revises: 0060_building_assessment
Create Date: 2026-06-21 (Command Center: percolating cascade action layer + AI Analyze)

Additive + reversible:
  - new `cascade_action_log` table: ONE audited, reversible row per set-based scoped
    cascade action (operator acts at Global/Operation/Building -> percolates to every
    incident + report in the slice in one transaction; report_ids snapshots the rows
    changed for a precise Undo);
  - new `scope_assessment` table: operation- and global-scope AI situation
    assessments (the wider-scope analogue of building_assessments).

No data backfill - both tables are populated on demand by the cascade + assess
endpoints.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0061_command_center"
down_revision: Union[str, Sequence[str], None] = "0060_building_assessment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "cascade_action_log",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("scope_type", sa.String(length=16), nullable=False),
        sa.Column("scope_id", sa.String(length=36), nullable=True),
        sa.Column("action", sa.String(length=20), nullable=False),
        sa.Column("filters", sa.JSON(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("reports_changed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("incidents_changed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("buildings_changed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("responders_notified", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("report_ids", sa.JSON(), nullable=True),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("actor_user_id", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("happened_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_cascade_action_log_scope_id", "cascade_action_log", ["scope_id"])
    op.create_index("ix_cascade_action_log_scope",
                    "cascade_action_log", ["scope_type", "scope_id", "happened_at"])

    op.create_table(
        "scope_assessment",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("scope_type", sa.String(length=16), nullable=False),
        sa.Column("scope_id", sa.String(length=36), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("band", sa.String(length=20), nullable=True),
        sa.Column("distribution", sa.JSON(), nullable=True),
        sa.Column("coverage", sa.JSON(), nullable=True),
        sa.Column("situation_summary", sa.Text(), nullable=True),
        sa.Column("key_risks", sa.JSON(), nullable=True),
        sa.Column("escalation_likelihood", sa.JSON(), nullable=True),
        sa.Column("recommended_actions", sa.JSON(), nullable=True),
        sa.Column("priority_score", sa.Integer(), nullable=True),
        sa.Column("resource_recommendations", sa.JSON(), nullable=True),
        sa.Column("model", sa.String(length=60), nullable=True),
        sa.Column("actor_user_id", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_scope_assessment_scope_id", "scope_assessment", ["scope_id"])
    op.create_index("ix_scope_assessment_scope",
                    "scope_assessment", ["scope_type", "scope_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_scope_assessment_scope", table_name="scope_assessment")
    op.drop_index("ix_scope_assessment_scope_id", table_name="scope_assessment")
    op.drop_table("scope_assessment")
    op.drop_index("ix_cascade_action_log_scope", table_name="cascade_action_log")
    op.drop_index("ix_cascade_action_log_scope_id", table_name="cascade_action_log")
    op.drop_table("cascade_action_log")
