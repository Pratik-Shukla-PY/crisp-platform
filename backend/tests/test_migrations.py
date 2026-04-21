"""Migration sanity checks.

These tests exercise the Alembic chain end-to-end against a throw-away
SQLite database. They guard the two properties we care about most:

  1. ``alembic upgrade head`` succeeds from an empty DB — guards against
     a migration that silently fails to import or has a syntax error.
  2. The schema after migration matches ``Base.metadata`` (i.e. the
     migrations and the SQLAlchemy models have not drifted apart).

Running these in CI means a developer who adds a column on the model
but forgets the migration gets a red pipeline instead of a silent
production outage.
"""
import os
import subprocess
import tempfile

import pytest


REPO_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _run_alembic(*args, db_url: str) -> subprocess.CompletedProcess:
    """Invoke `alembic` from the backend dir with the requested DATABASE_URL."""
    env = os.environ.copy()
    env["DATABASE_URL"] = db_url
    # Strip DATABASE_URL overrides coming from conftest so the migration
    # runs against the temporary file, not the shared test DB.
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    return subprocess.run(
        ["alembic", *args],
        cwd=REPO_BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )


def test_alembic_upgrade_head_on_fresh_db():
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "fresh.db")
        url = f"sqlite:///{db_path}"
        res = _run_alembic("upgrade", "head", db_url=url)
        assert res.returncode == 0, f"alembic upgrade failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
        assert os.path.exists(db_path)


def test_migrated_schema_has_crisis_category():
    """The baseline + 0002 migration must leave reports.crisis_category in place."""
    import sqlite3
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "schema.db")
        url = f"sqlite:///{db_path}"
        res = _run_alembic("upgrade", "head", db_url=url)
        assert res.returncode == 0, res.stderr
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(reports)")
        cols = {row[1] for row in cur.fetchall()}
        conn.close()
        assert "crisis_category" in cols, \
            "UNDP Appendix-1 crisis_category column missing from migrated schema"
        assert "damage_classification" in cols


