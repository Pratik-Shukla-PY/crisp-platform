"""building_responders + building_monitors - Phase H.3 coordination

Revision ID: 0030_building_responders
Revises: 0029_building_events
Create Date: 2026-05-18

Phase H.3. Two new tables for operator coordination on a building:

  building_responders
    Per-building responder assignments. Each row = one responder
    organisation / team / individual that's been dispatched to (or
    asked to attend) the building. Lifecycle timestamps track
    assigned → dispatched → arrived → cleared.

  building_monitors
    Per-operator watch list. Operators can "watch" a building to get
    notified of new activity / score changes. cleared_at IS NULL =
    actively watching; UNIQUE (building_id, user_id, cleared_at) so a
    user can have at most one active watch per building.

Both tables emit BuildingEvent rows on each lifecycle action (via the
endpoint layer in H.3.c - alembic only creates the structure).
"""
from alembic import op
import sqlalchemy as sa


revision = "0030_building_responders"
down_revision = "0029_building_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "building_responders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "building_id",
            sa.String(64),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "assigned_by_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("responder_name", sa.String(200), nullable=False),
        sa.Column("responder_org", sa.String(200), nullable=True),
        sa.Column("responder_contact", sa.String(200), nullable=True),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("arrived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("eta_minutes", sa.Integer, nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
    )
    op.create_index(
        "ix_building_responders_assigned_at",
        "building_responders",
        ["assigned_at"],
    )

    op.create_table(
        "building_monitors",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "building_id",
            sa.String(64),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text, nullable=True),
    )
    # Partial UNIQUE constraint: a user has at most ONE active watch
    # per building. Postgres-specific syntax via op.execute since
    # SQLAlchemy's UniqueConstraint doesn't easily express "WHERE
    # cleared_at IS NULL".
    op.execute("""
        CREATE UNIQUE INDEX uq_monitor_building_user_active
        ON building_monitors (building_id, user_id)
        WHERE cleared_at IS NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_monitor_building_user_active")
    op.drop_table("building_monitors")
    op.drop_index("ix_building_responders_assigned_at",
                  table_name="building_responders")
    op.drop_table("building_responders")
