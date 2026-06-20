"""Capture an operator-supplied deletion reason (compliance audit)

Revision ID: 0057_deletion_reason
Revises: 0056_drop_dead_aianalysis_and_clusters
Create Date: 2026-06-20 (Actions section redesign - Delete with reason)

The Delete action now opens a high-severity confirmation that captures WHY a
report was deleted. Persist that rationale on the deletion audit row for
compliance. Additive + nullable -> no backfill, no impact on existing rows.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0057_deletion_reason"
down_revision: Union[str, Sequence[str], None] = "0056_drop_dead_ai_clusters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("deletion_audit_log", sa.Column("deletion_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("deletion_audit_log", "deletion_reason")
