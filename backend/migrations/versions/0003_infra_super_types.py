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
    # GOVERNMENT already aligns with UNDP - no remap needed.
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
    # Postgres:
    #
    #   (a) Widen the ENUM type BEFORE the UPDATE. `ALTER TYPE ... ADD
    #       VALUE IF NOT EXISTS` must be OUTSIDE any transaction per
    #       Postgres semantics; we use `autocommit_block()` for that.
    #
    #   (b) `UPPER(enum_col)` isn't valid in Postgres - the planner
    #       refuses the call without an explicit text cast. Hence
    #       `infrastructure_type::text` in the WHERE.
    with op.get_context().autocommit_block():
        for new_val in sorted(set(CHIP_TO_UNDP.values())):
            op.execute(sa.text(
                f"ALTER TYPE infratypeenum ADD VALUE IF NOT EXISTS '{new_val}'"
            ))

    for chip, undp in CHIP_TO_UNDP.items():
        op.execute(sa.text(
            "UPDATE reports "
            "SET infrastructure_sub_type = COALESCE(infrastructure_sub_type, :chip), "
            "    infrastructure_type = :undp "
            "WHERE UPPER(infrastructure_type::text) = :chip"
        ).bindparams(chip=chip, undp=undp))


def downgrade() -> None:
    # Best-effort downgrade: collapse RESIDENTIAL/COMMUNITY/TRANSPORT/UTILITY
    # back to the first legacy chip we find via sub_type. If sub_type is
    # empty the row cannot be round-tripped losslessly.
    #
    # Portability note: the original
    # code wrote `infrastructure_sub_type` (varchar) straight into
    # `infrastructure_type` (infratypeenum). On SQLite the enum is just a
    # CHECK constraint so the cast is implicit; on Postgres it's a real
    # enum TYPE and the UPDATE fails with "column 'infrastructure_type'
    # is of type infratypeenum but expression is of type character
    # varying". Explicit `::infratypeenum` cast makes it portable.
    #
    # Further caveat: we ALSO constrain the cast to values that ARE in
    # the enum - a sub_type value like 'HOSPITAL' that WAS originally a
    # legacy chip is still in the enum (migration 0003 only ADDED the
    # UNDP super-types; it didn't REMOVE the legacy labels). So the
    # cast is safe for every value that legitimately came from the
    # original write path.
    op.execute(sa.text(
        "UPDATE reports "
        "SET infrastructure_type = infrastructure_sub_type::infratypeenum "
        "WHERE infrastructure_sub_type IS NOT NULL "
        "  AND infrastructure_sub_type != '' "
        "  AND infrastructure_sub_type IN ("
        "    SELECT unnest(enum_range(NULL::infratypeenum))::text)"
    ))
    if _has_column("reports", "infrastructure_sub_type"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.drop_index("ix_reports_infrastructure_sub_type")
            batch_op.drop_column("infrastructure_sub_type")
