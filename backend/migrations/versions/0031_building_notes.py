"""building_notes — Phase H.4 operator notes thread

Revision ID: 0031_building_notes
Revises: 0030_building_responders
Create Date: 2026-05-18

Per-building notes thread written by operators. Notes are the long-
form context channel that BuildingEvent (audit log) and Building.ai_summary
(machine-generated brief) deliberately don't try to be — free text,
pinnable, edit + soft-delete + visibility ENUM (ALL_OPERATORS vs
ADMIN_ONLY).

Storage is intentionally thin: rows just sit on the building, ordered
by created_at DESC + pinned-first. There is no thread / parent_id —
each note stands alone. If conversational replies become a real need
they get layered on top later (out-of-scope this round).
"""
from alembic import op
import sqlalchemy as sa


revision = "0031_building_notes"
down_revision = "0030_building_responders"
branch_labels = None
depends_on = None


# The visibility ENUM gates ADMIN_ONLY notes from non-admin operators.
# sa.Enum will auto-create the Postgres type at table-create time;
# no DO-block needed (avoids the duplicate-type collision seen in
# migrations 0028 / 0029 retros).
_visibility_enum = sa.Enum(
    "ALL_OPERATORS", "ADMIN_ONLY",
    name="building_note_visibility",
)


def upgrade() -> None:
    op.create_table(
        "building_notes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "building_id",
            sa.String(64),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "author_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column(
            "visibility",
            _visibility_enum,
            nullable=False,
            server_default="ALL_OPERATORS",
        ),
        sa.Column(
            "pinned",
            sa.Boolean,
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Composite index — the timeline query is always
    # "for building X, give me pinned notes first, then by created_at desc".
    op.create_index(
        "ix_building_notes_building_pinned_created",
        "building_notes",
        ["building_id", "pinned", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_building_notes_building_pinned_created",
        table_name="building_notes",
    )
    op.drop_table("building_notes")
    # Drop the ENUM type so a future re-create doesn't trip the
    # "type already exists" error. sa.Enum auto-create at upgrade
    # doesn't auto-drop on downgrade.
    op.execute("DROP TYPE IF EXISTS building_note_visibility")
