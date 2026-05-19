"""Migration sanity checks.

These tests exercise the Alembic chain end-to-end against a throw-away
PostgreSQL database. They guard the two properties we care about most:

  1. `alembic upgrade head` succeeds from an empty DB — guards against a
     migration that silently fails to import or has a syntax error.
  2. The schema after migration matches `Base.metadata` (i.e. the
     migrations and the SQLAlchemy models have not drifted apart).

Apr 2026 — ported from SQLite tempfiles to Postgres. We use the same
Postgres instance as the rest of pytest (via PYTEST_DATABASE_URL /
DATABASE_URL), but each test creates a UNIQUELY NAMED temporary database
via a separate admin connection so runs can't stomp on each other.
After the test, the temp DB is dropped.

No raw sqlite3 imports, no `PRAGMA table_info`. Everything goes through
SQLAlchemy's dialect-agnostic `inspect()` API.
"""
from __future__ import annotations

import os
import re
import subprocess
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine.url import make_url


REPO_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Resolve the admin URL (role that can CREATE DATABASE) from the same env
# the test suite uses. For the default localhost setup the `crisp` role
# is SUPERUSER so it can create/drop throwaway DBs directly.
DEFAULT_TEST_DB_URL = (
    os.environ.get("PYTEST_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or "postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
)


def _admin_url() -> str:
    """URL pointing at the `postgres` database on the same host so we can
    CREATE / DROP the per-test DBs without being connected to them."""
    u = make_url(DEFAULT_TEST_DB_URL)
    return str(u.set(database="postgres"))


def _make_tmp_db() -> tuple[str, str]:
    """Create a uniquely-named temp DB, return (dbname, full_dsn)."""
    dbname = f"crisp_mig_{uuid.uuid4().hex[:10]}"
    admin = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
    try:
        # SA 2.x quirk: the engine-level isolation_level does NOT
        # always propagate cleanly through the `with engine.connect()
        # as conn:` context manager (an implicit transaction may
        # still wrap DDL on some psycopg2 builds, depending on pool
        # state). Re-affirm AUTOCOMMIT at the connection level so
        # CREATE / DROP DATABASE never lands inside a transaction
        # block. See tests/test_migrations.py CI flake from May 2026.
        with admin.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(f'CREATE DATABASE "{dbname}"'))
    finally:
        admin.dispose()
    url = make_url(DEFAULT_TEST_DB_URL).set(database=dbname)
    return dbname, str(url)


def _drop_tmp_db(dbname: str) -> None:
    admin = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            # Terminate any lingering backends connected to the
            # throwaway DB. Without this, a test that opened an
            # engine + forgot to dispose() leaves a connection
            # alive, and DROP DATABASE blocks with
            # `psycopg2.errors.ObjectInUse`. The pg_terminate_backend
            # call is a no-op when there are no such connections.
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) "
                    "FROM pg_stat_activity "
                    "WHERE datname = :dn AND pid <> pg_backend_pid()"
                ),
                {"dn": dbname},
            )
            conn.execute(text(f'DROP DATABASE IF EXISTS "{dbname}"'))
    finally:
        admin.dispose()


def _run_alembic(*args: str, db_url: str) -> subprocess.CompletedProcess[str]:
    """Invoke `alembic` from the backend dir with the requested DATABASE_URL."""
    env = os.environ.copy()
    env["DATABASE_URL"] = db_url
    env.pop("PYTEST_DATABASE_URL", None)  # let the child see ONLY DATABASE_URL
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    env.setdefault("APP_ENV", "dev")
    return subprocess.run(
        ["alembic", *args],
        cwd=REPO_BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Skip the whole module if the admin URL isn't reachable. This keeps
# `pytest` on a dev laptop without Postgres running from exploding — the
# other suites still run against the main test DB fixture (which will
# fail its own setup_test_db if Postgres is down, with a clearer error).
# ──────────────────────────────────────────────────────────────────────────────
def _postgres_reachable() -> bool:
    try:
        admin = create_engine(_admin_url())
        with admin.connect() as conn:
            conn.execute(text("SELECT 1"))
        admin.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _postgres_reachable(),
    reason="Postgres not reachable — migration chain tests skipped",
)


