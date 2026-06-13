"""Phase 3 — operation_claim_log (reversible cluster-claim audit / undo trail)

Revision ID: 0050_operation_claim_log
Revises: 0049_building_responder_phase3
Create Date: 2026-06-13 (Operations redesign Phase 3c)

Append-only log of "Claim (with undo)" actions: launching an operation from the
un-operationalised critical cluster bulk-claims reports (sets crisis_event_id);
each CLAIMED row snapshots exactly which report ids were claimed so the action is
reversible (UNCLAIMED un-sets them). A dedicated table — NOT DeletionAuditLog
(anonymized + non-reversible, wrong semantics) — keyed by operation for cheap undo
lookups; mirrors the BuildingEvent append-only/event_kind house style.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0050_operation_claim_log"
down_revision: Union[str, Sequence[str], None] = "0049_building_responder_phase3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "operation_claim_log",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("operation_id", sa.String(length=36),
                  sa.ForeignKey("crisis_events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_kind", sa.String(length=16), nullable=False),   # CLAIMED | UNCLAIMED
        sa.Column("report_ids", sa.JSON(), nullable=False),
        sa.Column("report_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("actor_user_id", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("happened_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_operation_claim_log_op", "operation_claim_log",
                    ["operation_id", "happened_at"])


def downgrade() -> None:
    op.drop_index("ix_operation_claim_log_op", table_name="operation_claim_log")
    op.drop_table("operation_claim_log")
