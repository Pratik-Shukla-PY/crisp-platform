from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration.

    `DATABASE_URL` intentionally defaults to SQLite for friction-free
    local dev + CI (no daemon required). Production deployments MUST set
    ``DATABASE_URL=postgresql+psycopg2://user:pass@host/db`` in their
    environment or `.env` — see `.env.production.example` in the repo
    root and `docs/DEPLOYMENT_RUNBOOK.md` for the canonical setup.

    The distinction matters: SQLite serialises writes globally, so the
    50k/250k/500k-report volumes the UNDP challenge asks us to handle
    require Postgres in production. Alembic migrations (under
    `backend/migrations/`) run against whichever backend DATABASE_URL
    points at, so no code changes are needed to switch.
    """

    PROJECT_NAME: str = "CRISP API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # Default kept as SQLite for local dev + unit tests. See the module
    # docstring above for the production path.
    DATABASE_URL: str = "sqlite:///./crisp_local.db"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
