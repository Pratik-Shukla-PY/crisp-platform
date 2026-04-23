# Database Migrations — Alembic Workflow

Effective **April 2026**, CRISP uses Alembic for all DB schema changes.
Before that, the app relied on SQLAlchemy `create_all()` at boot — which
worked for a hackathon but would lose data the moment we shipped a
column rename or type change. Alembic is a prerequisite for any
credible claim about scaling to UNDP's 50k/250k/500k reports-per-crisis
volumes: you cannot run a real crisis-response backend that drops the
DB on every schema update.

## Setup once

Nothing special — Alembic is in `backend/requirements.txt`. Configuration
lives in `backend/alembic.ini` and `backend/migrations/env.py`. The
`env.py` is wired so that:

  * Alembic reads `DATABASE_URL` from the application's `Settings`
    (`backend/app/core/config.py`), which in turn loads `.env`.
  * `Base.metadata` is imported from the live app so
    `alembic revision --autogenerate` sees every model without duplication.
  * `render_as_batch=True` is set so the SQLite dev database can handle
    `ALTER TABLE` operations.

## Everyday commands

Run from `backend/`:

```bash
# Upgrade the database pointed at by DATABASE_URL to the latest revision
alembic upgrade head

# Downgrade one step (irreversible migrations raise on downgrade)
alembic downgrade -1

# Create a new migration after changing a model
alembic revision --autogenerate -m "short description"

# Show current revision of the DB
alembic current

# History of revisions
alembic history --verbose
```

For production, set `DATABASE_URL` to the Postgres DSN before running
`alembic upgrade head`. See `.env.production.example`.

## Postgres dev setup (Apr 2026 — full-switch)

The full migration chain (0002 → 0006) has been verified end-to-end on
PostgreSQL 15 and lives in CI as a Postgres-service matrix cell. To
bring a local Postgres up to par with the SQLite default:

```bash
# Install + start Postgres 15 (macOS + Homebrew)
brew install postgresql@15
export LC_ALL="en_US.UTF-8"
pg_ctl -D /opt/homebrew/var/postgresql@15 -l /tmp/pg15.log start

# Provision the crisp role + DB
psql -U "$USER" -d postgres -c \
  "CREATE ROLE crisp WITH LOGIN PASSWORD 'crisp' SUPERUSER;"
createdb -U "$USER" crisp

# Point the app at it + run the chain
cd backend
export DATABASE_URL="postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
export APP_ENV=dev
alembic upgrade head
alembic current    # → 0006_bh (head)
```

After `alembic upgrade head` on a fresh Postgres instance you'll have the
same schema SQLite carries locally, plus the Postgres-specific artefacts
(enum types widened by 0003, full tz-aware datetimes, real BOOLEAN
columns). The backend's `_purge_expired_deletions` path handles both
dialects: a tz-bug there that silently shifted the deletion-grace cutoff
5.5 hours on IST-defaulted Postgres servers was fixed in the full-switch
sprint by using `.astimezone(utc)` instead of `.replace(tzinfo=utc)`.

### Dialect-specific migrations

Two of the six migrations have explicit Postgres branches:

  * **0003_infra** — uses `ALTER TYPE infratypeenum ADD VALUE IF NOT
    EXISTS` (Postgres-only, autocommit-block) to widen the enum BEFORE
    the backfill UPDATE can write `RESIDENTIAL` / `COMMUNITY` / etc.
    into the column. SQLite is untyped and accepts the new values
    directly. The backfill also uses `infrastructure_type::text` when
    `UPPER()`-ing the enum on Postgres because the planner refuses
    `UPPER(enum_col)` without an explicit cast.
  * **0005_pii** — the backfill `WHERE client_blur_applied = :truthy`
    binds a Python `True` rather than the literal `1`; SQLAlchemy emits
    the right token for each dialect (`TRUE` on Postgres, `1` on SQLite).

## Adopting an existing dev database

Before Alembic landed, `crisp_local.db` was created at app boot and has
no `alembic_version` table. To adopt it without wiping:

```bash
cd backend
# Save a backup in case the upgrade misbehaves
cp crisp_local.db crisp_local.db.pre-alembic.bak

# Tell Alembic this DB already has the baseline schema
alembic stamp 7964f14c120d

# Apply the follow-on migrations — the 0002 step handles the
# crisis_category column addition + legacy NO_DAMAGE → MINIMAL
# backfill without data loss.
alembic upgrade head
```

The 0002 migration is written to be idempotent: running it against a
fresh-baseline DB (where the column already exists) is a no-op plus
backfill. Running it against a legacy DB ALTERs the table and backfills
in one shot.

## Workflow for a new model change

1. Edit `backend/app/models/*.py`.
2. Run `alembic revision --autogenerate -m "…"` — inspect the generated
   migration carefully, Alembic cannot detect every change reliably (in
   particular it misses server-side defaults and enum-value edits).
3. Test with `alembic upgrade head` against a throw-away SQLite DB
   (see `tests/test_migrations.py` for the pattern).
4. Run `pytest tests/test_migrations.py` — the `test_migrated_schema_*`
   tests fail CI if the migration and models drift.
5. Commit the migration alongside the model change.

## Gotchas

  * **SQLite `ALTER TABLE` is limited**. The `render_as_batch=True`
    setting in `env.py` lets Alembic work around this by recreating
    tables. Still avoid anything that would break a partial online
    migration in Postgres — no destructive drops without a paired
    backfill migration first.
  * **Enum value changes need manual SQL**. Alembic autogenerate ignores
    enum member additions. When adding a new value (e.g. a new
    `CrisisTypeEnum`), write the migration by hand — see
    `migrations/versions/0002_backfill_crisis_category.py` as a model.
  * **Never edit a migration after it has shipped**. Write a follow-on
    migration instead. Production DBs that already ran the old version
    will not re-run a mutated one.
