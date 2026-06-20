"""Incident Intelligence P3 - report_duplicate_decisions (analyst dedup decisions)

Revision ID: 0054_report_duplicate_decisions
Revises: 0053_collapse_operation_status
Create Date: 2026-06-16 (Incident Intelligence: building clustering + duplicate surfacing)

Append-only, reversible log of analyst duplicate decisions within an incident
cluster: CONFIRMED_DUP / NOT_DUP (an unordered report pair) + SET_PRIMARY (one
report = the cluster's primary). The within-cluster duplicate scorer HONORS the
latest active (undone_at IS NULL) decision for a pair: NOT_DUP suppresses
re-flagging, CONFIRMED_DUP pins it. Undo sets undone_at (audit trail kept, like
operation_claim_log / BuildingEvent house style). Purely additive - no backfill.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0054_report_duplicate_decisions"
down_revision: Union[str, Sequence[str], None] = "0053_collapse_operation_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_duplicate_decisions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        # building_id or 'h3:<idx>' - the cluster this decision scopes to.
        sa.Column("cluster_key", sa.String(length=80), nullable=False),
        sa.Column("primary_report_id", sa.String(length=36),
                  sa.ForeignKey("reports.id", ondelete="CASCADE"), nullable=False),
        # the OTHER report in the pair (CONFIRMED_DUP / NOT_DUP); NULL for SET_PRIMARY.
        sa.Column("related_report_id", sa.String(length=36),
                  sa.ForeignKey("reports.id", ondelete="CASCADE"), nullable=True),
        sa.Column("decision", sa.String(length=20), nullable=False),   # CONFIRMED_DUP | NOT_DUP | SET_PRIMARY
        sa.Column("actor_user_id", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_rdd_cluster", "report_duplicate_decisions",
                    ["cluster_key", "undone_at"])
    op.create_index("ix_rdd_primary", "report_duplicate_decisions", ["primary_report_id"])
    op.create_index("ix_rdd_related", "report_duplicate_decisions", ["related_report_id"])


def downgrade() -> None:
    op.drop_index("ix_rdd_related", table_name="report_duplicate_decisions")
    op.drop_index("ix_rdd_primary", table_name="report_duplicate_decisions")
    op.drop_index("ix_rdd_cluster", table_name="report_duplicate_decisions")
    op.drop_table("report_duplicate_decisions")
