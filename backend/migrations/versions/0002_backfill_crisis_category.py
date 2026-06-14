"""backfill crisis_category + ensure column exists on older dev DBs

Revision ID: 0002_bf_cat
Revises: 7964f14c120d
Create Date: 2026-04-20

Why this exists
---------------
The baseline migration (7964f14c120d) captures the schema AFTER the
April-2026 UNDP-alignment sprint added ``reports.crisis_category``.
Fresh deployments therefore get the column on ``alembic upgrade head``.

Existing CRISP dev/staging databases predate Alembic entirely - they
were created by SQLAlchemy's ``create_all()`` at app boot. Those DBs
are missing the column. Stamping them to ``head`` without running a
DDL step would leave the column absent and break the taxonomy hook.

This migration is idempotent:

  * If ``reports.crisis_category`` already exists (fresh DB from the
    baseline migration) it is a no-op apart from the backfill.
  * If the column is missing (legacy dev DB that's been stamped) it
    adds the column.
  * Either way it runs the UNDP Appendix-1 crisis-category mapping on
    every existing row so downstream dashboards work immediately.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0002_bf_cat"
down_revision: Union[str, Sequence[str], None] = "7964f14c120d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    # 1. Ensure the column exists. The baseline migration adds it on fresh
    # DBs; legacy create_all() DBs need the ALTER here.
    if not _has_column("reports", "crisis_category"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.add_column(sa.Column("crisis_category", sa.String(length=20), nullable=True))

    # 2. Backfill using the same mapping the app uses at write time.
    # Mirrors app.core.taxonomy.CRISIS_CATEGORY_OF - kept inline so the
    # migration is self-contained and doesn't depend on future refactors
    # of that module.
    mapping = {
        "EARTHQUAKE": "NATURAL",
        "FLOOD": "NATURAL",
        "TSUNAMI": "NATURAL",
        "CYCLONE": "NATURAL",
        "HURRICANE": "NATURAL",
        "LANDSLIDE": "NATURAL",
        "EXPLOSION": "TECHNOLOGICAL",
        "CHEMICAL_INCIDENT": "TECHNOLOGICAL",
        "PANDEMIC": "TECHNOLOGICAL",
        "CONFLICT": "HUMAN_MADE",
        "CIVIL_UNREST": "HUMAN_MADE",
        "WILDFIRE": "OTHER",
        "OTHER": "OTHER",
    }
    for crisis_value, category in mapping.items():
        op.execute(sa.text(
            "UPDATE reports SET crisis_category = :cat "
            "WHERE UPPER(crisis_type) = :ct AND (crisis_category IS NULL OR crisis_category = '')"
        ).bindparams(cat=category, ct=crisis_value))

    # 3. Normalise legacy damage labels so the UNDP-aligned "MINIMAL"
    # wording applies to pre-migration rows as well. The write-time hook
    # already handles new inserts/updates; this mops up the archive.
    op.execute(sa.text(
        "UPDATE reports SET damage_classification = 'MINIMAL' "
        "WHERE damage_classification IN ('NO_DAMAGE', 'NO DAMAGE', 'NODAMAGE')"
    ))


def downgrade() -> None:
    # No safe downgrade - dropping the column is destructive and the
    # label rewrite is a one-way normalisation. A downgrade would need
    # the original damage-class strings, which are lost after upgrade.
    # Operators who truly need to roll back should restore from backup.
    pass
