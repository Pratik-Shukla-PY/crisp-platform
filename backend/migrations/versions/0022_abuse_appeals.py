"""abuse_appeals: tables for the CRISP-hosted moderation appeal framework

Revision ID: 0022_abuse_appeals
Revises: 0021_device_trust_columns
Create Date: 2026-05-16

Phase 4 (docs/NEARBY_REPORTS_PIPELINE.md §6.4 + §7.5) - CRISP-hosted
moderation + appeal framework. UNDP and deployment partners can
optionally integrate via outbound webhooks; the framework itself
stays platform-scalable + reusable across deployments.

Two tables:

  appeals (id, device_id, status, claim_text, original_signals,
           opened_at, decided_at, decided_by_admin_id, decision,
           decision_notes)
    One row per appeal. Status transitions: 'open' → 'under_review'
    → 'reinstated' | 'upheld' | 'banned'. Decision audits the
    admin who actioned it.

  appeal_events (id, appeal_id, event_kind, actor_admin_id, payload,
                 occurred_at)
    Append-only event log per appeal - open / comment / status_change
    / webhook_sent. Powers the "appeal history" view in the admin UI.

Indexed for the two hot access patterns:
  • Appeals by device (lookup current open appeal for a device)
  • Appeals by status (admin queue: 'open' / 'under_review')

Idempotent - inspector guard pattern from prior migrations.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0022_abuse_appeals"
down_revision = "0021_device_trust_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "appeals" not in existing_tables:
        op.create_table(
            "appeals",
            sa.Column("id", sa.String(length=36), primary_key=True),
            # The device this appeal is for. FK to devices.id;
            # nullable so an admin can also create an appeal on
            # a user_id basis (Phase 5+).
            sa.Column("device_id", sa.String(length=36),
                      sa.ForeignKey("devices.id", ondelete="CASCADE"),
                      nullable=True),
            sa.Column("user_id", sa.String(length=36), nullable=True),
            # 'open' | 'under_review' | 'reinstated' | 'upheld' | 'banned'
            sa.Column("status", sa.String(length=20),
                      nullable=False, server_default="open"),
            # Free-text claim from the reporter (or admin-entered if
            # opened on behalf of the reporter).
            sa.Column("claim_text", sa.Text(), nullable=True),
            # The spam_signals that were present on the device at the
            # time the appeal was opened. Snapshot - the live
            # devices.spam_signals can change post-appeal.
            sa.Column("original_signals",
                      postgresql.JSONB(astext_type=sa.Text()),
                      nullable=False,
                      server_default=sa.text("'[]'::jsonb")),
            sa.Column("original_spam_score", sa.Float(), nullable=True),
            sa.Column("opened_at", sa.DateTime(timezone=True),
                      nullable=False, server_default=sa.func.now()),
            sa.Column("decided_at", sa.DateTime(timezone=True),
                      nullable=True),
            sa.Column("decided_by_admin_id", sa.String(length=36),
                      nullable=True),
            sa.Column("decision_notes", sa.Text(), nullable=True),
        )
        op.create_index("ix_appeals_device_id", "appeals", ["device_id"])
        op.create_index("ix_appeals_status_opened",
                        "appeals", ["status", sa.text("opened_at DESC")])

    if "appeal_events" not in existing_tables:
        op.create_table(
            "appeal_events",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("appeal_id", sa.String(length=36),
                      sa.ForeignKey("appeals.id", ondelete="CASCADE"),
                      nullable=False),
            # 'opened' | 'comment' | 'status_change' | 'webhook_sent'
            sa.Column("event_kind", sa.String(length=24), nullable=False),
            sa.Column("actor_admin_id", sa.String(length=36), nullable=True),
            sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()),
                      nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column("occurred_at", sa.DateTime(timezone=True),
                      nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_appeal_events_appeal_id_occurred",
                        "appeal_events",
                        ["appeal_id", sa.text("occurred_at DESC")])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if "appeal_events" in existing_tables:
        op.drop_table("appeal_events")
    if "appeals" in existing_tables:
        op.drop_table("appeals")
