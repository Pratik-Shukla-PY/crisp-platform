"""Normalise legacy HURRICANE crisis_type rows to CYCLONE

Revision ID: 0016_undp_crisis_norm
Revises: 0015_geo_conf
Create Date: 2026-05-12

UNDP Problem Statement (page 8) lists 'Hurricane/Cyclone' as a single
natural-hazard category. The codebase historically accepted both
HURRICANE and CYCLONE enum values, producing schema drift in the DB:
same physical event populated different enum buckets depending on
which version of the client submitted it.

The application-layer normaliser in
`backend/app/api/endpoints/reports.py::_normalize_crisis_type` rewrites
HURRICANE -> CYCLONE on every new write. This migration cleans up the
historical rows so dashboard counts / per-crisis filters return a
single consistent value for the entire row set.

Idempotent - re-running is a no-op once all rows are CYCLONE.
"""
from alembic import op
from sqlalchemy import text


revision = "0016_undp_crisis_norm"
down_revision = "0015_geo_conf"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLAlchemy stores CrisisTypeEnum as plain VARCHAR (native_enum=False)
    # with Python-side validation, not a Postgres ENUM TYPE - so the
    # UPDATE is a plain string rewrite. Only `reports.crisis_type`
    # carries the column today; if more tables are added later they
    # should be appended here.
    op.get_bind().execute(text(
        "UPDATE reports "
        "SET crisis_type = 'CYCLONE' "
        "WHERE crisis_type = 'HURRICANE'"
    ))


def downgrade() -> None:
    # Best-effort reverse: rewrite CYCLONE back to HURRICANE. The two
    # values are semantically equivalent per UNDP, so this loses no
    # information - it just restores the pre-normalisation enum mix.
    # Not lossless for rows created natively as CYCLONE pre-migration,
    # but that's acceptable for a downgrade path that nobody should
    # exercise in PROD.
    op.get_bind().execute(text(
        "UPDATE reports "
        "SET crisis_type = 'HURRICANE' "
        "WHERE crisis_type = 'CYCLONE'"
    ))
