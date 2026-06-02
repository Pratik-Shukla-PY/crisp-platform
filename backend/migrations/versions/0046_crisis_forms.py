"""Dynamic Crisis Forms — geo-scoped Stage 2/3 question packs

Adds three new tables (crisis_form_packs, crisis_form_pack_versions,
crisis_events) and four ADDITIVE nullable columns on reports
(crisis_event_id, form_pack_id, form_pack_version, form_data).

All additive + nullable → safe online migration: no backfill, no table
rewrite, no lock churn. Existing rows + every report captured outside an
active crisis zone leave the new columns NULL and use the standard flat-enum
schema, so the default flow + multi-channel parity (must-have #1) are unchanged.

Revision ID: 0046_crisis_forms
Revises: 0045_media_watermark
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa

revision = "0046_crisis_forms"
down_revision = "0045_media_watermark"
branch_labels = None
depends_on = None


def upgrade():
    # ── crisis_form_packs ─────────────────────────────────────────────────
    op.create_table(
        "crisis_form_packs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("crisis_type", sa.String(length=30), nullable=True),
        sa.Column("active_version", sa.Integer(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("key", name="uq_crisis_form_packs_key"),
    )
    op.create_index("ix_crisis_form_packs_crisis_type", "crisis_form_packs", ["crisis_type"])

    # ── crisis_form_pack_versions ─────────────────────────────────────────
    op.create_table(
        "crisis_form_pack_versions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("pack_id", sa.String(length=36), sa.ForeignKey("crisis_form_packs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'draft'")),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("pack_id", "version", name="uq_crisis_pack_version"),
    )
    op.create_index("ix_crisis_pack_versions_lookup", "crisis_form_pack_versions", ["pack_id", "status"])

    # ── crisis_events ─────────────────────────────────────────────────────
    op.create_table(
        "crisis_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("crisis_type", sa.String(length=30), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default=sa.text("'DRAFT'")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("center_lat", sa.Float(), nullable=False),
        sa.Column("center_lng", sa.Float(), nullable=False),
        sa.Column("radius_km", sa.Float(), nullable=False, server_default=sa.text("30.0")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("form_pack_id", sa.String(length=36), sa.ForeignKey("crisis_form_packs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_crisis_events_active", "crisis_events", ["is_active", "started_at", "ended_at"])

    # ── reports: additive nullable crisis-form columns ────────────────────
    op.add_column("reports", sa.Column("crisis_event_id", sa.String(length=36),
                  sa.ForeignKey("crisis_events.id", ondelete="SET NULL"), nullable=True))
    op.add_column("reports", sa.Column("form_pack_id", sa.String(length=36),
                  sa.ForeignKey("crisis_form_packs.id", ondelete="SET NULL"), nullable=True))
    op.add_column("reports", sa.Column("form_pack_version", sa.Integer(), nullable=True))
    op.add_column("reports", sa.Column("form_data", sa.JSON(), nullable=True))
    op.create_index("ix_reports_crisis_event_id", "reports", ["crisis_event_id"])


def downgrade():
    op.drop_index("ix_reports_crisis_event_id", table_name="reports")
    op.drop_column("reports", "form_data")
    op.drop_column("reports", "form_pack_version")
    op.drop_column("reports", "form_pack_id")
    op.drop_column("reports", "crisis_event_id")

    op.drop_index("ix_crisis_events_active", table_name="crisis_events")
    op.drop_table("crisis_events")

    op.drop_index("ix_crisis_pack_versions_lookup", table_name="crisis_form_pack_versions")
    op.drop_table("crisis_form_pack_versions")

    op.drop_index("ix_crisis_form_packs_crisis_type", table_name="crisis_form_packs")
    op.drop_table("crisis_form_packs")
