"""Operations redesign P3 — index buildings.escalation_risk (scalability)

Revision ID: 0052_idx_building_esc_risk
Revises: 0051_crisis_event_place_name
Create Date: 2026-06-14 (Global-vs-Operations redesign Phase 3b)

The "escalating hotspots" predicate (Building.escalation_risk >= 70) is evaluated
on EVERY /analytics/summary call AND every /operations rollup. escalation_risk had
no index (its sibling 5-score columns severity_score / humanitarian_priority do),
so the filter was a full Building scan that degrades as building count grows. Add a
plain B-tree on escalation_risk — the selective >=70 range scan now hits the index.

CONCURRENTLY (no table lock) so it's safe to apply online; hence op.execute with an
autocommit block rather than op.create_index inside the migration transaction.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0052_idx_building_esc_risk"
down_revision: Union[str, Sequence[str], None] = "0051_crisis_event_place_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # CONCURRENTLY can't run inside a transaction — use an autocommit connection.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_buildings_escalation_risk "
            "ON buildings (escalation_risk)"
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_buildings_escalation_risk")
