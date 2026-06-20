"""Incident redesign - persist reviewer identity (reports.reviewed_by)

Revision ID: 0055_report_reviewed_by
Revises: 0054_report_duplicate_decisions
Create Date: 2026-06-19 (Incident Details panel redesign, Phase A)

The report row stamped reviewed_at + reviewer_verdict but never WHO recorded the
verdict, so the per-incident audit ribbon could only say "reviewer not recorded".
Add a nullable reviewed_by FK to users.id (ON DELETE SET NULL, mirroring user_id)
so deleting an operator account never orphans or destroys the report. Additive +
nullable -> no backfill, no impact on existing rows or must-have #1 parity.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0055_report_reviewed_by"
down_revision: Union[str, Sequence[str], None] = "0054_report_duplicate_decisions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("reviewed_by", sa.String(length=36), nullable=True))
    op.create_foreign_key(
        "fk_reports_reviewed_by_users",
        "reports",
        "users",
        ["reviewed_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_reports_reviewed_by_users", "reports", type_="foreignkey")
    op.drop_column("reports", "reviewed_by")