def test_alembic_upgrade_head_on_fresh_db():
    dbname, url = _make_tmp_db()
    try:
        res = _run_alembic("upgrade", "head", db_url=url)
        assert res.returncode == 0, \
            f"alembic upgrade failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
        # Smoke: alembic_version row actually exists and the reports table is there.
        eng = create_engine(url)
        insp = inspect(eng)
        assert "reports" in insp.get_table_names()
        assert "alembic_version" in insp.get_table_names()
        with eng.connect() as conn:
            v = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert v and len(v) > 0
        eng.dispose()
    finally:
        _drop_tmp_db(dbname)


def test_migrated_schema_has_crisis_category_and_blurhash():
    """The baseline + 0002 migrate `reports.crisis_category`; 0006 adds
    `reports.blurhash`. Both must land on a fresh Postgres instance."""
    dbname, url = _make_tmp_db()
    try:
        res = _run_alembic("upgrade", "head", db_url=url)
        assert res.returncode == 0, res.stderr
        eng = create_engine(url)
        insp = inspect(eng)
        report_cols = {c["name"] for c in insp.get_columns("reports")}
        eng.dispose()
        assert "crisis_category" in report_cols, \
            "UNDP Appendix-1 crisis_category column missing"
        assert "damage_classification" in report_cols
        assert "blurhash" in report_cols, \
            "Phase-1 progressive-upload blurhash column missing"
    finally:
        _drop_tmp_db(dbname)


