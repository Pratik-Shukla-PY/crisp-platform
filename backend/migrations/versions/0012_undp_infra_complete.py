"""Add COMMERCIAL + PUBLIC_SPACES to infratypeenum (UNDP Appendix-1 completeness)

Revision ID: 0012_undp_infra
Revises: 0011_mfa
Create Date: 2026-04-26

Bug: PWA submissions where the user picked "Commercial Infrastructure"
or "Public Spaces / Recreation Infrastructure" 500'd on insert with:

    psycopg2.errors.InvalidTextRepresentation: invalid input value for
    enum infratypeenum: "COMMERCIAL"

Cause: migration 0003_infra_super_types widens the Postgres enum by
iterating CHIP_TO_UNDP.values(). That set is {RESIDENTIAL, COMMUNITY,
TRANSPORT_COMMUNICATION, UTILITY} — the targets of legacy chip remaps.
COMMERCIAL and PUBLIC_SPACES had no legacy chips pointing to them, so
they were never added to the Postgres ENUM TYPE, even though the
backend's Python InfraTypeEnum lists them as valid values.

UNDP RAPIDA Appendix-1 mandates seven super-types + OTHER:
    RESIDENTIAL, COMMERCIAL, GOVERNMENT, UTILITY,
    TRANSPORT_COMMUNICATION, COMMUNITY, PUBLIC_SPACES, OTHER

Without this migration, two of those eight buckets are unsubmittable
in prod even though the dropdown shows them.

This migration adds the two missing values. Idempotent — `IF NOT
EXISTS` is a no-op when the values already exist.

`ALTER TYPE … ADD VALUE` must run OUTSIDE a transaction in Postgres,
hence `autocommit_block()`. (Same pattern as 0003.)
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "0012_undp_infra"
down_revision = "0011_mfa"
branch_labels = None
depends_on = None


# UNDP Appendix-1 super-types that 0003 missed because no legacy chips
# remapped to them.
NEW_VALUES = ("COMMERCIAL", "PUBLIC_SPACES")


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for value in NEW_VALUES:
            op.execute(
                f"ALTER TYPE infratypeenum ADD VALUE IF NOT EXISTS '{value}'"
            )


def downgrade() -> None:
    # Postgres doesn't support DROP VALUE on an enum type. The clean
    # downgrade would be: rename the enum, create a new one without
    # these values, ALTER TABLE … TYPE …, drop the old enum. That's a
    # full table rewrite under a lock — disproportionate for an
    # additive migration. Documented intentionally as no-op; rows
    # using these values would block the downgrade anyway.
    pass
