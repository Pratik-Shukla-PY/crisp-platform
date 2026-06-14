import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration.

    Apr 2026 - PostgreSQL-only. SQLite was retired in the "drop SQLite"
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

    We refuse to boot on an unset OR non-postgres ``DATABASE_URL`` -
    fail-fast with a clear message rather than silently surfacing a
    cryptic "operator does not exist" 10 queries later. Mirrors the
    existing JWT_SECRET + CRISP_ADMIN_KEY + CORS_ORIGINS guards in
    ``app/main.py``.
    """

    PROJECT_NAME: str = "CRISP API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # No default - boot refuses without an explicit DSN.
    DATABASE_URL: str

    # ── Web Push (VAPID) ────────────────────────────────────────────────
    # reporter-feedback channel. Generate via
    # `scripts/generate_vapid.py` once per environment, then put the
    # output in .env.production + AWS Secrets Manager. The PUBLIC key
    # is safe to ship to clients; only the PRIVATE key is sensitive.
    #
    # All three fields default to empty so dev / CI without push wired
    # up still boots - the push service short-circuits gracefully when
    # any of them is empty (logs once at startup, returns immediately
    # on send). To enable push end-to-end in prod, set all three.
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    # RFC 8292 §2 - push providers may use this to contact us about
    # abuse / problematic traffic. Use a real on-call address.
    VAPID_CONTACT_EMAIL: str = ""

    # ── Redis (Phase 1.8 - distributed rate-limit) ──────────────────────
    # Optional. When set, the rate-limit module switches from the
    # in-memory `_rate_limits` dict (which is per-worker - so under N
    # uvicorn workers an attacker gets Nx the effective rate) to an
    # atomic Redis INCR + EXPIRE counter shared across every worker
    # and every backend instance.
    #
    # Empty value → in-memory fallback (dev + tests + first-deploy).
    # Format: ``redis://[user:pass@]host:port[/db]``
    #
    # Failure mode: if REDIS_URL is set but the server is unreachable,
    # we log the failure ONCE and fall back to the in-memory counter
    # for that request. We never hard-fail a real user request just
    # because Redis is down - UNDP must-have #12 (scale targets)
    # gets degraded availability instead of an outage.
    REDIS_URL: str = ""

    # ── Nearby Reports - citizen T1 visibility (Phase 1, May 2026) ──────
    # See docs/NEARBY_REPORTS_PIPELINE.md §3.2 + §14.
    # When `true` (default) citizens see Tier-1 ("Weak Signal") groups
    # in the nearby module with explicit "Unverified" visual treatment.
    # When `false`, T1 groups are suppressed from the citizen-facing
    # response - useful for sensitive regions (active conflict, rumour-
    # sensitive markets) where single-witness signals could cause panic
    # or be weaponised as misinformation. Admins ALWAYS see T1
    # regardless of this flag (they need the raw view for triage).
    #
    # The flag is echoed in the `/api/v1/reports/nearby` response so
    # the PWA frontend can render accordingly without needing a
    # separate config fetch. Also exposed via `/api/v1/config` for
    # boot-time client setup.
    CRISP_CITIZEN_T1_VISIBILITY: bool = True

    # ── Nearby - disaster-mode + density (Phase 4, May 2026) ─────────
    # See docs/NEARBY_REPORTS_PIPELINE.md §3.8 + §14.
    # When a single /reports/nearby query would return more than
    # CRISP_DISASTER_MODE_GROUPS aggregate groups OR more than
    # CRISP_DISASTER_MODE_REPORTS raw reports inside the radius, the
    # endpoint switches to disaster mode: auto-promote bucketing to
    # area level + return at most 20 mega-zones + X-Crisp-Density-
    # Mode: disaster response header. Frontend renders a heat-map
    # overlay instead of pin clusters.
    # Defaults err on the SAFE side; deployments in disaster-prone
    # regions may lower these.
    CRISP_DISASTER_MODE_GROUPS: int = 50
    CRISP_DISASTER_MODE_REPORTS: int = 200

    # Map render-mode thresholds (docs §3.8). Different deployments /
    # countries need different sensitivities. Format is JSON; default
    # encodes {"pins": 10, "clusters": 50}. Phase 4 surfaces these
    # via /api/v1/config so the dashboard reads them once at boot.
    CRISP_DENSITY_BUCKETS_PINS: int = 10
    CRISP_DENSITY_BUCKETS_CLUSTERS: int = 50

    # Push-notification policy (Phase 4, docs §8). Frequency cap per
    # user - protects against alarm fatigue.
    CRISP_PUSH_FREQUENCY_CAP_PER_USER_PER_HOUR: int = 1

    # ── Server-side geotag embedding (HC98, May 2026) ────────────────
    # Burn a visible lat/long + building + capture-time caption into stored
    # MEDIUM/ORIGINAL photos AND write GPS EXIF, inside the PII-blur worker
    # (after blur, so the caption is never blurred). A pristine un-stamped
    # ORIGINAL is archived internally. Both default ON; disable per deployment
    # if location-on-image is not desired.
    CRISP_GEOTAG_WATERMARK_ENABLED: bool = True
    CRISP_GEOTAG_EXIF_ENABLED: bool = True

    # ── Retention policy (UNDP Privacy Policy §22-24 + Annex 2 (c)) ──────
    # Reports are retained while the crisis response is active, then for a
    # bounded window for audit/verification, then permanently deleted. The
    # window is anchored on the crisis's `ended_at` for reports tied to an
    # ENDED CrisisEvent, or on the report's own latest activity (updated_at /
    # server_created_at) for standalone reports. Set to 0 to DISABLE the
    # retention sweep entirely (soft-delete-on-request still applies).
    # Default = 365 days (crisis close + 1 year), per the privacy notice.
    CRISP_RETENTION_AFTER_CLOSE_DAYS: int = 365

    # When True, reports tied to an ENDED crisis are NEVER auto-purged: closing
    # an operation is non-destructive (the response record stays queryable for
    # the operation's lifetime). Standalone-report cleanup and the 24h
    # soft-delete-on-request grace are unaffected. Set False to restore the
    # legacy "purge ENDED-crisis reports after CRISP_RETENTION_AFTER_CLOSE_DAYS"
    # behaviour. Default True - an operation's history must survive its closure.
    CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE: bool = True

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
            "Apr 2026 full-Postgres switch - silent dialect bugs (tz "
            "handling, enum coercion, int-vs-bool) made the dual-DB "
            "posture net-negative. Set DATABASE_URL to a postgresql:// "
            "DSN. Run scripts/dev-setup.sh for the automated path."
        )
    if not (lowered.startswith("postgresql://") or lowered.startswith("postgresql+")):
        raise RuntimeError(
            f"DATABASE_URL must use a postgresql scheme - got {url[:32]!r}. "
            "Example: postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
        )


# Build + validate at import time so any misconfiguration surfaces IMMEDIATELY
# on `uvicorn app.main:app` rather than at first query.
try:
    settings = Settings()  # type: ignore[call-arg]
except Exception as e:
    # Pydantic-settings raises `ValidationError` on missing DATABASE_URL
    # - wrap in a human-friendly RuntimeError so the boot error is clear.
    if "DATABASE_URL" in str(e):
        raise RuntimeError(
            "DATABASE_URL is required but unset. CRISP is Postgres-only "
            "as of Apr 2026. Run `scripts/dev-setup.sh` or:\n"
            "  export DATABASE_URL=postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
        ) from e
    raise

_validate_postgres_dsn(settings.DATABASE_URL)
