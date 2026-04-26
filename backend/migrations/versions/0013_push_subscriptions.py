"""push_subscriptions table for Web Push reporter feedback

Revision ID: 0013_push_subs
Revises: 0012_undp_infra
Create Date: 2026-04-27

Apr 2026 — closes the report→response loop without N reporters
polling. Each row holds one browser-issued PushSubscription
(endpoint URL, p256dh ECDH public key, auth secret) tied to a
reporter identity (`device_hash` and/or `user_id`).

The CHECK constraint enforces that at least one identity is set,
so we can always look up "who is this push for?" by either
column. `endpoint` is unique (browser → push provider pair) and
indexed for the GC path: when the provider returns 410 for a
stale subscription, we drop that one row by endpoint.

Idempotent — `IF NOT EXISTS` semantics on table create + index
create. Re-running this migration on a DB that already has the
table is a no-op.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0013_push_subs"
down_revision = "0012_undp_infra"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "push_subscriptions" in inspector.get_table_names():
        # Already created (idempotent re-run); nothing to do.
        return

    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("device_hash", sa.String(length=255), nullable=True),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("endpoint", sa.Text(), nullable=False, unique=True),
        sa.Column("p256dh_key", sa.String(length=255), nullable=False),
        sa.Column("auth_key", sa.String(length=255), nullable=False),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("locale", sa.String(length=10), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_pushed_at", sa.DateTime(), nullable=True),
        sa.Column("last_failure_at", sa.DateTime(), nullable=True),
        sa.Column(
            "failure_count",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "device_hash IS NOT NULL OR user_id IS NOT NULL",
            name="push_sub_has_identity",
        ),
    )
    op.create_index(
        "ix_push_subscriptions_device_hash",
        "push_subscriptions",
        ["device_hash"],
    )
    op.create_index(
        "ix_push_subscriptions_user_id",
        "push_subscriptions",
        ["user_id"],
    )
    op.create_index(
        "ix_push_subscriptions_endpoint",
        "push_subscriptions",
        ["endpoint"],
    )


def downgrade() -> None:
    op.drop_index("ix_push_subscriptions_endpoint", table_name="push_subscriptions")
    op.drop_index("ix_push_subscriptions_user_id", table_name="push_subscriptions")
    op.drop_index("ix_push_subscriptions_device_hash", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