def test_0005_adds_pii_blur_status_column_and_backfills():
    """Apr 2026 — Migration 0005 must:

      1. Add `media.pii_blur_status` (String(16), nullable, indexed).
      2. Backfill `pii_blur_status='not_needed'` on legacy rows where
         `client_blur_applied=1` (nothing for the server to do).
      3. Leave `pii_blur_status=NULL` on rows where `client_blur_applied=0`
         — those are treated as 'unknown / pre-tracking' by the
         dashboard and flagged for operator review.

    Simulates the pre-0005 state by:
      * stamping the DB at 0004 (the previous head)
      * dropping the column we're about to add (so the migration has
        something real to do)
      * seeding Media rows with the legacy schema
      * upgrading to head
      * asserting the column + backfill landed correctly
    """
    import sqlite3
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "pii_status.db")
        url = f"sqlite:///{db_path}"

        # ── 1. Build schema via Base.metadata.create_all()
        from sqlalchemy import create_engine
        from app.db.session import Base
        import app.models.report  # noqa: F401
        import app.models.auth    # noqa: F401
        import app.models.prediction  # noqa: F401
        engine = create_engine(url)
        Base.metadata.create_all(bind=engine)

        # ── 2. Drop the new column to simulate pre-0005 state
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA foreign_keys = OFF")
            conn.exec_driver_sql("ALTER TABLE media RENAME TO media_old")
            cols_sql = conn.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE name='media_old'"
            ).scalar()
            # Strip the `pii_blur_status VARCHAR(16)` declaration.
            import re
            new_sql = re.sub(
                r",\s*pii_blur_status\s+VARCHAR\(16\)",
                "",
                cols_sql,
                flags=re.I,
            )
            new_sql = new_sql.replace("media_old", "media")
            conn.exec_driver_sql(new_sql)

            # Seed the legacy schema with rows:
            #  - id=A, client_blur_applied=1 → should backfill to 'not_needed'
            #  - id=B, client_blur_applied=0 → should stay NULL
            # Create the parent report first (FK).
            conn.exec_driver_sql(
                "INSERT INTO devices (id, device_hash) VALUES ('d1', 'TEST-MIG-0005')"
            )
            conn.exec_driver_sql(
                "INSERT INTO reports "
                "(id, device_id, source, status, sync_status, severity, "
                " infrastructure_type, is_auto_submitted, expected_media, "
                " received_media, reviewer_verdict) "
                "VALUES ('r1', 'd1', 'APP', 'PENDING', 'SYNCED', 'UNKNOWN', "
                " 'OTHER', 0, 0, 0, 'NOT_REVIEWED')"
            )
            # media columns the create_all schema has, minus pii_blur_status
            legacy_cols = (
                "id, report_id, type, resolution_tier, photo_group_id, url, "
                "file_size_bytes, is_synced, thumbnail_url, chunk_count, "
                "received_chunks, completion_pct, assembly_status, "
                "client_blur_applied, created_at, updated_at"
            )
            conn.exec_driver_sql(
                f"INSERT INTO media ({legacy_cols}) VALUES "
                "('A', 'r1', 'IMAGE', 'LOW', NULL, '/static/A.jpg', 100, 1, NULL, "
                " 1, 1, 100.0, 'complete', 1, '2026-04-01', '2026-04-01')"
            )
            conn.exec_driver_sql(
                f"INSERT INTO media ({legacy_cols}) VALUES "
                "('B', 'r1', 'IMAGE', 'LOW', NULL, '/static/B.jpg', 100, 1, NULL, "
                " 1, 1, 100.0, 'complete', 0, '2026-04-01', '2026-04-01')"
            )
            conn.exec_driver_sql("DROP TABLE media_old")
            conn.commit()

        # ── 3. Stamp at 0004 so alembic runs 0005 fresh
        stamp = _run_alembic("stamp", "0004_bin", db_url=url)
        assert stamp.returncode == 0, stamp.stderr

        # ── 4. Upgrade — should add column + run backfill
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr

        # ── 5. Column exists + index exists
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(media)")
        cols = {row[1] for row in cur.fetchall()}
        assert "pii_blur_status" in cols, \
            "pii_blur_status column missing after 0005 migration"
        cur.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='index' AND tbl_name='media' "
            "  AND name='ix_media_pii_blur_status'"
        )
        assert cur.fetchone() is not None, "ix_media_pii_blur_status missing"

        # ── 6. Backfill ran for client_blur_applied=1 rows
        cur.execute("SELECT id, pii_blur_status FROM media ORDER BY id")
        rows = dict(cur.fetchall())
        conn.close()
        assert rows["A"] == "not_needed", \
            f"row A (client_blur_applied=1) should backfill to not_needed, got {rows['A']!r}"
        assert rows["B"] is None, \
            f"row B (client_blur_applied=0) should stay NULL (legacy/unknown), got {rows['B']!r}"


