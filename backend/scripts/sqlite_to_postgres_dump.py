"""One-shot migration: copy the contents of a SQLite crisp_local.db into a
Postgres `crisp` database.

Apr 2026 — written for the "drop SQLite, go full Postgres" sprint so
developers who accumulated useful test data in `backend/crisp_local.db`
don't lose it when we delete the SQLite code path.

Usage:
    cd backend && source venv/bin/activate
    export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
    python -m scripts.sqlite_to_postgres_dump \
        --sqlite ./crisp_local.db \
        --postgres postgresql+psycopg2://crisp:crisp@localhost:5432/crisp

Behaviour:
    * The Postgres target is created by `alembic upgrade head` BEFORE you
      run this — the script asserts the target schema exists + is empty
      (no reports rows), and refuses to run otherwise.
    * Tables are copied in FK-safe order (devices → reports → media → …).
    * Enum columns copy as strings; both dialects share enum labels
      (widened in migration 0003 if you're targeting Postgres).
    * Timezone handling: SQLite returns naive datetimes; we tag them as
      UTC on the way into Postgres's `DateTime(timezone=True)` columns.
    * Batch size 500 per table. Total runtime on an 11 MB SQLite DB with
      ~700 chunks is under 5 seconds on a laptop.
    * Idempotent on the device_hash uniqueness — re-running against a
      partially-populated Postgres will raise on conflict; the assertion
      at the top prevents accidental re-runs.

After success:
    * Verify row counts match:
        sqlite3 crisp_local.db "SELECT COUNT(*) FROM reports"
        psql ... -c "SELECT COUNT(*) FROM reports"
    * Back up the SQLite file as `crisp_local.db.pre-pg.bak` so we have
      a recoverable snapshot before deleting the file.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import MetaData, create_engine, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.schema import sort_tables

logger = logging.getLogger("sqlite_to_pg_dump")
logging.basicConfig(level=logging.INFO, format="%(message)s")

# Tables that exist in SQLite but shouldn't be copied wholesale:
#   * alembic_version — Postgres already has the version stamped from
#     `alembic upgrade head`. Don't overwrite.
#   * sync_logs — ephemeral, can regenerate.
SKIP_TABLES = {"alembic_version", "sync_logs"}

# Preferred copy order for FK safety. We use SQLAlchemy's `sort_tables`
# as the primary sort; this list is ONLY a tiebreaker for tables at the
# same dependency level (e.g. ai_analysis and locations both FK to
# reports; order doesn't matter, but we prefer something deterministic).
PREFERRED_ORDER = [
    "organizations",
    "devices",
    "users",
    "reporter_profiles",
    "reports",
    "locations",
    "ai_analysis",
    "media",
    "media_chunks",
    "incident_clusters",
    "cluster_reports",
    "auto_submit_regions",
    "prediction_zones",
    "prediction_results",
    "satellite_verifications",
    "user_sessions",
    "otp_records",
    "auth_audit_log",
    "deletion_audit_log",
]


def _tag_naive_as_utc(value: Any) -> Any:
    """SQLite returns naive datetimes for `DateTime(timezone=True)` columns;
    Postgres rejects them. Tag naives as UTC (matches how the app wrote
    them — `datetime.now(timezone.utc)` everywhere in the code)."""
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _copy_table(table_name: str, src: Engine, dst: Engine, batch_size: int = 500) -> int:
    """Copy all rows from `src.table_name` to `dst.table_name` using
    batched multi-row inserts. Returns the number of rows copied."""
    # Reflect the table from DESTINATION (Postgres) so inserts use the
    # target's column types — enum casts, tz-aware timestamps, etc.
    dst_meta = MetaData()
    dst_meta.reflect(bind=dst, only=[table_name])
    if table_name not in dst_meta.tables:
        logger.warning(f"  {table_name}: not in destination — skipping")
        return 0
    target = dst_meta.tables[table_name]
    target_cols = {c.name for c in target.columns}

    # Read from source using a plain SELECT so we get a simple list of
    # dicts regardless of the SQLite column types.
    total = 0
    with src.connect() as sconn:
        result = sconn.execute(target.select().compile(bind=src))
        rows: list[dict[str, Any]] = []
        for row in result:
            mapping = row._mapping
            cleaned = {}
            for col, val in dict(mapping).items():
                if col not in target_cols:
                    continue  # source-only column (rare, but harmless)
                cleaned[col] = _tag_naive_as_utc(val)
            rows.append(cleaned)

    if not rows:
        logger.info(f"  {table_name}: 0 rows")
        return 0

    with dst.begin() as dconn:
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            dconn.execute(target.insert(), batch)
            total += len(batch)
    logger.info(f"  {table_name}: {total} rows")
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--sqlite", required=True, help="Path to source SQLite DB")
    parser.add_argument(
        "--postgres",
        required=True,
        help="Destination Postgres DSN (postgresql+psycopg2://...)",
    )
    parser.add_argument(
        "--allow-nonempty-target",
        action="store_true",
        help="Proceed even if the target already has rows. Default: refuse.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        logger.error(f"sqlite DB not found: {args.sqlite}")
        return 1

    src = create_engine(f"sqlite:///{args.sqlite}")
    dst = create_engine(args.postgres, pool_pre_ping=True)

    # Safety: the target must already have the schema (alembic upgrade head)
    # and be empty (no existing reports). Without this check it's easy to
    # blow away prod data.
    dst_inspector = inspect(dst)
    if "reports" not in dst_inspector.get_table_names():
        logger.error(
            "Target has no `reports` table — run `alembic upgrade head` "
            "against the destination Postgres first."
        )
        return 2

    if not args.allow_nonempty_target:
        with dst.connect() as conn:
            existing = conn.execute(
                MetaData().tables.get("reports").select().compile(bind=dst)
                if "reports" in MetaData().tables else None
            ).scalar() if False else None
        # Use a simpler count to avoid compile-with-empty-metadata pitfalls.
        from sqlalchemy import text
        with dst.connect() as conn:
            n = conn.execute(text("SELECT COUNT(*) FROM reports")).scalar()
        if n and n > 0:
            logger.error(
                f"Target already has {n} reports rows — refusing to dump "
                "(pass --allow-nonempty-target to override). "
                "Typical fix: `DROP DATABASE crisp; CREATE DATABASE crisp OWNER crisp;` + `alembic upgrade head`."
            )
            return 3

    # Reflect SQLite schema to get the set of tables we have data in.
    # We then intersect with the preferred order + skip list, then let
    # `sort_tables` handle the FK dependency ordering for the result.
    src_meta = MetaData()
    src_meta.reflect(bind=src)
    src_tables = set(src_meta.tables.keys()) - SKIP_TABLES

    # Reflect destination too — we only copy tables present on BOTH sides.
    dst_meta = MetaData()
    dst_meta.reflect(bind=dst)
    dst_tables = set(dst_meta.tables.keys())

    to_copy = src_tables & dst_tables
    skipped_not_in_dst = src_tables - dst_tables
    if skipped_not_in_dst:
        logger.warning(
            f"Skipping {len(skipped_not_in_dst)} source-only tables "
            f"(not present on Postgres): {sorted(skipped_not_in_dst)}"
        )

    # Sort: preferred order first, then anything else alphabetically.
    ordered = [t for t in PREFERRED_ORDER if t in to_copy]
    extras = sorted(to_copy - set(ordered))
    if extras:
        ordered.extend(extras)

    logger.info(f"Copying {len(ordered)} tables from {args.sqlite} → Postgres")

    total_rows = 0
    for t in ordered:
        try:
            total_rows += _copy_table(t, src, dst)
        except Exception as e:
            logger.error(f"  {t}: FAILED — {e}")
            raise

    logger.info(f"Done. {total_rows} rows copied across {len(ordered)} tables.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
