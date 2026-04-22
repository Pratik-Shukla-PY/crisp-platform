import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration.

    Apr 2026 — PostgreSQL-only. SQLite was retired in the "drop SQLite"
    sprint. ``DATABASE_URL`` MUST be set to a Postgres DSN in both dev
    and production. Rationale:

      * SQLite silently accepted dialect-specific bugs (tz-shift in
        ``_purge_expired_deletions``, enum-text-vs-ENUM-type mismatches,
        int-vs-bool comparisons) that hit prod on first Postgres deploy.
        Running dev on the same DB as prod kills that whole bug class.
      * The 50k/250k/500k reports-per-crisis volumes UNDP asks us to
        handle need real transaction isolation + indexing; SQLite
        serialises writes globally.
      * One database == one schema path == one migration path == one
        set of integration tests.

    Local dev (macOS):
        brew install postgresql@15
        export LC_ALL="en_US.UTF-8"
        pg_ctl -D /opt/homebrew/var/postgresql@15 start
        psql postgres -c "CREATE ROLE crisp WITH LOGIN PASSWORD 'crisp' SUPERUSER;"
        createdb -U "$USER" crisp
        export DATABASE_URL=postgresql+psycopg2://crisp:crisp@localhost:5432/crisp
        cd backend && alembic upgrade head

    Or via docker-compose (zero host install):
        docker compose up db -d
        export DATABASE_URL=postgresql+psycopg2://crisp:crisp@localhost:5432/crisp
        cd backend && alembic upgrade head

    ``scripts/dev-setup.sh`` automates both paths.

    We refuse to boot on an unset OR non-postgres ``DATABASE_URL`` —
    fail-fast with a clear message rather than silently surfacing a
    cryptic "operator does not exist" 10 queries later. Mirrors the
    existing JWT_SECRET + CRISP_ADMIN_KEY + CORS_ORIGINS guards in
    ``app/main.py``.
    """

    PROJECT_NAME: str = "CRISP API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # No default — boot refuses without an explicit DSN.
    DATABASE_URL: str

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


def _validate_postgres_dsn(url: str) -> None:
    """Postgres-only policy: refuse sqlite:// or other schemes at boot."""
    lowered = (url or "").strip().lower()
    if not lowered:
        raise RuntimeError(
            "DATABASE_URL is required but unset. CRISP is Postgres-only "
            "as of Apr 2026. Run scripts/dev-setup.sh or see "
            "backend/app/core/config.py for the manual setup."
        )
    if lowered.startswith("sqlite:"):
        raise RuntimeError(
            "DATABASE_URL points at SQLite. SQLite was retired in the "
            "Apr 2026 full-Postgres switch — silent dialect bugs (tz "
            "handling, enum coercion, int-vs-bool) made the dual-DB "
            "posture net-negative. Set DATABASE_URL to a postgresql:// "
            "DSN. Run scripts/dev-setup.sh for the automated path."
        )
    if not (lowered.startswith("postgresql://") or lowered.startswith("postgresql+")):
        raise RuntimeError(
            f"DATABASE_URL must use a postgresql scheme — got {url[:32]!r}. "
            "Example: postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
        )


# Build + validate at import time so any misconfiguration surfaces IMMEDIATELY
# on `uvicorn app.main:app` rather than at first query.
try:
    settings = Settings()  # type: ignore[call-arg]
except Exception as e:
    # Pydantic-settings raises `ValidationError` on missing DATABASE_URL
    # — wrap in a human-friendly RuntimeError so the boot error is clear.
    if "DATABASE_URL" in str(e):
        raise RuntimeError(
            "DATABASE_URL is required but unset. CRISP is Postgres-only "
            "as of Apr 2026. Run `scripts/dev-setup.sh` or:\n"
            "  export DATABASE_URL=postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
        ) from e
    raise

_validate_postgres_dsn(settings.DATABASE_URL)
