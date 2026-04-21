"""add infrastructure_sub_type + remap legacy chips to UNDP super-types

Revision ID: 0003_infra
Revises: 0002_bf_cat
Create Date: 2026-04-20

UNDP RAPIDA Appendix-1 defines *seven* infrastructure super-types + OTHER:

    RESIDENTIAL, COMMERCIAL, GOVERNMENT, UTILITY,
    TRANSPORT_COMMUNICATION, COMMUNITY, PUBLIC_SPACES, OTHER

CRISP historically stored chips (ROAD, HOSPITAL, HOUSE, POWER, WATER,
SCHOOL, TELECOM) directly in ``reports.infrastructure_type``. This
migration:

  1. Adds ``reports.infrastructure_sub_type`` (String) if missing, so
     the original chip is preserved for drill-down.
  2. Backfills: copy the legacy chip into ``infrastructure_sub_type``
     and rewrite ``infrastructure_type`` to the UNDP super-type.

Idempotent: reruns skip rows that have already been remapped (i.e.
infrastructure_type already matches a UNDP super-type). The write-time
taxonomy hook in ``app.models.report`` handles the same job for every
new insert/update, so once this migration has run once the DB stays
UNDP-compliant forever.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0003_infra"
down_revision: Union[str, Sequence[str], None] = "0002_bf_cat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


CHIP_TO_UNDP = {
    "HOUSE":      "RESIDENTIAL",
    "HOSPITAL":   "COMMUNITY",
    "SCHOOL":     "COMMUNITY",
    "ROAD":       "TRANSPORT_COMMUNICATION",
    "POWER":      "UTILITY",
    "WATER":      "UTILITY",
    "TELECOM":    "UTILITY",
    # GOVERNMENT already aligns with UNDP — no remap needed.
}


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    # 1. Add the sub_type column if missing.
    if not _has_column("reports", "infrastructure_sub_type"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.add_column(
                sa.Column("infrastructure_sub_type", sa.String(length=40), nullable=True)
            )
            batch_op.create_index(
                "ix_reports_infrastructure_sub_type",
                ["infrastructure_sub_type"],
            )

    # 2. Backfill: copy legacy chip into sub_type, promote infrastructure_type
    # to the UNDP super-type.
    #
    # Portability note (Apr 2026 full-Postgres switch): two dialect-
    # specific adjustments here.
    #
    #   (a) The original query used `UPPER(infrastructure_type) = :chip`.
    #       On SQLite that works because enum columns are stored as plain
    #       text. On Postgres `infrastructure_type` is a real ENUM type
    #       and the planner refuses `UPPER(enum_col)` — there's no
    #       implicit cast. Explicit `::text` cast makes it portable.
    #
    #   (b) On Postgres we also need `ALTER TYPE infratypeenum ADD VALUE`
    #       for every UNDP super-type we're about to write into the
    #       column. SQLite is untyped and accepts any string; Postgres
    #       rejects "invalid input value for enum" until the label has
    #       been added. The ADD VALUE statements must be OUTSIDE any
    #       transaction in Postgres 12+, so we use `op.execute` with a
    #       commit boundary (alembic runs each op.execute in its own
    #       statement by default when autocommit_block is active).
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        # Widen the enum type BEFORE the UPDATE. IF NOT EXISTS needs
        # Postgres 9.6+, which is comfortably below our 14+ target.
        # Each ADD VALUE is its own statement per Postgres syntax rules.
        with op.get_context().autocommit_block():
            for new_val in sorted(set(CHIP_TO_UNDP.values())):
                op.execute(sa.text(
                    f"ALTER TYPE infratypeenum ADD VALUE IF NOT EXISTS '{new_val}'"
                ))

    enum_cast = "infrastructure_type::text" if dialect == "postgresql" else "infrastructure_type"
    for chip, undp in CHIP_TO_UNDP.items():
        op.execute(sa.text(
            "UPDATE reports "
            "SET infrastructure_sub_type = COALESCE(infrastructure_sub_type, :chip), "
            "    infrastructure_type = :undp "
            f"WHERE UPPER({enum_cast}) = :chip"
        ).bindparams(chip=chip, undp=undp))


def downgrade() -> None:
    # Best-effort downgrade: collapse RESIDENTIAL/COMMUNITY/TRANSPORT/UTILITY
    # back to the first legacy chip we find via sub_type. If sub_type is
    # empty the row cannot be round-tripped losslessly.
    op.execute(sa.text(
        "UPDATE reports "
        "SET infrastructure_type = infrastructure_sub_type "
        "WHERE infrastructure_sub_type IS NOT NULL AND infrastructure_sub_type != ''"
    ))
    if _has_column("reports", "infrastructure_sub_type"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.drop_index("ix_reports_infrastructure_sub_type")
            batch_op.drop_column("infrastructure_sub_type")