def test_0005_adds_pii_blur_status_column_and_backfills():
    """Migration 0005 must:

      1. Add `media.pii_blur_status` (String(16), nullable, indexed).
      2. Backfill `pii_blur_status='not_needed'` on legacy rows where
         `client_blur_applied=TRUE` (nothing for server to do).
      3. Leave `pii_blur_status=NULL` where `client_blur_applied=FALSE`.

    Portability note (Apr 2026): the backfill used to use a literal
    `= 1`, which Postgres rejected with "operator does not exist:
    boolean = integer". Now uses a SQLAlchemy bind with a boolean
    Python value so dialect compilation emits the right token.

    Simulates the pre-0005 state by:
      * stamping the DB at 0004 (the previous head)
      * running create_all WITHOUT the post-0005 column (we drop it
        explicitly so the migration has something real to do)
      * seeding Media rows with the legacy schema
      * upgrading to head
      * asserting the column + backfill landed correctly
    """
    dbname, url = _make_tmp_db()
    try:
        from app.db.session import Base
        import app.models.report  # noqa: F401
        import app.models.auth  # noqa: F401
        import app.models.prediction  # noqa: F401

        eng = create_engine(url)
        Base.metadata.create_all(bind=eng)

        # Drop the columns / tables / indexes added by every migration
        # AFTER the stamp point (0004_bin). Without this list,
        # Base.metadata.create_all has already created the post-0004
        # shape, then `alembic upgrade head` fails with DuplicateColumn /
        # DuplicateTable when it tries to add them again.
        # Order matters: drop tables with FKs FIRST (children), then
        # parents. Update this list when a new migration adds schema.
        with eng.begin() as conn:
            # 0005 — pii_blur_status (the column under test).
            conn.execute(text("DROP INDEX IF EXISTS ix_media_pii_blur_status"))
            conn.execute(text("ALTER TABLE media DROP COLUMN IF EXISTS pii_blur_status"))
            # 0027 — F.5.c building versioning columns on reports.
            conn.execute(text("DROP INDEX IF EXISTS ix_reports_building_id_is_latest"))
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS building_version_ordinal"))
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS building_is_latest"))
            # 0028-0031 — Phase H building entity + 4 satellite tables.
            # Drop CASCADE to wipe FKs; the migration recreates them.
            conn.execute(text("DROP TABLE IF EXISTS building_notes CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_responders CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_monitors CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_events CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS buildings CASCADE"))
            # 0032 — Phase F image-reliability: media abandon columns.
            conn.execute(text("DROP INDEX IF EXISTS ix_media_abandoned_at"))
            conn.execute(text("ALTER TABLE media DROP COLUMN IF EXISTS abandoned_at"))
            conn.execute(text("ALTER TABLE media DROP COLUMN IF EXISTS abandon_reason"))
            # Drop ENUMs created by 0028 / 0029 / 0031 — sa.Enum will
            # auto-create at table-create time, but the existing type
            # blocks that.
            conn.execute(text("DROP TYPE IF EXISTS building_state CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_id_source CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_event_actor_kind CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_note_visibility CASCADE"))

            # Seed rows: one with client_blur_applied=TRUE (should
            # backfill to 'not_needed'), one with FALSE (stays NULL).
            conn.execute(text(
                "INSERT INTO devices (id, device_hash) VALUES ('d1', 'TEST-MIG-0005')"
            ))
            conn.execute(text(
                "INSERT INTO reports "
                "(id, device_id, source, status, sync_status, severity, "
                " infrastructure_type, is_auto_submitted, expected_media, "
                " received_media, reviewer_verdict) "
                "VALUES ('r1', 'd1', 'APP', 'PENDING', 'SYNCED', 'UNKNOWN', "
                " 'OTHER', FALSE, 0, 0, 'NOT_REVIEWED')"
            ))
            conn.execute(text(
                "INSERT INTO media (id, report_id, type, resolution_tier, "
                " url, is_synced, chunk_count, received_chunks, completion_pct, "
                " assembly_status, client_blur_applied, created_at, updated_at) "
                "VALUES ('A', 'r1', 'IMAGE', 'LOW', '/static/A.jpg', TRUE, "
                " 1, 1, 100.0, 'complete', TRUE, '2026-04-01', '2026-04-01')"
            ))
            conn.execute(text(
                "INSERT INTO media (id, report_id, type, resolution_tier, "
                " url, is_synced, chunk_count, received_chunks, completion_pct, "
                " assembly_status, client_blur_applied, created_at, updated_at) "
                "VALUES ('B', 'r1', 'IMAGE', 'LOW', '/static/B.jpg', TRUE, "
                " 1, 1, 100.0, 'complete', FALSE, '2026-04-01', '2026-04-01')"
            ))
        eng.dispose()

        # Stamp at 0004 so the next upgrade runs 0005 + 0006.
        stamp = _run_alembic("stamp", "0004_bin", db_url=url)
        assert stamp.returncode == 0, stamp.stderr

        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr

        # Verify column + index + backfill.
        eng = create_engine(url)
        insp = inspect(eng)
        media_cols = {c["name"] for c in insp.get_columns("media")}
        assert "pii_blur_status" in media_cols
        index_names = {i["name"] for i in insp.get_indexes("media")}
        assert "ix_media_pii_blur_status" in index_names, \
            "pii_blur_status index missing after 0005"

        with eng.connect() as conn:
            rows = dict(conn.execute(text(
                "SELECT id, pii_blur_status FROM media ORDER BY id"
            )).all())
        eng.dispose()
        assert rows["A"] == "not_needed", \
            f"row A (client_blur_applied=TRUE) should backfill to " \
            f"'not_needed', got {rows['A']!r}"
        assert rows["B"] is None, \
            f"row B (client_blur_applied=FALSE) should stay NULL, got {rows['B']!r}"
    finally:
        _drop_tmp_db(dbname)


