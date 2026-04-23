"""Migration 0008 — performance-index inventory regression.

The TRL-4 500k-scale claim to UNDP rests on every dashboard / API
filter path hitting a btree index. Migration 0008 adds ten single-
column + three composite indexes covering the time-range, status,
crisis-type, severity, damage-classification, device-id, verdict, and
soft-delete axes.

This test talks to `pg_indexes` and asserts every expected index is
present after `alembic upgrade head`. If someone later drops one of
these (or the 0008 migration is reverted without a replacement), the
test goes red — long before a production 500k-row query starts
timing out under sequential scan.

Pattern mirrors `tests/test_migrations.py::test_schema_parity_with_orm`.
"""
import pytest
from sqlalchemy import text


EXPECTED_INDEX_NAMES = {
    # Single-column.
    "ix_reports_server_created_at",
    "ix_reports_status",
    "ix_reports_crisis_type",
    "ix_reports_severity",
    "ix_reports_damage_classification",
    "ix_reports_device_id",
    "ix_reports_reviewer_verdict",
    "ix_reports_deletion_requested_at",
    "ix_auth_audit_log_created_at",
    "ix_media_created_at",
    # Composite.
    "ix_reports_status_created",
    "ix_reports_building_created",
    "ix_reports_device_created",
}


class TestPerfIndexes:
    def test_every_0008_index_is_live(self, db):
        """All 13 indexes added by migration 0008 exist on Postgres.

        Queries `pg_indexes` directly — dialect-specific but we're
        Postgres-only (April 2026). Set difference surfaces any missing
        index so the fix is a trivial `CREATE INDEX IF NOT EXISTS`
        resurrect rather than an archaeology expedition.
        """
        rows = db.execute(
            text("SELECT indexname FROM pg_indexes "
                 "WHERE schemaname='public' AND indexname LIKE 'ix_%'")
        ).fetchall()
        present = {r[0] for r in rows}
        missing = EXPECTED_INDEX_NAMES - present
        assert not missing, (
            f"missing performance indexes (migration 0008 regressed?): "
            f"{sorted(missing)}"
        )

    def test_composite_index_uses_correct_columns(self, db):
        """`ix_reports_status_created` must cover (status, server_created_at)
        in that order. Wrong column order means the time-windowed
        filter-by-status query can't use the index tail.
        """
        rows = db.execute(text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE indexname = 'ix_reports_status_created'"
        )).fetchall()
        assert rows, "ix_reports_status_created missing"
        defn = rows[0][0]
        # Column order matters for btree range queries.
        assert '(status, server_created_at)' in defn, defn
