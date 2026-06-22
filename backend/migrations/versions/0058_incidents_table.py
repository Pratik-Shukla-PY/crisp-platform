"""incidents table + reports.incident_id (Building-centric Incident-Feed redesign Phase 2A)

Revision ID: 0058_incidents_table
Revises: 0057_deletion_reason
Create Date: 2026-06-21 (Building-centric Incident-Feed redesign: first-class Incident entity)

Adds the first-class Incident entity - the operational EVENT that sits between
Building (context) and Report (evidence) in the hierarchy
  Global → Operation → Building → Incident → Report.

This migration is the SCHEMA only (additive + reversible): an `incidents` table
and a nullable, indexed `reports.incident_id` FK (ON DELETE SET NULL). No data
backfill here - legacy reports are seeded into incidents by migration 0059.

Index names mirror the SQLAlchemy model exactly (column index=True →
ix_incidents_building_id / ix_incidents_crisis_event_id / ix_reports_incident_id;
model __table_args__ composites → ix_incidents_building_status /
ix_incidents_crisis_event_status) so an alembic-built schema and a conftest
Base.metadata.create_all() schema are physically identical.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0058_incidents_table"
down_revision: Union[str, Sequence[str], None] = "0057_deletion_reason"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── the incidents table ─────────────────────────────────────────────────
    op.create_table(
        "incidents",
        sa.Column("id", sa.String(length=36), primary_key=True),
        # advisory String(36), NOT an FK - mirrors Report.building_id (must-have
        # #1 parity: an incident must persist even if its building row isn't
        # mirrored yet).
        sa.Column("building_id", sa.String(length=36), nullable=True),
        sa.Column("crisis_event_id", sa.String(length=36),
                  sa.ForeignKey("crisis_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("incident_type", sa.String(length=30), nullable=True),   # crisis_type vocabulary
        sa.Column("severity", sa.String(length=20), nullable=False,
                  server_default="UNKNOWN"),
        sa.Column("severity_overridden", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
        sa.Column("status", sa.String(length=20), nullable=False,
                  server_default="OPEN"),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("lead_report_id", sa.String(length=36), nullable=True),   # non-FK by design
        sa.Column("report_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(length=36),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_incidents_building_id", "incidents", ["building_id"])
    op.create_index("ix_incidents_crisis_event_id", "incidents", ["crisis_event_id"])
    op.create_index("ix_incidents_building_status", "incidents", ["building_id", "status"])
    op.create_index("ix_incidents_crisis_event_status", "incidents", ["crisis_event_id", "status"])

    # ── reports.incident_id - nullable FK (SET NULL), indexed ───────────────
    # Every existing row is NULL, so the FK validates instantly.
    op.add_column("reports", sa.Column("incident_id", sa.String(length=36), nullable=True))
    op.create_index("ix_reports_incident_id", "reports", ["incident_id"])
    op.create_foreign_key(
        "fk_reports_incident_id_incidents", "reports", "incidents",
        ["incident_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_reports_incident_id_incidents", "reports", type_="foreignkey")
    op.drop_index("ix_reports_incident_id", table_name="reports")
    op.drop_column("reports", "incident_id")

    op.drop_index("ix_incidents_crisis_event_status", table_name="incidents")
    op.drop_index("ix_incidents_building_status", table_name="incidents")
    op.drop_index("ix_incidents_crisis_event_id", table_name="incidents")
    op.drop_index("ix_incidents_building_id", table_name="incidents")
    op.drop_table("incidents")