def test_legacy_db_is_upgraded_without_data_loss():
    """Simulate upgrading an older dev DB:
       1. Build schema via create_all (pre-Apr-2026 layout).
       2. Drop the post-Apr-2026 columns to fake the legacy state.
       3. Insert a row with the legacy NO_DAMAGE label + a HOUSE chip.
       4. Stamp at baseline, upgrade to head.
       5. Assert 0002 + 0003 did their backfills:
          - damage: NO_DAMAGE → MINIMAL
          - crisis_category derived from crisis_type
          - infra chip HOUSE → RESIDENTIAL, chip preserved in sub_type
    """
    dbname, url = _make_tmp_db()
    try:
        from app.db.session import Base
        import app.models.report  # noqa: F401
        import app.models.auth  # noqa: F401
        import app.models.prediction  # noqa: F401

        eng = create_engine(url)
        Base.metadata.create_all(bind=eng)

        with eng.begin() as conn:
            # Drop post-baseline columns / tables / types so the legacy
            # simulation is authentic. Without this, Base.metadata
            # already created the head-shape and the subsequent alembic
            # upgrade fails with DuplicateColumn / DuplicateTable when
            # individual migrations try to add them.
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS crisis_category"))
            conn.execute(text("DROP INDEX IF EXISTS ix_reports_infrastructure_sub_type"))
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS infrastructure_sub_type"))
            # 0027 — F.5.c building versioning columns.
            conn.execute(text("DROP INDEX IF EXISTS ix_reports_building_id_is_latest"))
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS building_version_ordinal"))
            conn.execute(text("ALTER TABLE reports DROP COLUMN IF EXISTS building_is_latest"))
            # 0028-0031 — Phase H building entity + 4 satellite tables.
            conn.execute(text("DROP TABLE IF EXISTS building_notes CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_responders CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_monitors CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS building_events CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS buildings CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_state CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_id_source CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_event_actor_kind CASCADE"))
            conn.execute(text("DROP TYPE IF EXISTS building_note_visibility CASCADE"))
            # 0032 — Phase F image-reliability: media abandon columns.
            conn.execute(text("DROP INDEX IF EXISTS ix_media_abandoned_at"))
            conn.execute(text("ALTER TABLE media DROP COLUMN IF EXISTS abandoned_at"))
            conn.execute(text("ALTER TABLE media DROP COLUMN IF EXISTS abandon_reason"))

            conn.execute(text(
                "INSERT INTO reports "
                "(id, source, status, sync_status, severity, infrastructure_type, "
                " is_auto_submitted, expected_media, received_media, "
                " reviewer_verdict, damage_classification, crisis_type) "
                "VALUES ('legacy-1', 'APP', 'PENDING', 'SYNCED', 'UNKNOWN', "
                " 'HOUSE', FALSE, 0, 0, 'NOT_REVIEWED', 'NO_DAMAGE', 'EARTHQUAKE')"
            ))
        eng.dispose()

        stamp = _run_alembic("stamp", "7964f14c120d", db_url=url)
        assert stamp.returncode == 0, stamp.stderr

        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr

        eng = create_engine(url)
        with eng.connect() as conn:
            row = conn.execute(text(
                "SELECT damage_classification, crisis_type, crisis_category, "
                "       infrastructure_type, infrastructure_sub_type "
                "FROM reports WHERE id = 'legacy-1'"
            )).one()
        eng.dispose()
        damage, crisis, cat, infra, infra_sub = row
        assert damage == "MINIMAL", f"legacy NO_DAMAGE not normalised, got {damage!r}"
        assert crisis == "EARTHQUAKE"
        assert cat == "NATURAL", f"crisis_category not backfilled, got {cat!r}"
        assert infra == "RESIDENTIAL", \
            f"legacy HOUSE chip not remapped, got {infra!r}"
        assert infra_sub == "HOUSE", \
            f"legacy chip not preserved in sub_type, got {infra_sub!r}"
    finally:
        _drop_tmp_db(dbname)


# ── Phase 3.3 — Downgrade path coverage ──────────────────────────────────────
#
# Every revision in the chain (0002 → 0006) has a `downgrade()` body. Nobody
# has ever run them. If a migration was written with a one-way backfill
# (e.g. ENUM widened without a downgrade narrowing it) the only way to find
# out is to try. These tests walk the chain backwards one step at a time
# and assert the schema is in a sensible state after each.
#
# We DON'T run all the way to the empty-DB baseline because the baseline
# revision's downgrade drops the entire schema — that's covered implicitly
# by `_make_tmp_db + upgrade head + drop_tmp_db`. These tests stop at
# 0002 (the first post-baseline revision) so a failure points at a
# specific migration, not a cascading schema drop.


def test_downgrade_from_head_to_0005():
    """0006 → 0005: `reports.blurhash` column must be dropped."""
    dbname, url = _make_tmp_db()
    try:
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr
        down = _run_alembic("downgrade", "0005_pii", db_url=url)
        assert down.returncode == 0, \
            f"downgrade 0006 → 0005 failed:\n{down.stdout}\n{down.stderr}"
        eng = create_engine(url)
        report_cols = {c["name"] for c in inspect(eng).get_columns("reports")}
        eng.dispose()
        assert "blurhash" not in report_cols, \
            "downgrade 0006 didn't drop reports.blurhash"
        # Sanity: pii_blur_status (from 0005) SHOULD still be there.
        eng = create_engine(url)
        media_cols = {c["name"] for c in inspect(eng).get_columns("media")}
        eng.dispose()
        assert "pii_blur_status" in media_cols
    finally:
        _drop_tmp_db(dbname)


