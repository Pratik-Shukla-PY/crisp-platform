"""assessment staleness + input-hash cache columns on scope_assessment

#6 (re-run on new reports): report_count_at_assessment captures how many reports the
scope held when the assessment ran, so the dashboard can detect "X new reports since".
#7 (caching): inputs_hash is a stable digest of the deterministic roll-up the narrative
was built from, so a re-run whose inputs are unchanged returns the cached narrative
instead of re-billing Claude.

Both columns are nullable + additive (older rows simply have NULL and behave as
"always stale / never cache-hit"), so this is a zero-downtime, no-backfill migration.

Revision ID: 0064_assessment_staleness_cache
Revises: 0063_heal_osm_building_names
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0064_assessment_staleness_cache"
down_revision: Union[str, Sequence[str], None] = "0063_heal_osm_building_names"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("scope_assessment",
                  sa.Column("report_count_at_assessment", sa.Integer(), nullable=True))
    op.add_column("scope_assessment",
                  sa.Column("inputs_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("scope_assessment", "inputs_hash")
    op.drop_column("scope_assessment", "report_count_at_assessment")
