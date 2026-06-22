"""backfill incidents from existing reports (Building-centric Incident-Feed redesign Phase 2C)

Revision ID: 0059_backfill_incidents
Revises: 0058_incidents_table
Create Date: 2026-06-21 (Building-centric Incident-Feed redesign: seed the Incident layer)

Seeds the `incidents` table from existing reports so legacy data gets the same
first-class Incident layer the intake hook (Phase 2B) now gives new reports:

  - every active duplicate GROUP (a primary + its CONFIRMED_DUP children) → ONE
    incident (lead = the group's earliest report);
  - every other (standalone) report → its OWN incident.

Set-based pure SQL (no Python row loop) so it scales to the 500k-reports/crisis
target (must-have #12). Idempotent: only ever touches reports whose incident_id
IS NULL and only INSERTs incidents that don't exist yet, so a re-run is a no-op
and it composes safely with incidents the 2B intake hook may already have created.
Soft-deleted reports (deletion_requested_at set) are skipped. Reversible: the
downgrade clears reports.incident_id and empties the incidents table (back to the
post-0058 empty-schema state).

The data logic lives in `_backfill(bind)` so the backend test-suite can exercise
the EXACT same SQL against the test DB (CI coverage), not just an isolated alembic
round-trip.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0059_backfill_incidents"
down_revision: Union[str, Sequence[str], None] = "0058_incidents_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _backfill(bind) -> None:
    """Seed incidents from existing reports. Idempotent + set-based.

    `bind` is a SQLAlchemy Connection (op.get_bind() from the migration, or a test
    session's .connection()). Uses only raw SQL over stable table/column names so
    it never depends on the evolving ORM models.

    Order matters: reports.incident_id has a strict (non-deferred) FK, so the
    incident rows are CREATED FIRST (anchored on lead_report_id) and reports are
    LINKED to them afterwards. A "lead" is a primary (a report with CONFIRMED_DUP
    children) or a standalone report; confirmed-dup children defer to their
    primary's incident.
    """
    _SEV_RANK = (
        "CASE {c}::text WHEN 'CRITICAL' THEN 4 WHEN 'SEVERE' THEN 3 "
        "WHEN 'MODERATE' THEN 2 WHEN 'MINOR' THEN 1 ELSE 0 END"
    )

    # 1. Create ONE incident per LEAD report (primary or standalone) that doesn't
    #    have one yet. Confirmed-dup CHILDREN are excluded (they join their
    #    primary's incident in step 3). Skip soft-deleted reports.
    bind.execute(text("""
        INSERT INTO incidents
            (id, building_id, crisis_event_id, incident_type, severity,
             severity_overridden, status, title, lead_report_id, report_count,
             created_at, updated_at)
        SELECT
            gen_random_uuid()::text,
            r.building_id, r.crisis_event_id, r.crisis_type,
            COALESCE(r.severity::text, 'UNKNOWN'),
            false, 'OPEN',
            LEFT(COALESCE(NULLIF(INITCAP(REPLACE(r.crisis_type, '_', ' ')), ''), 'Incident'), 200),
            r.id, 1, now(), now()
        FROM reports r
        WHERE r.deletion_requested_at IS NULL
          AND r.incident_id IS NULL
          AND r.id NOT IN (
            SELECT related_report_id FROM report_duplicate_decisions
            WHERE undone_at IS NULL AND decision = 'CONFIRMED_DUP'
                  AND related_report_id IS NOT NULL
          )
          AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.lead_report_id = r.id)
    """))

    # 2. Link each LEAD report to the incident anchored on it.
    bind.execute(text("""
        UPDATE reports r SET incident_id = i.id
        FROM incidents i
        WHERE i.lead_report_id = r.id
          AND r.incident_id IS NULL
          AND r.deletion_requested_at IS NULL
    """))

    # 3. Link each confirmed-duplicate CHILD to its primary's incident.
    bind.execute(text("""
        UPDATE reports rel SET incident_id = p.incident_id
        FROM report_duplicate_decisions d
        JOIN reports p ON p.id = d.primary_report_id
        WHERE d.undone_at IS NULL AND d.decision = 'CONFIRMED_DUP'
          AND rel.id = d.related_report_id
          AND rel.incident_id IS NULL
          AND rel.deletion_requested_at IS NULL
          AND p.incident_id IS NOT NULL
    """))

    # 4. Roll up member counts (always) + max severity (unless analyst-overridden)
    #    now that every member is linked. Standalones already carry count=1 and the
    #    lead's severity, so the <> guards make those rows no-ops.
    bind.execute(text("""
        UPDATE incidents i SET report_count = sub.cnt
        FROM (
            SELECT incident_id, COUNT(*) AS cnt
            FROM reports
            WHERE incident_id IS NOT NULL AND deletion_requested_at IS NULL
            GROUP BY incident_id
        ) sub
        WHERE i.id = sub.incident_id AND i.report_count <> sub.cnt
    """))
    bind.execute(text(f"""
        UPDATE incidents i SET severity = sub.max_sev
        FROM (
            SELECT incident_id,
                   COALESCE((ARRAY_AGG(severity::text ORDER BY {_SEV_RANK.format(c='severity')} DESC))[1], 'UNKNOWN') AS max_sev
            FROM reports
            WHERE incident_id IS NOT NULL AND deletion_requested_at IS NULL
            GROUP BY incident_id
        ) sub
        WHERE i.id = sub.incident_id AND i.severity_overridden = false AND i.severity <> sub.max_sev
    """))


def upgrade() -> None:
    _backfill(op.get_bind())


def downgrade() -> None:
    bind = op.get_bind()
    # Unlink first (the FK is ON DELETE SET NULL, so deleting incidents would do
    # this anyway, but be explicit), then empty the table → post-0058 state.
    bind.execute(text("UPDATE reports SET incident_id = NULL WHERE incident_id IS NOT NULL"))
    bind.execute(text("DELETE FROM incidents"))
