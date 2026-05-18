"""building_events table — Phase H.2 audit trail

Revision ID: 0029_building_events
Revises: 0028_buildings_table
Create Date: 2026-05-18

Phase H.2 (Dashboard audit follow-up, May 2026).

Adds an append-only audit log of state transitions + operator actions
on Building entities. Mirrors the existing `NearbyGroupEvent` table
shape (used for nearby-cluster transitions) but keyed on building_id
+ broader event_kind vocabulary that covers state machine + monitor
+ responder + note + AI lifecycle events.

Event kinds (bounded vocabulary, not a Postgres enum so we can add
new kinds without ALTER TYPE migrations):

  STATE_CHANGED          from_state, to_state in payload
  REPORT_LINKED          report_id added — first or subsequent
  REPORT_UNLINKED        soft-deleted report removed from partition
  MONITOR_STARTED        operator added the building to watch list (H.3)
  MONITOR_CLEARED        operator removed the watch (H.3)
  RESPONDER_ASSIGNED     responder linked (H.3)
  RESPONDER_DISPATCHED   responder en route timestamp set (H.3)
  RESPONDER_ARRIVED      responder on-site timestamp set (H.3)
  RESPONDER_CLEARED      responder finished (H.3)
  NOTE_ADDED             operator note thread entry (H.4)
  NOTE_EDITED            note revised (H.4)
  NOTE_DELETED           soft-delete (H.4)
  AI_SUMMARY_GENERATED   Claude summary refresh (H.6)
  SATELLITE_VERIFIED     aggregate satellite verdict crossed threshold
  ESCALATED              operator-raised priority
  DE_ESCALATED           operator lowered priority
  FALSE_ALARM_DECLARED   misinformation cluster marked
  ARCHIVED               auto-archive after 30d no activity

Schema:

  id           UUID primary key
  building_id  FK to buildings.id
  event_kind   varchar(40), bounded vocabulary above
  actor_user_id  FK to users.id (nullable for SYSTEM events)
  actor_kind   enum OPERATOR | SYSTEM | AI
  payload      JSON — arbitrary diff data per event kind
                (e.g. {from_state, to_state}, {report_id},
                {note_id, body_prefix}, {model, tokens_used})
  occurred_at  DateTime timezone — server timestamp

Indexes:

  (building_id, occurred_at) — drives the H.2 console timeline render
                                "newest events for this building, paginated"

Cleanup policy: retain forever for ESCALATED + FALSE_ALARM buildings
(compliance + audit); truncate to last 90d for ACTIVE / MONITORED /
RESPONDING / RESOLVED (configurable). Implementation deferred —
this migration just creates the structure.
"""
from alembic import op
import sqlalchemy as sa


revision = "0029_building_events"
down_revision = "0028_buildings_table"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # actor_kind enum auto-created by sa.Enum at table-create time
    # (default create_type=True). Mirrors the 0028 lesson — don't
    # double-create via a DO block.
    op.create_table(
        "building_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "building_id",
            sa.String(64),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_kind", sa.String(40), nullable=False),
        sa.Column(
            "actor_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "actor_kind",
            sa.Enum("OPERATOR", "SYSTEM", "AI",
                    name="building_event_actor_kind"),
            nullable=False,
            server_default="OPERATOR",
        ),
        sa.Column("payload", sa.JSON, nullable=True),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )

    # Index drives the console timeline (newest-first per building).
    op.create_index(
        "ix_building_events_building_occurred",
        "building_events",
        ["building_id", "occurred_at"],
        postgresql_using=None,
    )
    # Global occurrence index for admin observability dashboards.
    op.create_index(
        "ix_building_events_occurred_at",
        "building_events",
        ["occurred_at"],
    )
    # Event-kind index for "show me all ESCALATED events in last 24h" queries.
    op.create_index(
        "ix_building_events_event_kind",
        "building_events",
        ["event_kind"],
    )


def downgrade() -> None:
    op.drop_index("ix_building_events_event_kind", table_name="building_events")
    op.drop_index("ix_building_events_occurred_at", table_name="building_events")
    op.drop_index("ix_building_events_building_occurred", table_name="building_events")
    op.drop_table("building_events")
    op.execute("DROP TYPE IF EXISTS building_event_actor_kind")
