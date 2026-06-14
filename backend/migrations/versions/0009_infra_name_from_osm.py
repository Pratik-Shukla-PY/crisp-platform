"""reports: add infrastructure_name_from_osm column

Revision ID: 0009_ifno
Revises: 0008_perf
Create Date: 2026-04-22

Phase B2 (Apr 2026 UI v3) - distinguisher between building-names auto-
filled from an OSM tap vs names typed as free text by a reporter whose
device couldn't load the Overpass footprint overlay (offline, proxy-
blocked, or pre-cache empty on first-run). Combined with `building_id
IS NULL`, the dashboard uses this to surface a "needs mapping" badge so
operators can resolve free-text entries to real OSM footprints later.

Design notes:
  * Nullable by design. Pre-v3 clients (PWA bundle < 850, RN < 2026-04-22)
    never set the field - the column stays NULL for their rows. The
    dashboard treats NULL as "unknown" and displays neither the green
    ✓ nor the red "needs mapping" pip. Only explicit `False` + a
    non-null `infrastructure_name` + `building_id IS NULL` triggers
    the badge.
  * No backfill: we explicitly cannot distinguish OSM-picked from
    user-typed on legacy rows - no flag exists to recover that signal.
    Leaving NULL is the correct + honest posture.
  * No index. The column is not a filter axis on any hot query path;
    the dashboard does one JOIN-less `WHERE building_id IS NULL AND
    infrastructure_name IS NOT NULL AND infrastructure_name_from_osm
    IS NOT TRUE` scan that's bounded by the existing `server_created_at`
    index (we use a time-window sidebar on the dashboard).

Idempotent - safe to rerun.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0009_ifno"
down_revision: Union[str, Sequence[str], None] = "0008_perf"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _has_column("reports", "infrastructure_name_from_osm"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.add_column(
                sa.Column("infrastructure_name_from_osm", sa.Boolean(), nullable=True)
            )


def downgrade() -> None:
    if _has_column("reports", "infrastructure_name_from_osm"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.drop_column("infrastructure_name_from_osm")