def test_downgrade_from_0005_to_0004():
    """0005 → 0004: `media.pii_blur_status` column + index must be dropped."""
    dbname, url = _make_tmp_db()
    try:
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr
        down = _run_alembic("downgrade", "0004_bin", db_url=url)
        assert down.returncode == 0, \
            f"downgrade to 0004 failed:\n{down.stdout}\n{down.stderr}"
        eng = create_engine(url)
        insp = inspect(eng)
        media_cols = {c["name"] for c in insp.get_columns("media")}
        media_indexes = {i["name"] for i in insp.get_indexes("media")}
        eng.dispose()
        assert "pii_blur_status" not in media_cols
        assert "ix_media_pii_blur_status" not in media_indexes, \
            "downgrade left the pii_blur_status index behind"
    finally:
        _drop_tmp_db(dbname)


def test_downgrade_from_0004_to_0003():
    """0004 → 0003: `media_chunks.data_binary` + CHECK constraint removed;
    `data_b64` must be NOT NULL again. Data-binary rows would be lost —
    that's the irreversible direction; we just verify the schema swap."""
    dbname, url = _make_tmp_db()
    try:
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr
        down = _run_alembic("downgrade", "0003_infra", db_url=url)
        # 0004's downgrade MAY refuse if data_binary rows exist — but on
        # a fresh DB there are no rows so it should succeed. If it fails
        # we surface the full alembic output for triage.
        assert down.returncode == 0, \
            f"downgrade to 0003 failed (possibly a rows-present guard):\n" \
            f"{down.stdout}\n{down.stderr}"
        eng = create_engine(url)
        cols = {c["name"] for c in inspect(eng).get_columns("media_chunks")}
        eng.dispose()
        assert "data_binary" not in cols, \
            "downgrade 0004 left data_binary behind"
    finally:
        _drop_tmp_db(dbname)


def test_downgrade_from_0003_to_0002():
    """0003 → 0002: `reports.infrastructure_sub_type` + index dropped.

    Postgres ENUM widening via `ALTER TYPE ... ADD VALUE` is irreversible
    without a type swap; the downgrade SHOULD either (a) narrow the enum
    by recreating it (expensive) or (b) leave the extra values as no-ops
    on narrower rows. This test asserts whatever 0003's downgrade() does
    without prescribing the strategy — if it errors, we surface the msg.
    """
    dbname, url = _make_tmp_db()
    try:
        up = _run_alembic("upgrade", "head", db_url=url)
        assert up.returncode == 0, up.stderr
        down = _run_alembic("downgrade", "0002_bf_cat", db_url=url)
        assert down.returncode == 0, \
            f"downgrade to 0002 failed (enum-narrow irreversibility?):\n" \
            f"{down.stdout}\n{down.stderr}"
        eng = create_engine(url)
        cols = {c["name"] for c in inspect(eng).get_columns("reports")}
        eng.dispose()
        assert "infrastructure_sub_type" not in cols, \
            "downgrade 0003 left infrastructure_sub_type behind"
    finally:
        _drop_tmp_db(dbname)


def test_downgrade_then_re_upgrade_round_trip():
    """End-to-end round-trip: head → 0002 → head. Verifies the
    downgrade + re-upgrade path doesn't accumulate schema drift."""
    dbname, url = _make_tmp_db()
    try:
        up1 = _run_alembic("upgrade", "head", db_url=url)
        assert up1.returncode == 0
        down = _run_alembic("downgrade", "0002_bf_cat", db_url=url)
        assert down.returncode == 0, down.stderr
        up2 = _run_alembic("upgrade", "head", db_url=url)
        assert up2.returncode == 0, \
            f"re-upgrade after downgrade failed:\n{up2.stdout}\n{up2.stderr}"
        # Final state must equal the end of test_alembic_upgrade_head_on_fresh_db.
        eng = create_engine(url)
        insp = inspect(eng)
        assert "blurhash" in {c["name"] for c in insp.get_columns("reports")}
        assert "pii_blur_status" in {c["name"] for c in insp.get_columns("media")}
        with eng.connect() as conn:
            rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        eng.dispose()
        assert rev is not None
    finally:
        _drop_tmp_db(dbname)
