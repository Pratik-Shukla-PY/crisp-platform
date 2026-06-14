"""composite indexes for operation-scoped report queries

Revision ID: 0048_crisis_event_idx
Revises: 0047_drop_auto_submit_regions
Create Date: 2026-06-13 (Operations redesign Phase 2)

The Operations redesign scopes report queries to a single CrisisEvent
(operation): the operation dashboard lists "all reports for this event"
filtered/sorted by status and severity, and the operations rail rolls up
per-event critical/total counts. `reports.crisis_event_id` already has a
single-column index (declared `index=True` on the model), but every scoped
query also constrains on `status` or `severity`, so the planner falls back
to a filtered scan over the FK index at the 500k-reports/crisis scale target
(must-have #12).

Two composites cover those access paths:
  1. (crisis_event_id, status)   - operation worklist + active/closed rollups
  2. (crisis_event_id, severity) - per-operation critical counts + worst-first sort

Both created with CONCURRENTLY so a live PROD upgrade doesn't lock `reports`.
Alembic must run this outside its default transaction (see the COMMIT below).
Mirrors the entries added to Report.__table_args__ so `create_all()` in pytest
and `alembic upgrade head` produce identical physical index names on Postgres.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0048_crisis_event_idx"
down_revision: Union[str, Sequence[str], None] = "0047_drop_auto_submit_regions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Run OUTSIDE alembic's default per-migration transaction so we can use
# CREATE INDEX CONCURRENTLY (Postgres refuses CONCURRENTLY inside a
# transaction block).
def _bootstrap_concurrent_safe() -> None:
    op.execute("COMMIT")   # close alembic's auto-opened transaction


def upgrade() -> None:
    _bootstrap_concurrent_safe()

    op.execute(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS '
        '"ix_reports_crisis_event_status" ON "reports" '
        '("crisis_event_id", "status")'
    )
    op.execute(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS '
        '"ix_reports_crisis_event_severity" ON "reports" '
        '("crisis_event_id", "severity")'
    )


def downgrade() -> None:
    _bootstrap_concurrent_safe()
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS "ix_reports_crisis_event_severity"')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS "ix_reports_crisis_event_status"')
