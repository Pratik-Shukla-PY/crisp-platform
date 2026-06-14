"""nearby: nearby_group_events table for lifecycle transition logging

Revision ID: 0020_nearby_group_events
Revises: 0019_report_first_verified_at
Create Date: 2026-05-16

Nearby Reports Pipeline - Phase 2 (docs §3.7) introduces lifecycle
tracking for nearby groups (promote / downgrade / merge / split /
resolve / fading transitions). Each event captures the group_id
involved, the from→to transition, the timestamp, and a small JSON
payload with the diff (counts / tiers / etc.).

This table is the persistent audit trail behind §13's
`cluster_lifetime_seconds` histogram + the dashboard's Phase 4
"Cluster history" public-timeline view.

Indexed on (group_id, occurred_at) so the most common query -
"all events for a group, newest first" - is a single index scan.
Also indexed on occurred_at alone for the time-window aggregation
the observability endpoint will run.

Idempotent - uses the inspector guard pattern from 0013/0015/
0017/0018/0019.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0020_nearby_group_events"
down_revision = "0019_report_first_verified_at"
branch_labels = None
depends_on = None


_TABLE = "nearby_group_events"
_IDX_GROUP = "ix_nearby_group_events_group_id_occurred_at"
_IDX_TIME = "ix_nearby_group_events_occurred_at"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_tables = set(inspector.get_table_names())
    if _TABLE not in existing_tables:
        op.create_table(
            _TABLE,
            # uuid primary key - strings keep the schema portable.
            sa.Column("id", sa.String(length=36), primary_key=True),
            # The group this event belongs to. Group ids are
            # synthesized (g_building_<bid> / g_block_<gh>_<crisis> /
            # g_area_<gh>_<crisis>) - not a FK because groups are
            # ephemeral aggregations, not DB rows.
            sa.Column("group_id", sa.String(length=128), nullable=False),
            # Event taxonomy. Bounded set so callers can index/filter.
            # See nearby_aggregator.GroupEventKind.
            sa.Column("event_kind", sa.String(length=32), nullable=False),
            # Optional from→to fields. NULLable because some events
            # (initial 'created') don't have a 'from' state.
            sa.Column("from_tier", sa.String(length=16), nullable=True),
            sa.Column("to_tier", sa.String(length=16), nullable=True),
            sa.Column("from_count", sa.Integer(), nullable=True),
            sa.Column("to_count", sa.Integer(), nullable=True),
            # Tiny JSON payload for ad-hoc diff data - kept jsonb so
            # we can query inside it later (e.g., "groups that lost a
            # device between t1 and t2").
            sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()),
                      nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column("occurred_at", sa.DateTime(timezone=True),
                      nullable=False, server_default=sa.func.now()),
        )

    existing_idx = {idx["name"] for idx in inspector.get_indexes(_TABLE)} \
        if _TABLE in inspector.get_table_names() else set()
    if _IDX_GROUP not in existing_idx:
        op.create_index(_IDX_GROUP, _TABLE,
                        ["group_id", sa.text("occurred_at DESC")])
    if _IDX_TIME not in existing_idx:
        op.create_index(_IDX_TIME, _TABLE, ["occurred_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _TABLE in inspector.get_table_names():
        existing_idx = {idx["name"] for idx in inspector.get_indexes(_TABLE)}
        if _IDX_TIME in existing_idx:
            op.drop_index(_IDX_TIME, table_name=_TABLE)
        if _IDX_GROUP in existing_idx:
            op.drop_index(_IDX_GROUP, table_name=_TABLE)
        op.drop_table(_TABLE)
