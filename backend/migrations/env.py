"""
Alembic env.py - wired to use the runtime DATABASE_URL + the Base.metadata
from the CRISP application so `alembic revision --autogenerate` sees every
model and `alembic upgrade head` uses the same connection string the app
does.

Upstream of this file, ``app.core.config.Settings`` reads DATABASE_URL
from the environment (or .env); we reuse the already-normalised value
rather than re-implementing the lookup.
"""
import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

# Make `app.*` imports resolve when Alembic is invoked from this file.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load the application settings + all SQLAlchemy models so autogenerate
# can detect every table. Every model module must be imported here or its
# tables are invisible to Alembic.
from app.core.config import settings  # noqa: E402
from app.db.session import Base       # noqa: E402
import app.models.report               # noqa: E402,F401
import app.models.auth                 # noqa: E402,F401
import app.models.prediction           # noqa: E402,F401

config = context.config

# Override the sqlalchemy.url in alembic.ini with the one the app uses
# (driven by DATABASE_URL env var). This means running migrations and
# running the app against a fresh Postgres / staging DB requires only
# `export DATABASE_URL=...` - no duplicated config to drift.
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL scripts, no DB connection needed."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # SQLite-friendly ALTER TABLE
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against the configured database."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite-friendly ALTER TABLE
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
