"""Operations redesign P2 — denormalised place_name on crisis_events

Revision ID: 0051_crisis_event_place_name
Revises: 0050_operation_claim_log
Create Date: 2026-06-14 (Global-vs-Operations redesign Phase 2)

The operation card shows a human "City, Country" location, but a CrisisEvent has
only center_lat/center_lng. Denormalise a nullable place_name column (resolved
best-effort via the existing reverse-geocode cascade + GeocodeCache at
create/launch/center-edit) so the /operations rollup stays a single no-N+1 query
instead of geocoding per row in the hot path. NULL = unresolved (the card falls
back to coordinates).

No change for the new PAUSED status — crisis_events.status is a plain String(20),
not a DB enum, so it already accepts the value (application logic + the activation
gate handle the semantics: PAUSED forces is_active=False so a paused op stops
matching new reports).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0051_crisis_event_place_name"
down_revision: Union[str, Sequence[str], None] = "0050_operation_claim_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "crisis_events",
        sa.Column("place_name", sa.String(length=200), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("crisis_events", "place_name")
