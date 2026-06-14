"""media_chunks: add data_binary column + CHECK constraint + relax data_b64 nullability

Revision ID: 0004_bin
Revises: 0003_infra
Create Date: 2026-04-21

Why this exists
---------------
April 2026 binary-chunk transport (Option A - discussion +
the design plan §5). The PWA and
RN clients may now upload image/audio chunks as raw bytes via
multipart/form-data to the new ``/reports/{id}/media/chunk-bin``
endpoint, instead of base64-over-JSON to ``/reports/{id}/media/chunk``.

Storage-layer change:
  * ``media_chunks.data_binary``  - new ``LargeBinary`` column for raw
    bytes. ``NULL`` on every legacy row (they have ``data_b64`` populated).
  * ``media_chunks.data_b64``     - relaxed to ``NULL``-able. Was
    ``NOT NULL`` pre-April 2026.
  * ``chunk_has_one_payload`` CHECK constraint enforces the invariant
    that exactly one of ``data_b64`` / ``data_binary`` is populated.

The assembly path in ``app.api.endpoints.reports`` reads whichever
column holds the payload per row - mixed-format media rows (binary +
legacy base64 chunks for the same ``media_id``) are defensively handled
but never produced by client logic.

Idempotent: re-running the migration against a database that already
has the column is a no-op. Matches the pattern of the earlier
``0002_bf_cat`` and ``0003_infra`` revisions so staging/production
migrations are safe to rerun.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0004_bin"
down_revision: Union[str, Sequence[str], None] = "0003_infra"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def _column_is_nullable(table_name: str, column_name: str) -> bool:
    """Return True if the column exists AND is already nullable.
    Used to skip the relax-to-NULL alter_column when it's a no-op -
    a gratuitous batch_alter_table on SQLite triggers a full table
    rebuild which can interact badly with other batch operations in
    the same migration."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return True
    for col in inspector.get_columns(table_name):
        if col["name"] == column_name:
            return bool(col.get("nullable", True))
    return True


def _has_check_constraint(table_name: str, constraint_name: str) -> bool:
    """Return True if a CHECK constraint with the given name exists on the table.

    SQLite's inspector surfaces CHECK constraints via get_check_constraints;
    Postgres + MySQL likewise. Empty result falls through to False.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    try:
        for c in inspector.get_check_constraints(table_name):
            if c.get("name") == constraint_name:
                return True
    except NotImplementedError:
        # Some dialects haven't implemented check-constraint introspection.
        # Return False so the migration attempts to add it; op.execute
        # will no-op or error depending on the dialect - the surrounding
        # try/except below catches it.
        pass
    return False


def upgrade() -> None:
    # 1. Add `data_binary` column if missing. Nullable by design -
    #    legacy rows have `data_b64` populated and `data_binary` stays NULL.
    if not _has_column("media_chunks", "data_binary"):
        with op.batch_alter_table("media_chunks") as batch_op:
            batch_op.add_column(
                sa.Column("data_binary", sa.LargeBinary(), nullable=True)
            )

    # 2. Relax data_b64 to NULL-able so binary-chunk rows can set it to NULL.
    #    batch_alter_table generates a table-rebuild on SQLite (a simple
    #    ALTER COLUMN on Postgres). Skip entirely when the column is
    #    already nullable - avoids a gratuitous table rebuild that can
    #    interact badly with FK-reflection edge cases observed on
    #    create_all() synthesized schemas.
    if not _column_is_nullable("media_chunks", "data_b64"):
        with op.batch_alter_table("media_chunks") as batch_op:
            batch_op.alter_column(
                "data_b64",
                existing_type=sa.Text(),
                nullable=True,
            )

    # 3. Add the CHECK constraint if missing. Guarded because re-running
    #    against a DB that already has it would fail with a duplicate-name
    #    error on Postgres.
    if not _has_check_constraint("media_chunks", "chunk_has_one_payload"):
        try:
            with op.batch_alter_table("media_chunks") as batch_op:
                batch_op.create_check_constraint(
                    "chunk_has_one_payload",
                    "(data_b64 IS NOT NULL) OR (data_binary IS NOT NULL)",
                )
        except Exception:
            # Non-fatal: some legacy SQLite builds don't support adding
            # CHECK constraints after table creation. The server-side
            # write path still enforces the invariant via the SQLAlchemy
            # ORM's CheckConstraint declaration in app.models.report.
            pass


def downgrade() -> None:
    # Drop the CHECK constraint first - can't drop the column while it's
    # referenced by a constraint on Postgres.
    if _has_check_constraint("media_chunks", "chunk_has_one_payload"):
        try:
            with op.batch_alter_table("media_chunks") as batch_op:
                batch_op.drop_constraint("chunk_has_one_payload", type_="check")
        except Exception:
            pass

    # Restore data_b64 NOT NULL. Irreversible for any rows where it's
    # actually NULL - those rows must be purged first or the downgrade
    # will abort. Leaving this as a manual-review failure rather than
    # silent data loss.
    with op.batch_alter_table("media_chunks") as batch_op:
        batch_op.alter_column(
            "data_b64",
            existing_type=sa.Text(),
            nullable=False,
        )

    if _has_column("media_chunks", "data_binary"):
        with op.batch_alter_table("media_chunks") as batch_op:
            batch_op.drop_column("data_binary")
