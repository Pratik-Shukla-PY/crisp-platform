"""Operations redesign v2 — collapse operation status to {LIVE, ENDED}

Revision ID: 0053_collapse_operation_status
Revises: 0052_idx_building_esc_risk
Create Date: 2026-06-14 (Operations redesign v2 — two-state status)

The operator simplified the operation lifecycle to TWO states only: LIVE and
ENDED. DRAFT and PAUSED are removed (a "paused" op is just closed; operators
re-launch if needed; there is no draft persistence in the new wizard, so a
never-activated DRAFT is operationally closed too).

`crisis_events.status` is a plain VARCHAR(20), NOT a Postgres ENUM (0046 created
it with a string + server_default 'DRAFT'), so there is no `ALTER TYPE`/DROP
VALUE to write — this migration is a pure data backfill + a CHECK constraint.

Backfill rule (order matters — rescue active drafts BEFORE the catch-all sweep):
  · DRAFT + is_active=True + (no end window OR window still open) -> LIVE
  · everything else not already LIVE (DRAFT-inactive, PAUSED, past-ended, stray) -> ENDED + is_active=False

NOTE on `is_active`: under the two-state model it becomes a strict function of
status (LIVE <=> active). The app write-paths enforce this going forward
(create_event/update_event derive is_active from status); here we make the
existing rows consistent.

`crisis_form_pack_versions.status` (lowercase draft|published|archived) is a
DIFFERENT column on a DIFFERENT table (the form-schema lifecycle) and is NOT
touched by this migration.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0053_collapse_operation_status"
down_revision: Union[str, Sequence[str], None] = "0052_idx_building_esc_risk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Rescue LIVE intent: an active draft inside its window (or with no window)
    #    is operationally live.
    op.execute(
        "UPDATE crisis_events SET status = 'LIVE' "
        "WHERE status = 'DRAFT' AND is_active = true "
        "AND (ended_at IS NULL OR ended_at >= now())"
    )
    # 2. Everything else that isn't already LIVE becomes ENDED + inactive
    #    (inactive drafts, all PAUSED, window-expired rows, any stray legacy value).
    op.execute(
        "UPDATE crisis_events SET status = 'ENDED', is_active = false "
        "WHERE status <> 'LIVE'"
    )
    # 3. New rows default to LIVE (matches the model default change).
    op.execute("ALTER TABLE crisis_events ALTER COLUMN status SET DEFAULT 'LIVE'")
    # 4. Durable guard so no future code path can re-introduce a third state.
    op.create_check_constraint(
        "ck_crisis_events_status_live_ended",
        "crisis_events",
        "status IN ('LIVE', 'ENDED')",
    )


def downgrade() -> None:
    # Data backfill is irreversible (DRAFT/PAUSED are unrecoverable); only the
    # constraint + default are reverted. Rows stay LIVE/ENDED.
    op.drop_constraint("ck_crisis_events_status_live_ended", "crisis_events", type_="check")
    op.execute("ALTER TABLE crisis_events ALTER COLUMN status SET DEFAULT 'DRAFT'")