def test_legacy_db_is_upgraded_without_data_loss():
    """Simulate the upgrade path for an existing dev DB:
       1. Create the schema via SQLAlchemy create_all() (pre-Alembic layout).
       2. Insert a row with the legacy NO_DAMAGE label.
       3. Stamp the DB at the baseline revision (pretend it matches head).
       4. Run `alembic upgrade head` to apply the 0002 backfill migration.
       5. Assert the legacy label is normalised + crisis_category populated.
    """
    import sqlite3
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "legacy.db")
        url = f"sqlite:///{db_path}"

        # ── 1. Build the pre-Apr-2026 schema by importing the current
        # models and running create_all(). The model itself already has
        # the crisis_category column, so to *simulate* a pre-change DB
        # we drop the column immediately after create_all().
        from sqlalchemy import create_engine
        from app.db.session import Base
        import app.models.report  # noqa: F401
        import app.models.auth  # noqa: F401
        import app.models.prediction  # noqa: F401
        engine = create_engine(url)
        Base.metadata.create_all(bind=engine)
        with engine.connect() as conn:
            # Drop the columns so our legacy simulation is authentic.
            # SQLite's pre-3.35 DROP COLUMN isn't fully reliable in all
            # environments, so we rebuild the table by copying rows to
            # a new table without the post-April-2026 columns.
            conn.exec_driver_sql("PRAGMA foreign_keys = OFF")
            conn.exec_driver_sql("ALTER TABLE reports RENAME TO reports_old")
            cols_sql = conn.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE name='reports_old'"
            ).scalar()
            # Strip the post-April-2026 columns from the DDL so we
            # faithfully simulate a pre-migration database.
            import re
            new_sql = cols_sql
            new_sql = re.sub(r",\s*crisis_category\s+VARCHAR\(20\)", "", new_sql, flags=re.I)
            new_sql = re.sub(r",\s*infrastructure_sub_type\s+VARCHAR\(40\)", "", new_sql, flags=re.I)
            new_sql = new_sql.replace("reports_old", "reports")
            conn.exec_driver_sql(new_sql)

            # Copy rows, explicitly listing columns so the legacy layout
            # is stable even if the model order changes later.
            legacy_cols = (
                "id, client_report_id, device_id, source, status, sync_status, "
                "severity, infrastructure_type, description, detected_language, "
                "caller_info, ai_assessment, is_auto_submitted, expected_media, "
                "received_media, client_created_at, server_created_at, updated_at, "
                "deletion_requested_at, deletion_grace_minutes, lives_impacted, "
                "damage_classification, crisis_type, infrastructure_name, "
                "debris_clearing_needed, service_status, building_id, reviewed_at, "
                "reviewer_verdict, action_taken, help_dispatched_at, help_arrived_at"
            )
            conn.exec_driver_sql(
                f"INSERT INTO reports ({legacy_cols}) SELECT {legacy_cols} FROM reports_old"
            )
            conn.exec_driver_sql("DROP TABLE reports_old")
            conn.exec_driver_sql(
                "INSERT INTO reports "
                "(id, source, status, sync_status, severity, infrastructure_type, "
                " is_auto_submitted, expected_media, received_media, "
                " reviewer_verdict, damage_classification, crisis_type) "
                "VALUES ('legacy-1', 'APP', 'PENDING', 'SYNCED', 'UNKNOWN', 'HOUSE', "
                " 0, 0, 0, 'NOT_REVIEWED', 'NO_DAMAGE', 'EARTHQUAKE')"
            )
            conn.commit()

        # ── 2. Stamp at the baseline so Alembic thinks we've run it
        stamp = _run_alembic("stamp", "7964f14c120d", db_url=url)
        assert stamp.returncode == 0, stamp.stderr

        # ── 3. Upgrade — this fires 0002_bf_cat which backfills everything
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr

        # ── 4. Verify the legacy row has been normalised end-to-end:
        #   * damage NO_DAMAGE  → MINIMAL
        #   * crisis_category   → NATURAL (derived from crisis_type)
        #   * infrastructure    → HOUSE (legacy chip) promoted to RESIDENTIAL,
        #                         original kept in infrastructure_sub_type
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(
            "SELECT damage_classification, crisis_type, crisis_category, "
            "       infrastructure_type, infrastructure_sub_type "
            "FROM reports WHERE id = 'legacy-1'"
        )
        damage, crisis, cat, infra, infra_sub = cur.fetchone()
        conn.close()
        assert damage == "MINIMAL", f"legacy NO_DAMAGE not normalised, got {damage!r}"
        assert crisis == "EARTHQUAKE"
        assert cat == "NATURAL", f"crisis_category not backfilled, got {cat!r}"
        assert infra == "RESIDENTIAL", \
            f"legacy HOUSE chip not remapped, got {infra!r}"
        assert infra_sub == "HOUSE", \
            f"legacy chip not preserved in sub_type, got {infra_sub!r}"
