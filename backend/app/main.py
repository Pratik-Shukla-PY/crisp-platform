"""
CRISP Backend — FastAPI application entry point.

Mounts all API routes, webhook endpoints (Telegram, WhatsApp, SMS, IVR),
static file serving, CORS middleware, and background workers.

Startup sequence:
  1. Load .env
  2. Mount API router (/api/v1/reports/)
  3. Mount messaging webhooks (/api/v1/telegram/, whatsapp/, sms/, ivr/)
  4. Start Telegram long-polling
  5. Start deletion purge worker (every 15 min)
"""
import os
import re
import sys
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager  # May 2026: FastAPI lifespan
from dotenv import load_dotenv

# Load .env into os.environ BEFORE any service singletons are imported
_env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
load_dotenv(dotenv_path=_env_path, override=True)


# ── Phase 24 — fail-fast env validation ───────────────────────────────
#
# Phase 23 deployed a backend with `MEDIA_BACKEND=s3` but with the
# `AWS_REGION` line accidentally missing from `.env.production` (an
# operator's hand-edit dropped it). The container started healthy
# and the docker-compose healthcheck stayed green — `boto3` only
# raised when the first media request hit it, hours later, after the
# bad state had reached user traffic.
#
# Fix: refuse to start unless the required env vars are present.
# Backend exits with code 1; docker-compose flips the healthcheck
# red within 60 s; auto-rollback in deploy.sh catches the broken
# config BEFORE it reaches users. Operators add a missing var,
# `up --force-recreate`, container goes green.
#
# Note: this lives at module-import time on purpose. Putting it
# inside an `@app.on_event("startup")` would run AFTER FastAPI has
# already wired routes / accepted the first request and would not
# block startup.

_REQUIRED_BY_BACKEND = ["MEDIA_BACKEND"]
_REQUIRED_WHEN_S3 = ["AWS_S3_BUCKET", "AWS_REGION"]


def _validate_required_env() -> None:
    """Refuse to start unless every required env var is present.

    Centralised env-var manifest so future config drift can't silently
    half-break a request path that's only exercised under load (the
    Phase 23 AWS_REGION trap). The list mirrors
    `scripts/verify-env.sh` so the operator-side check and the
    container-side check agree on what's required.
    """
    missing = [v for v in _REQUIRED_BY_BACKEND if not os.getenv(v)]
    if os.getenv("MEDIA_BACKEND", "local").lower() == "s3":
        missing += [v for v in _REQUIRED_WHEN_S3 if not os.getenv(v)]
    if missing:
        sys.stderr.write(
            "\n[FATAL] Required env vars missing: " + ", ".join(missing) +
            "\n        Refusing to start. Fix .env.production and rerun "
            "`docker compose up -d --force-recreate backend`.\n"
            "        Also run `bash scripts/verify-env.sh .env.production` "
            "before restarting to catch any other gaps.\n\n"
        )
        sys.exit(1)


# Skip validation in the pytest suite — tests use a minimal env that
# legitimately omits some of these (e.g. local-storage MEDIA_BACKEND).
# Pytest sets PYTEST_CURRENT_TEST in the env; we use that as the
# signal. Production / docker-compose never sets it.
if not os.environ.get("PYTEST_CURRENT_TEST") and not os.environ.get("CRISP_SKIP_ENV_VALIDATION"):
    _validate_required_env()

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from app.api.router import api_router

# P3.7 / P3.8 — structured logging + optional Sentry. Configured early so
# anything imported after this uses the JSON/console renderer.
from app.core.observability import (
    configure_structlog,
    init_sentry,
    metrics_response,
    PrometheusRequestMiddleware,
)
configure_structlog()
_sentry_enabled = init_sentry()

logger = logging.getLogger(__name__)
if _sentry_enabled:
    logger.info("Sentry enabled for this process")


# ── Security: Admin API Key ──────────────────────────────────────────────────
# P1.8 — In production we FAIL STARTUP if CRISP_ADMIN_KEY is missing. A
# previous "no key = dev mode (all allowed)" fallback meant a deployment with
# a forgotten env var quietly exposed every admin endpoint to the world.
# Dev mode must be opted into with APP_ENV=dev so an accidental prod deploy
# refuses to boot instead of shipping open.
APP_ENV = os.getenv("APP_ENV", "production").lower()
ADMIN_KEY = os.getenv("CRISP_ADMIN_KEY", "")
if not ADMIN_KEY:
    if APP_ENV == "production":
        raise RuntimeError(
            "CRISP_ADMIN_KEY env var is required when APP_ENV=production. "
            "Set it to a long random string (see scripts/rotate_secrets.sh) "
            "or set APP_ENV=dev for local development."
        )
    logging.getLogger(__name__).warning(
        "CRISP_ADMIN_KEY not set and APP_ENV=%s — admin endpoints will reject "
        "all requests. Set the env var to re-enable them.", APP_ENV
    )

def verify_admin_key(request: Request):
    """Dependency: require X-Admin-Key header for admin-only endpoints.

    Behavior matrix:
      - APP_ENV=production + no key  → boot already failed above (unreachable)
      - APP_ENV=dev       + no key  → reject with 503 so devs notice
      - Any env           + key set → require matching header or 403
    """
    if not ADMIN_KEY:
        raise HTTPException(
            status_code=503,
            detail="Admin endpoints disabled: set CRISP_ADMIN_KEY env var."
        )
    key = request.headers.get("X-Admin-Key", "")
    if key != ADMIN_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing admin key")


# ── Security: Rate Limiter ───────────────────────────────────────────────────
# Phase 1.8 (May 2026) — distributed rate-limit. When ``REDIS_URL`` is
# set, the counter is backed by atomic Redis INCR + EXPIRE so every
# uvicorn worker / backend instance shares the same view. When unset
# (dev, CI, first-deploy), the in-memory dict in
# ``app.services.rate_limit._inmemory_buckets`` is the fallback — same
# semantics as the pre-Phase-1.8 module-local ``_rate_limits``.
#
# ``_rate_limits`` here is kept as a LIVE ALIAS for the service-module
# bucket so legacy tests that call ``_rate_limits.clear()`` to reset
# state between cases (e.g. tests/test_probe.py) continue to work
# without touching the test file. New code should call
# ``app.services.rate_limit._reset_for_test()`` instead.
from app.services.rate_limit import (  # noqa: E402
    check_rate_limit,
    _inmemory_buckets as _rate_limits,
)


# ── Security: Path sanitization ──────────────────────────────────────────────
def safe_filename(name: str) -> str:
    """Remove path traversal characters, ensure filename is safe."""
    name = os.path.basename(name)
    name = re.sub(r'[^\w\-.]', '_', name)
    return name

if not os.path.exists("uploads"):
    os.makedirs("uploads")

from app.core.config import settings
from app.db.session import engine
from app.models.report import Base
import app.models.auth        # Ensure auth tables are registered with Base.metadata
import app.models.prediction  # Prediction zone + result tables

# SQLite fully retired. Alembic is the sole schema authority.
# Before starting uvicorn, run `alembic upgrade head` (dev + prod).
# The previous `Base.metadata.create_all(bind=engine)` call was a
# SQLite-era zero-install shortcut that raced with Alembic on Postgres
# (create_all → CREATE TABLE; alembic upgrade then hits "relation already
# exists"). The `_migrate_schema()` column-adder hot-patcher is also
# gone — its `ALTER TABLE ADD COLUMN … DEFAULT 0` syntax was SQLite-only
# (Postgres needs `DEFAULT FALSE` on BOOLEAN, `TIMESTAMP` not `DATETIME`,
# etc.), and Alembic covers every column it used to hot-patch. See
# ``docs/MIGRATIONS.md`` + ``scripts/dev-setup.sh``.
#
# Belt-and-braces: verify the DB is actually at alembic head on boot so
# a forgotten `alembic upgrade head` fails loudly with a clear message
# instead of surfacing later as cryptic "column does not exist" errors.
def _assert_alembic_head() -> None:
    from sqlalchemy import text
    with engine.connect() as conn:
        try:
            row = conn.execute(text(
                "SELECT version_num FROM alembic_version"
            )).first()
        except Exception:
            raise RuntimeError(
                "Database has no `alembic_version` table — run "
                "`alembic upgrade head` before starting uvicorn. "
                "CRISP is Postgres-only as of Apr 2026."
            )
    current = row[0] if row else None
    if not current:
        raise RuntimeError(
            "Database has no alembic revision stamped. Run "
            "`alembic upgrade head` before starting uvicorn."
        )
    # Cheap head lookup: read migrations/versions/ and find the one whose
    # `revision` appears but nobody has as `down_revision`. Avoids hard-
    # coding a version string that would drift with every new migration.
    import os, re
    versions_dir = os.path.join(os.path.dirname(__file__), "..", "migrations", "versions")
    revisions: dict[str, str] = {}   # revision → down_revision ("" for baseline)
    for fn in os.listdir(versions_dir):
        if not fn.endswith(".py") or fn.startswith("__"):
            continue
        with open(os.path.join(versions_dir, fn), encoding="utf-8") as f:
            src = f.read()
        m = re.search(r'^revision(?:\s*:\s*str)?\s*=\s*["\']([^"\']+)', src, re.M)
        d = re.search(r'^down_revision(?:\s*:[^=]+)?\s*=\s*(?:["\']([^"\']+)["\']|None)', src, re.M)
        if m:
            revisions[m.group(1)] = (d.group(1) if d and d.group(1) else "")
    # Head = a revision nobody references as their down_revision.
    parents = {dv for dv in revisions.values() if dv}
    heads = [r for r in revisions if r not in parents]
    if len(heads) == 1 and current != heads[0]:
        raise RuntimeError(
            f"Database is stamped at revision {current!r} but head is "
            f"{heads[0]!r}. Run `alembic upgrade head` before starting uvicorn."
        )

try:
    _assert_alembic_head()
except RuntimeError as _err:
    # In APP_ENV=production, fail fast so Kubernetes / ECS restarts the
    # pod and the operator sees the error loudly. In dev, log a prominent
    # warning but boot anyway so a contributor who's mid-debugging without
    # a recent upgrade can still iterate.
    if APP_ENV == "production":
        raise
    logging.getLogger(__name__).warning(
        "Schema check: %s (APP_ENV=%s — booting anyway; in prod this is fatal)",
        _err, APP_ENV,
    )

# May 2026 — FastAPI lifespan handler. Replaces the deprecated
# @app.on_event("startup") decorator (warning was firing on every test
# run + would have failed outright on FastAPI 1.x). Both startup AND
# shutdown branches live in one async context manager:
#   yield ⇒ everything before is startup, everything after is shutdown.
# Today the shutdown branch is empty — the purge worker + Telegram poll
# task are daemon threads / asyncio tasks that exit with the process.
# Adding a shutdown step (e.g. graceful Telegram poll cancellation)
# would slot in after the `yield`.
@asynccontextmanager
async def lifespan(app: "FastAPI"):  # forward-ref string is fine at module scope
    await _run_startup_tasks()
    yield
    # (no shutdown work today; add cleanup here if/when threads need
    # graceful join — currently they're daemons and exit with the process)


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    description="Community-driven Rapid Infrastructure Sensing Platform Backend API",
    lifespan=lifespan,
)

# CORS — P2.7: tighter rules in production.
#
# In dev we accept localhost + every RFC 1918 private LAN address so a
# tester on the same Wi-Fi (e.g. http://192.168.1.49:8080) can hit the
# backend from the dashboard without the preflight failing. Previously
# only literal "localhost:*" was whitelisted — a tester opening the
# dashboard at the LAN IP got a silent CORS preflight 400 and the
# login button just "didn't do anything" in the browser. Fixed 2026-04-21.
#
# In production we require CORS_ORIGINS to be explicitly set to the real
# dashboard domain — a missing env var would previously have silently
# allowed the dev defaults, giving a same-LAN attacker on the host a free
# authenticated-request channel thanks to `allow_credentials=True`.
_default_dev_origins = "http://localhost:8080,http://localhost:8000,http://localhost:3000"
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
_cors_regex = None  # set below in dev mode
if not _cors_env:
    if APP_ENV == "production":
        raise RuntimeError(
            "CORS_ORIGINS env var is required when APP_ENV=production. "
            "Set it to a comma-separated list of the exact origins your "
            "dashboard is served from (e.g. 'https://dashboard.crisp.undp.org')."
        )
    _cors_env = _default_dev_origins
    logging.getLogger(__name__).warning(
        "CORS_ORIGINS not set and APP_ENV=%s — defaulting to localhost "
        "+ RFC 1918 LAN regex. Production MUST set CORS_ORIGINS.",
        APP_ENV,
    )
# In dev mode, ALSO whitelist any RFC 1918 private LAN IP with a regex
# alongside whatever explicit origins were set. DHCP leases change on a
# whim (Mac wakes up and gets a new IP), which would otherwise require
# manually rotating .env every morning — observed 2026-04-21 when a
# tester hit CORS 400 at http://192.168.1.49:8080 because .env was
# frozen on http://192.168.1.38:8080. Regex is intentionally strict:
# only http://, only RFC 1918 ranges (10.x / 172.16-31.x / 192.168.x)
# plus localhost / 127.0.0.1. Production MUST set APP_ENV=production;
# in that case this branch never runs and only the explicit
# CORS_ORIGINS list applies — same-LAN attackers can't sneak in.
if APP_ENV != "production":
    _cors_regex = (
        r"^http://("
        r"localhost|127\.0\.0\.1|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}"
        r")(:\d{1,5})?$"
    )
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
# Defensive check: disallow "*" paired with credentials (MDN-specified invalid
# combo that some browsers quietly treat as "null origin").
if "*" in _cors_origins:
    raise RuntimeError(
        "CORS_ORIGINS must not contain '*' when allow_credentials=True; "
        "list exact origins instead."
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # May 2026 — must include conditional-GET request headers
    # (If-None-Match, If-Match) so the dashboard's ETag-based polling
    # preflight doesn't 400. Without these, the browser preflight for
    # /api/v1/reports/?since=... fails CORS, the actual GET is blocked,
    # and the dashboard surfaces "Failed to fetch" / shows zero
    # reports even though the backend is healthy.
    allow_headers=[
        "Content-Type", "Authorization", "X-Admin-Key",
        "If-None-Match", "If-Match",
    ],
    # May 2026 (HAR-driven dashboard regression) — `X-Server-Time` + `ETag`
    # MUST be in this list. The reports list endpoint returns both, and the
    # dashboard's delta poller reads them via `res.headers.get(...)` to
    # advance `_lastServerTime` (cursor) and `_lastReportsEtag` (304 path).
    # If they're not exposed to JS via CORS, the browser hides them from
    # the fetch response — even though the server sets them — and the
    # dashboard falls back to a full-refresh on EVERY poll. Combined with
    # the dashboard's full-refresh notification-suppression flag, that
    # silently drops every operator notification on cross-origin
    # deployments (localhost:8080 → localhost:8000, LAN, cloudflared
    # tunnel). Same-origin PROD (nginx reverse proxy) avoided the bug
    # because CORS doesn't apply there; dev surfaces hit it every time.
    expose_headers=[
        "X-Total-Count",
        "X-Limit",
        "X-Offset",
        "X-Server-Time",
        "ETag",
    ],
)

# P3.7 — Prometheus + structured-logging request middleware. Counts every
# HTTP request, records latency, and stamps a request_id onto structlog so
# every log line inside a handler carries it. Skips when the /metrics scrape
# itself is happening (avoid recursive counters).
app.add_middleware(PrometheusRequestMiddleware)


# P3.6 — Security headers middleware.
#  - HSTS tells browsers to refuse HTTP for this origin for 2 years + includeSubDomains.
#    Only emitted when APP_ENV=production (localhost dev would be bricked otherwise).
#  - X-Content-Type-Options: nosniff stops MIME-confusion attacks on the
#    dashboard's static JS/CSS fetch.
#  - Referrer-Policy keeps report URLs out of third-party referrer logs.
#  - X-Frame-Options prevents clickjacking of the dashboard/PWA.
@app.middleware("http")
async def _security_headers(request: Request, call_next):
    resp = await call_next(request)
    if APP_ENV == "production":
        resp.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload"
        )
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


# Global exception handler — never leak stack traces to clients
@app.exception_handler(Exception)
async def _global_error_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error: {type(exc).__name__}: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

app.include_router(api_router, prefix=settings.API_V1_STR)

# WhatsApp Bot webhook (runs on the same server)
try:
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
    from messaging_bot.whatsapp.webhook import whatsapp_router
    app.include_router(whatsapp_router, prefix=f"{settings.API_V1_STR}/whatsapp", tags=["whatsapp"])
    logging.getLogger(__name__).info("WhatsApp webhook mounted at /api/v1/whatsapp/webhook")
except ImportError as e:
    logging.getLogger(__name__).warning(f"WhatsApp bot not loaded: {e}")

try:
    from messaging_bot.telegram.webhook import telegram_router
    app.include_router(telegram_router, prefix=f"{settings.API_V1_STR}/telegram", tags=["telegram"])
    logging.getLogger(__name__).info("Telegram webhook mounted at /api/v1/telegram/")
except ImportError as e:
    logging.getLogger(__name__).warning(f"Telegram bot not loaded: {e}")

try:
    from messaging_bot.sms.webhook import sms_router
    app.include_router(sms_router, prefix=f"{settings.API_V1_STR}/sms", tags=["sms"])
    logging.getLogger(__name__).info("SMS webhook mounted at /api/v1/sms/")
except ImportError as e:
    logging.getLogger(__name__).warning(f"SMS bot not loaded: {e}")

try:
    from messaging_bot.ivr.webhook import ivr_router
    app.include_router(ivr_router, prefix=f"{settings.API_V1_STR}/ivr", tags=["ivr"])
    logging.getLogger(__name__).info("IVR webhook mounted at /api/v1/ivr/")
except ImportError as e:
    logging.getLogger(__name__).warning(f"IVR bot not loaded: {e}")

app.mount("/static", StaticFiles(directory="uploads"), name="static")

# P2.10 — Canonical enum source-of-truth endpoint. Clients (PWA, RN, Telegram
# bot, SMS parser) should pull this at startup and reconcile their hard-coded
# lists against it. Prevents the drift we saw in the audit (Telegram accepted
# crisis types the backend didn't know about, SMS parser defaulted to OTHER
# silently, RN was missing CYCLONE from its chip grid).
@app.get("/api/v1/enums", tags=["system"])
def get_enums():
    from app.models.report import (
        SeverityEnum, InfraTypeEnum, DamageClassEnum, CrisisTypeEnum,
        ServiceStatusEnum, SourceEnum,
    )
    return {
        "severity": [e.value for e in SeverityEnum],
        "infrastructure_type": [e.value for e in InfraTypeEnum],
        "damage_classification": [e.value for e in DamageClassEnum],
        "crisis_type": [e.value for e in CrisisTypeEnum],
        "service_status": [e.value for e in ServiceStatusEnum],
        "source": [e.value for e in SourceEnum],
    }


# P3.7 — Prometheus scrape target. No auth at /metrics itself; in production
# this endpoint should be reachable only from the VPC's monitoring subnet or
# fronted by a token-aware sidecar. For now we rely on network-level scoping.
@app.get("/metrics", tags=["system"])
def prometheus_metrics():
    return metrics_response()


@app.get("/health", tags=["system"])
def health_check():
    # P2.14 — free-space check on the uploads volume. Returns 200 with
    # `status: degraded` if < 200 MB free, or 503 if < 50 MB free, so
    # orchestrators / load balancers can pull the instance out of rotation
    # before chunked uploads start silently failing with OSError on write.
    import shutil
    upload_dir = os.path.join(os.path.dirname(__file__), "..", "uploads")
    upload_dir = os.path.abspath(upload_dir)
    try:
        _total, _used, free = shutil.disk_usage(upload_dir if os.path.exists(upload_dir) else "/")
        free_mb = free // (1024 * 1024)
    except Exception:
        free_mb = None
    status_str = "CRISP Core Backend Online"
    http_status = 200
    disk_status = "ok"
    if free_mb is not None and free_mb < 50:
        disk_status = "critical"
        http_status = 503
        status_str = "CRISP Core Backend Degraded — disk space critical"
    elif free_mb is not None and free_mb < 200:
        disk_status = "low"
        status_str = "CRISP Core Backend Online — disk space low"

    body = {
        "status": status_str,
        "version": settings.VERSION,
        "disk": {"free_mb": free_mb, "status": disk_status},
    }
    if http_status == 503:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content=body)
    return body


@app.get("/api/v1/health", tags=["system"])
def health_check_api_v1():
    # May 21 2026 — mirror of /health under the /api/v1/ prefix that
    # nginx proxies in PROD. The root /health route exists for use by
    # k8s-style orchestrators that can be pointed at any path, but
    # nginx in PROD only proxies /api/v1/* to the backend — so the PWA
    # (running at the page origin) cannot reach the root /health route.
    # Mirroring the same response under /api/v1/health lets the PWA
    # version-pill code resolve the backend version without needing an
    # nginx config change. Identical response shape + status semantics.
    return health_check()


@app.get("/api/v1/health/db", tags=["system"])
def db_health_check():
    """Apr 2026 — explicit DB-connectivity probe.

    The basic `/health` endpoint doesn't touch the database; an RDS
    outage + a still-booting uvicorn would look healthy to k8s. This
    endpoint:

      * Opens a fresh connection (no pool re-use of a maybe-stale conn).
      * Runs ``SELECT 1`` + reads `alembic_version.version_num`.
      * Reports the configured driver + whether the schema is at head.

    Return shape (always JSON):
        200  { "status": "healthy",   "driver": "postgresql", "revision": "0006_bh", "latency_ms": 3.2 }
        503  { "status": "unavailable","driver": "postgresql", "error": "..." }
        200  { "status": "degraded",  "driver": "postgresql", "revision": "0004_bin",
                "message": "DB reachable but schema behind head" }

    Public — no auth gate — same policy as `/health` and `/health/pii`.
    """
    from fastapi.responses import JSONResponse
    from sqlalchemy import text
    import time

    driver = engine.url.drivername if engine else "unknown"
    start = time.perf_counter()

    # Step 1 — basic connectivity. A failure here is a real outage (DB
    # down, credentials wrong, network partition): return 503.
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unavailable",
                "driver": driver,
                "error": str(e)[:200],
            },
        )

    # Step 2 — alembic stamp. A DB with no `alembic_version` table is
    # not "down" — it's "reachable but unstamped." Common in test
    # fixtures that use `Base.metadata.create_all`. Return 200 with
    # status=degraded + revision=None so orchestrators don't tear down
    # a working pod just because Alembic hasn't been invoked.
    rev = None
    try:
        with engine.connect() as conn:
            row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
        rev = row[0] if row else None
    except Exception:
        rev = None
    latency_ms = round((time.perf_counter() - start) * 1000, 2)

    # Compare against the head revision the same way `_assert_alembic_head`
    # does at boot — scan migrations/versions/ for the revision nobody
    # references as down_revision.
    try:
        import os as _os, re as _re
        versions_dir = _os.path.join(_os.path.dirname(__file__), "..", "migrations", "versions")
        revisions: dict[str, str] = {}
        for fn in _os.listdir(versions_dir):
            if not fn.endswith(".py") or fn.startswith("__"):
                continue
            with open(_os.path.join(versions_dir, fn), encoding="utf-8") as f:
                src = f.read()
            m = _re.search(r'^revision(?:\s*:\s*str)?\s*=\s*["\']([^"\']+)', src, _re.M)
            d = _re.search(
                r'^down_revision(?:\s*:[^=]+)?\s*=\s*(?:["\']([^"\']+)["\']|None)',
                src, _re.M,
            )
            if m:
                revisions[m.group(1)] = (d.group(1) if d and d.group(1) else "")
        parents = {dv for dv in revisions.values() if dv}
        heads = [r for r in revisions if r not in parents]
        head = heads[0] if len(heads) == 1 else None
    except Exception:
        head = None

    status = "healthy"
    message = None
    if rev is None:
        # DB reachable but no alembic_version row. Common in test
        # fixtures that use create_all without stamping. Not an outage
        # — return 200 degraded + explicit message.
        status = "degraded"
        message = "DB reachable but alembic_version missing (schema not stamped)"
    elif head and rev != head:
        status = "degraded"
        message = f"DB reachable but schema is {rev!r} vs head {head!r}"

    body = {
        "status": status,
        "driver": driver,
        "revision": rev,
        "head": head,
        "latency_ms": latency_ms,
    }
    if message:
        body["message"] = message
    return body


@app.get("/api/v1/health/pii", tags=["system"])
def pii_health_check():
    """Apr 2026 — expose PII-blur backend health so operators can see
    whether a deployment is missing model files or Python packages that
    would silently degrade the server-side PII pass. Returns 200 when
    healthy or degraded, 503 when both backends are unavailable (in
    which case the server-side blur is a no-op and every client that
    sends `client_blur_applied: false` will produce a report with
    `pii_blur_status='skipped'` — the dashboard will flag those rows).

    Never 404s. Never auth-gated (public health, mirrors `/health`).
    """
    try:
        from app.services.pii_blur import pii_health_snapshot
    except Exception as e:
        # Import itself failed — the module can't even load. Treat as
        # fully unavailable; operators need to see this loudly.
        return JSONResponse(status_code=503, content={
            "overall": "unavailable",
            "face_detector": {"available": False, "error": f"import failed: {e}"},
            "ocr_reader":    {"available": False, "error": f"import failed: {e}"},
        })
    snap = pii_health_snapshot()
    http_status = 200 if snap["overall"] in ("healthy", "degraded") else 503
    if http_status == 503:
        return JSONResponse(status_code=503, content=snap)
    return snap


# ── Background purge: permanently delete reports past 24-hour grace period ────
import asyncio
import threading

def _purge_loop():
    """Run every 15 minutes, delete expired soft-deleted reports."""
    from app.db.session import SessionLocal
    from app.api.endpoints.reports import _purge_expired_deletions
    while True:
        try:
            db = SessionLocal()
            count = _purge_expired_deletions(db)
            db.close()
        except Exception as e:
            logging.getLogger(__name__).warning(f"Purge loop error: {e}")
        import time as _t
        _t.sleep(900)  # 15 minutes


# ── Phase F image-reliability (May 2026, see migration 0032) ─────────────────
#
# Three knobs control the periodic recovery sweep. Defaults match what the
# operator confirmed in the F.1/F.2/F.3 plan; overridable via env when a
# crisis-room operator wants a tighter or looser window without redeploying.
#
#   _ASSEMBLE_SWEEP_INTERVAL_S — how often the sweep daemon ticks.
#                                Default 5 min (matches PWA's max chunk-
#                                retry backoff + a safety margin).
#   _ABANDON_STALE_MIN         — `pending` rows older than this with
#                                 incomplete chunks are flipped to `failed`
#                                 with reason='chunks_never_arrived'.
#                                 Default 30 min (an offline PWA queue
#                                 typically drains within minutes of
#                                 reconnect; 30 min is a generous floor).
#   _ASSEMBLE_DEADLINE_MIN     — `assembling` rows older than this with
#                                 chunks NOT yet all arrived are flipped
#                                 to `failed` with reason='assembly_worker_lost'.
#                                 The legitimate-assembly path is fast
#                                 (<10 s); past 30 min the worker is dead.
#
# Action ① of the sweep (REVIVE chunks-fully-arrived stuck rows) is
# resubmitted to the assembly pool — it doesn't use the abandon path.
# Action ②/③ are terminal flips and set both abandon_reason +
# abandoned_at so the dashboard can surface "Original lost (network
# timeout)" instead of perpetual "uploading…".
_ASSEMBLE_SWEEP_INTERVAL_S = int(os.getenv("CRISP_ASSEMBLE_SWEEP_INTERVAL_S", "300"))
_ABANDON_STALE_MIN         = int(os.getenv("CRISP_ABANDON_STALE_MIN",         "30"))
_ASSEMBLE_DEADLINE_MIN     = int(os.getenv("CRISP_ASSEMBLE_DEADLINE_MIN",     "30"))
# May 2026 — companion to the PWA's "SMALL gates the photo stage" fix
# (mobile-app/src/app.js:8956). On SLOW / VERY_SLOW networks the PWA
# deliberately defers MEDIUM/HIGH variants; only the LOW (SMALL) variant
# lands. The Report row's `received_media` (e.g. 2) stays < `expected_media`
# (e.g. 3) forever, sync_status is permanently PARTIAL, dashboard +
# PWA "My Reports" both label it as in-queue. Action ④ in the sweep
# auto-promotes to SYNCED when every photo_group_id has at least one
# complete variant AND no Media row has been updated within this idle
# window — giving an in-flight MEDIUM/HIGH upload a chance to land
# before we flip the status.
_PARTIAL_PROMOTE_IDLE_S    = int(os.getenv("CRISP_PARTIAL_PROMOTE_IDLE_S",    "60"))
# R2.b (May 2026) — hard-delete deadline for abandoned-not-recovered
# rows. After this many days past abandoned_at (and still
# recovered_at IS NULL), Action ⑥ deletes the Media row + its
# chunks + its storage object. Default 30 days gives operators a
# four-week recovery window before the storage is reclaimed. Set
# to 0 to disable hard-delete entirely (the daemon will skip
# Action ⑥ — useful for forensic environments where ALL abandons
# must be retained).
_HARD_ABANDON_DAYS         = int(os.getenv("CRISP_HARD_ABANDON_DAYS",         "30"))
# R3.b (May 2026) — disk-orphan GC interval. Action ⑦ walks the storage
# backend (uploads/ + pre_blur/) and deletes objects older than
# CRISP_HARD_ABANDON_DAYS that aren't referenced by any live Media.url.
# This handles assembled-file orphans (the SQL cascade only handles
# MediaChunk rows; assembled disk files were leaking pre-R3.b). Default
# 1 h — long enough to keep the storage scan cost down at 500k-row
# scale, short enough to bound disk growth between sweeps. Set to 0 to
# disable.
_DISK_ORPHAN_GC_INTERVAL_S = int(os.getenv("CRISP_DISK_ORPHAN_GC_INTERVAL_S", "3600"))
# Tracks the last successful Action ⑦ run so the throttle works across
# sweep ticks. Module-level so the same value persists across daemon
# iterations.
_last_disk_orphan_gc_ts: float = 0.0


def _run_assembly_recovery_sweep(*, boot: bool = False) -> None:
    """One pass of assembly recovery — invoked on boot AND every
    _ASSEMBLE_SWEEP_INTERVAL_S seconds by `_assembly_recovery_loop`.

    Three actions, ordered so REVIVE runs FIRST (so we don't ABANDON
    a row that would have been resubmittable on this tick):

      ① REVIVE chunks-fully-arrived stuck rows.
         Rows with received_chunks >= chunk_count AND assembly_status in
         ('assembling', 'failed') AND updated_at > 2 min ago → reset to
         'pending' and re-submit to the assembly pool. Salvages
         crashes / OOMs that left an in-flight worker dead. Pre-existing
         behaviour preserved verbatim; only condition added is
         abandoned_at IS NULL (don't revive permanently-failed rows).

      ② ABANDON assembly-worker-lost rows.
         Rows in 'assembling' for > _ASSEMBLE_DEADLINE_MIN AND chunks NOT
         all arrived → flip to 'failed' with abandon_reason=
         'assembly_worker_lost'. (Pure 'assembling' for that long with
         incomplete chunks means a worker started but never reaped its
         own status — usually a hang inside PII blur or S3 multipart.
         Action ① only fires when chunks-complete, so these rows would
         loop forever in 'assembling' otherwise.)

      ③ ABANDON chunks-never-arrived rows.
         Rows in 'pending' AND received_chunks < chunk_count AND
         updated_at > _ABANDON_STALE_MIN → flip to 'failed' with
         abandon_reason='chunks_never_arrived'. The PWA / RN client
         never delivered the final chunks; the row is unrecoverable
         without a fresh upload. Dashboard can finally render "Original
         lost (network timeout)" instead of pulsing forever.

    Boot path passes `boot=True` for log clarity only; the actions are
    identical between boot and periodic ticks (no special-cases).
    """
    from app.db.session import SessionLocal
    from app.models.report import Media, Report, SyncStatusEnum
    from app.api.endpoints.reports import _try_full_assembly_bg, _assembly_executor
    from datetime import datetime, timedelta, timezone as _tz
    from sqlalchemy import or_

    log = logging.getLogger(__name__)
    tag = "boot" if boot else "periodic"
    _db = SessionLocal()
    try:
        now_utc = datetime.now(_tz.utc)
        stale_2min       = now_utc - timedelta(minutes=2)
        abandon_deadline = now_utc - timedelta(minutes=_ABANDON_STALE_MIN)
        assemble_deadln  = now_utc - timedelta(minutes=_ASSEMBLE_DEADLINE_MIN)

        # ── ① REVIVE chunks-fully-arrived stuck rows ───────────────────
        # Collect ids BEFORE the UPDATE so we can re-submit them by id
        # after the commit. The filter is identical to the UPDATE filter.
        to_resubmit = _db.query(
            Media.id, Media.type, Media.report_id
        ).filter(
            Media.assembly_status.in_(['assembling', 'failed', 'pending']),
            Media.updated_at < stale_2min,
            Media.chunk_count > 0,
            Media.received_chunks >= Media.chunk_count,
            # Don't revive rows that the sweep has already abandoned —
            # they need an explicit operator reclaim via the F3 endpoint.
            Media.abandoned_at.is_(None),
        ).all()
        revive_count = _db.query(Media).filter(
            Media.assembly_status.in_(['assembling', 'failed']),
            Media.updated_at < stale_2min,
            Media.chunk_count > 0,
            Media.received_chunks >= Media.chunk_count,
            Media.abandoned_at.is_(None),
        ).update({'assembly_status': 'pending'}, synchronize_session=False)
        _db.commit()
        if revive_count:
            log.info(
                f"Assembly recovery [{tag}]: revived {revive_count} stuck media → 'pending'"
            )
        if to_resubmit:
            for m in to_resubmit:
                _assembly_executor.submit(
                    _try_full_assembly_bg, m.id, m.type.value, m.report_id
                )
            log.info(
                f"Assembly recovery [{tag}]: re-submitted {len(to_resubmit)} media to pool"
            )

        # ── ② ABANDON assembly-worker-lost rows ────────────────────────
        # 'assembling' for > _ASSEMBLE_DEADLINE_MIN AND chunks NOT all
        # arrived. (Rows with chunks COMPLETE would have been captured by
        # action ① already; only the unsatisfiable ones remain here.)
        worker_lost = _db.query(Media).filter(
            Media.assembly_status == 'assembling',
            Media.updated_at < assemble_deadln,
            or_(
                Media.chunk_count == 0,
                Media.received_chunks < Media.chunk_count,
            ),
            Media.abandoned_at.is_(None),
        ).update({
            'assembly_status': 'failed',
            'abandoned_at':    now_utc,
            'abandon_reason':  'assembly_worker_lost',
        }, synchronize_session=False)
        _db.commit()
        if worker_lost:
            log.info(
                f"Assembly recovery [{tag}]: abandoned {worker_lost} rows "
                f"(reason=assembly_worker_lost, deadline={_ASSEMBLE_DEADLINE_MIN}m)"
            )
            try:
                from app.core.observability import media_abandon_reason_total
                media_abandon_reason_total.labels(
                    reason="assembly_worker_lost",
                ).inc(worker_lost)
            except Exception:
                pass

        # ── ③ ABANDON chunks-never-arrived rows ────────────────────────
        # 'pending' for > _ABANDON_STALE_MIN with chunks NOT all arrived.
        # chunk_count > 0 guards against rows that haven't been allocated
        # yet (a row with chunk_count==0 is mid-meta-create; flipping it
        # to 'failed' here would be a wrong call).
        chunks_never = _db.query(Media).filter(
            Media.assembly_status == 'pending',
            Media.updated_at < abandon_deadline,
            Media.received_chunks < Media.chunk_count,
            Media.chunk_count > 0,
            Media.abandoned_at.is_(None),
        ).update({
            'assembly_status': 'failed',
            'abandoned_at':    now_utc,
            'abandon_reason':  'chunks_never_arrived',
        }, synchronize_session=False)
        _db.commit()
        if chunks_never:
            log.info(
                f"Assembly recovery [{tag}]: abandoned {chunks_never} rows "
                f"(reason=chunks_never_arrived, deadline={_ABANDON_STALE_MIN}m)"
            )
            try:
                from app.core.observability import media_abandon_reason_total
                media_abandon_reason_total.labels(
                    reason="chunks_never_arrived",
                ).inc(chunks_never)
            except Exception:
                pass

        # ── ④ PROMOTE PARTIAL → SYNCED at first-complete + idle window ────
        # The PWA's bandwidth-tier deferral (mobile-app/src/app.js:8649)
        # holds MEDIUM/HIGH variants back on SLOW / VERY_SLOW networks,
        # transmitting only the LOW (SMALL) variant. The PWA already
        # flips its local `stages.photo=true` once SMALL lands (May 2026
        # "SMALL gates the photo stage" fix) so the IndexedDB queue
        # drains. But the BACKEND keeps `sync_status=PARTIAL` forever
        # because `received_media (e.g. 2)` never reaches
        # `expected_media (e.g. 3)`. The dashboard + PWA both surface
        # PARTIAL as "in queue" — operator confusion, reports look stuck.
        #
        # Promotion rule: for any Report.sync_status==PARTIAL, group its
        # Media rows by photo_group_id (NULL → solo). If EVERY group has
        # at least one row with `assembly_status='complete'` AND the
        # report has had ZERO Media activity within the last
        # _PARTIAL_PROMOTE_IDLE_S seconds (so we don't preempt an
        # in-flight MEDIUM/HIGH upload that's still arriving), flip
        # sync_status → SYNCED. The promotion is non-destructive: a
        # deferred HIGH-tier upload that lands AFTER promotion just
        # adds another Media row; sync_status is already SYNCED so the
        # /attach endpoint's `>=` check is a no-op.
        #
        # Conservative by design: this is a one-way PROMOTION (never
        # demotes a SYNCED back to PARTIAL), so a race with the
        # /attach endpoint is harmless — both paths converge on SYNCED.
        idle_cutoff = now_utc - timedelta(seconds=_PARTIAL_PROMOTE_IDLE_S)
        partial_candidates = (
            _db.query(Report)
            .filter(Report.sync_status == SyncStatusEnum.PARTIAL)
            .all()
        )
        promoted_ids: list[str] = []
        for r in partial_candidates:
            media_rows = (
                _db.query(Media)
                .filter(Media.report_id == r.id)
                .all()
            )
            if not media_rows:
                # No media landed at all — different bug pattern
                # (chunks_never_arrived already handled at media-row
                # scope by action ③). Don't auto-promote here; let
                # the operator decide.
                continue
            # Idle-window gate: if ANY media row has been touched within
            # the idle window, an upload may still be in flight — wait
            # for the next sweep tick.
            most_recent_activity = max(
                (m.updated_at for m in media_rows if m.updated_at is not None),
                default=None,
            )
            if most_recent_activity is not None and most_recent_activity > idle_cutoff:
                continue
            # Group by (photo_group_id, type). Solo rows (no group_id)
            # form their own group keyed by media id so they're checked
            # individually. Abandoned rows are excluded from "complete"
            # consideration (they're terminal-failed by actions ②/③).
            from collections import defaultdict
            groups: dict[tuple, list] = defaultdict(list)
            for m in media_rows:
                if m.abandoned_at is not None:
                    continue
                gid = m.photo_group_id or f"__solo__{m.id}"
                mtype = m.type.value if hasattr(m.type, "value") else m.type
                groups[(gid, mtype)].append(m)
            if not groups:
                # All media rows abandoned — different operator scenario.
                continue
            all_good = all(
                any(m.assembly_status == "complete" for m in variants)
                for variants in groups.values()
            )
            if all_good:
                r.sync_status = SyncStatusEnum.SYNCED
                promoted_ids.append(r.id)
        if promoted_ids:
            _db.commit()
            try:
                from app.core.observability import partial_promote_total
                partial_promote_total.inc(len(promoted_ids))
            except Exception:
                pass
            log.info(
                f"Assembly recovery [{tag}]: promoted {len(promoted_ids)} reports "
                f"PARTIAL → SYNCED (first-complete per photo_group + idle "
                f"≥{_PARTIAL_PROMOTE_IDLE_S}s). IDs: "
                + ", ".join(rid[:8] for rid in promoted_ids[:8])
                + (f" … +{len(promoted_ids) - 8} more" if len(promoted_ids) > 8 else "")
            )
        # ── Action ⑤ — purge expired pre-blur internal store entries.
        #
        # B-F (May 2026): the retroactive upgrade path needs a snapshot
        # of the assembled-but-pre-blur bytes for up to 24 h, so a
        # late-arriving higher tier can re-blur a lower tier with the
        # detected union. After the 24 h retention window, those bytes
        # are no longer useful — drop them to bound storage.
        #
        # Query is indexed (ix_media_pre_blur_retained_until) so the
        # scan is cheap even as media grows.
        try:
            from app.services.storage import get_storage as _gs
            _purge_db = SessionLocal()
            purged_keys: list = []
            try:
                _expired = (
                    _purge_db.query(Media)
                    .filter(Media.pre_blur_internal_key.isnot(None))
                    .filter(Media.pre_blur_retained_until.isnot(None))
                    .filter(Media.pre_blur_retained_until < now_utc)
                    .limit(500)  # cap per pass to keep the daemon responsive
                    .all()
                )
                _storage = _gs()
                for m in _expired:
                    key = m.pre_blur_internal_key
                    try:
                        _storage.delete_internal(key)
                    except Exception as _del_e:
                        # Don't let a single bad delete wedge the sweep.
                        log.warning(
                            f"Assembly recovery [{tag}] Action ⑤: "
                            f"delete_internal failed for key={key}: {_del_e}"
                        )
                    purged_keys.append(key)
                    m.pre_blur_internal_key = None
                    m.pre_blur_retained_until = None
                if purged_keys:
                    _purge_db.commit()
                    log.info(
                        f"Assembly recovery [{tag}] Action ⑤: purged "
                        f"{len(purged_keys)} pre-blur internal entries past "
                        f"24h retention."
                    )
            finally:
                _purge_db.close()
        except Exception as _action5_e:
            # Defensive: a sweep crash MUST NOT kill the daemon. Any
            # error here is logged + ignored — the next tick retries.
            log.warning(
                f"Assembly recovery [{tag}] Action ⑤ failed: {_action5_e}"
            )

        # ── Action ⑥ — hard-delete abandoned-not-recovered rows past
        #    the retention window (R2.b, May 2026).
        #
        # Soft-abandons live in the DB indefinitely so a returning
        # client can revive them. That's correct in the short term but
        # produces an unbounded backlog at scale (a 1 % abandon rate
        # on a 500k-report crisis is ~5000 stuck Media rows × ~3 MB
        # chunks ≈ 15 GB of Postgres TOAST per crisis).
        #
        # Action ⑥ caps the recovery window with a hard delete past
        # CRISP_HARD_ABANDON_DAYS (default 30). Rows where:
        #   - abandoned_at < now - N days
        #   - recovered_at IS NULL
        # are deleted. The Media → MediaChunk cascade handles the
        # chunk rows automatically. The corresponding storage object
        # (assembled file, if any) is deleted via storage.delete().
        # Bounded at 500 rows per sweep tick so a backlog clean-up
        # doesn't block the daemon's other actions.
        #
        # Recovered rows (recovered_at IS NOT NULL) are NEVER deleted
        # — they're successful uploads that happened to have been
        # abandoned mid-flight. Hard-abandon rows (checksum_mismatch /
        # original_too_large) are deleted on the same schedule —
        # their bytes are irrecoverable; the operator's reclaim path
        # is the F3 button, not chunk replay.
        try:
            hard_abandon_deadline = now_utc - timedelta(days=_HARD_ABANDON_DAYS)
            _purge = (
                _db.query(Media)
                .filter(Media.abandoned_at.isnot(None))
                .filter(Media.abandoned_at < hard_abandon_deadline)
                .filter(Media.recovered_at.is_(None))
                .limit(500)
                .all()
            )
            if _purge:
                from app.services.storage import get_storage as _gs6
                try:
                    _storage6 = _gs6()
                except Exception:
                    _storage6 = None
                # Aggregate the abandon-reason counts up front so we
                # can increment the metric in one bulk operation.
                from collections import Counter as _Counter
                reason_counts = _Counter(
                    (m.abandon_reason or 'unknown') for m in _purge
                )
                # Best-effort delete of the storage object (if any).
                # The Media → MediaChunk cascade handles the row delete
                # itself; we just need to clean up the on-disk asset.
                for m in _purge:
                    if _storage6 is not None and m.url:
                        try:
                            _storage6.delete(m.url)
                        except Exception as _del_e:
                            log.warning(
                                f"Assembly recovery [{tag}] Action ⑥: "
                                f"storage.delete failed for url={m.url}: {_del_e}"
                            )
                    _db.delete(m)
                _db.commit()
                log.info(
                    f"Assembly recovery [{tag}] Action ⑥: hard-deleted "
                    f"{len(_purge)} Media rows past "
                    f"{_HARD_ABANDON_DAYS}d retention. "
                    f"Reason breakdown: {dict(reason_counts)}"
                )
                try:
                    from app.core.observability import media_hard_deleted_total as _mhdt
                    for reason, n in reason_counts.items():
                        _mhdt.labels(reason=reason).inc(n)
                except Exception:
                    pass
        except Exception as _action6_e:
            log.warning(
                f"Assembly recovery [{tag}] Action ⑥ failed: {_action6_e}"
            )

        # ── Action ⑦ — disk-orphan reconciliation (R3.b, May 2026) ───
        #
        # The SQL cascade (Media → MediaChunk) handles chunk-row cleanup,
        # and Action ⑥ deletes the assembled storage object via
        # storage.delete(). But two paths still leak disk objects:
        #
        #   (a) Pre-R3.b reports that were abandoned + hard-deleted by
        #       Action ⑥ before this action existed
        #   (b) Storage writes that succeeded but whose Media.url
        #       INSERT then failed (very rare but possible under load)
        #
        # Action ⑦ walks the storage backend, cross-references each
        # object against live Media.url values, and deletes anything
        # older than _HARD_ABANDON_DAYS with no live referrer. Bounded
        # at 1000 objects per scan to keep the daemon responsive.
        # Throttled to run at most once every _DISK_ORPHAN_GC_INTERVAL_S
        # seconds so the cost is amortised across many 5-min sweep
        # ticks.
        global _last_disk_orphan_gc_ts
        if _DISK_ORPHAN_GC_INTERVAL_S > 0:
            try:
                import time as _time7
                now_ts = _time7.time()
                if (now_ts - _last_disk_orphan_gc_ts) >= _DISK_ORPHAN_GC_INTERVAL_S:
                    age_cutoff = now_ts - (_HARD_ABANDON_DAYS * 86400)
                    from app.services.storage import get_storage as _gs7
                    try:
                        _storage7 = _gs7()
                    except Exception:
                        _storage7 = None
                    if _storage7 is not None:
                        # Walk the public uploads/ namespace. The
                        # storage list_keys() implementation skips
                        # the pre_blur/ namespace from an empty-prefix
                        # scan so internal bytes are never touched here.
                        candidates = _storage7.list_keys(
                            prefix="",
                            older_than_unix_ts=age_cutoff,
                            limit=1000,
                        )
                        if candidates:
                            # Pull all live media.url values so we know
                            # what's referenced. Using a set for O(1)
                            # lookup against the candidates list.
                            live_urls = set(
                                row[0] for row in
                                _db.query(Media.url).filter(Media.url != '').all()
                            )
                            # Normalise the candidate key into the
                            # shape `media.url` actually stores. Local
                            # backend wraps filenames as `/static/<name>`.
                            # S3 backend stores them as `s3://<key>`.
                            # We test both representations against the
                            # live set.
                            deleted = 0
                            for (key, mtime) in candidates:
                                local_form = f"/static/{key}"
                                s3_form    = f"s3://{key}"
                                if local_form in live_urls or s3_form in live_urls or key in live_urls:
                                    continue
                                # No live referrer + over retention age
                                # → delete.
                                ok = False
                                try:
                                    ok = bool(_storage7.delete(local_form))
                                    if not ok:
                                        ok = bool(_storage7.delete(s3_form))
                                except Exception as _del7_e:
                                    log.warning(
                                        f"Assembly recovery [{tag}] Action ⑦: "
                                        f"storage.delete failed for key={key}: {_del7_e}"
                                    )
                                if ok:
                                    deleted += 1
                            if deleted:
                                log.info(
                                    f"Assembly recovery [{tag}] Action ⑦: "
                                    f"GC'd {deleted} disk-orphan object(s) "
                                    f"under uploads/ (older than "
                                    f"{_HARD_ABANDON_DAYS}d, no live "
                                    f"Media.url referrer)"
                                )
                                try:
                                    from app.core.observability import disk_orphan_deleted_total as _dod
                                    _dod.labels(prefix="uploads").inc(deleted)
                                except Exception:
                                    pass
                        _last_disk_orphan_gc_ts = now_ts
            except Exception as _action7_e:
                log.warning(
                    f"Assembly recovery [{tag}] Action ⑦ failed: {_action7_e}"
                )
    finally:
        _db.close()


def _assembly_recovery_loop():
    """Daemon thread — invokes `_run_assembly_recovery_sweep` every
    `_ASSEMBLE_SWEEP_INTERVAL_S` seconds.

    Boot ordering note: the lifespan handler synchronously calls the
    boot-time sweep BEFORE this thread is spawned, so the first
    `_t.sleep(interval)` ensures the periodic tick fires well after the
    boot pass commits and avoids any double-up on `_assembly_executor`.
    """
    import time as _t
    _t.sleep(_ASSEMBLE_SWEEP_INTERVAL_S)
    while True:
        try:
            _run_assembly_recovery_sweep(boot=False)
        except Exception as e:
            logging.getLogger(__name__).warning(
                f"Periodic assembly recovery error: {e}"
            )
        _t.sleep(_ASSEMBLE_SWEEP_INTERVAL_S)


async def _run_startup_tasks():
    """Body runs once at app startup, invoked from the lifespan handler
    above (line ~241). Was @app.on_event('startup') before May 2026;
    rename + decorator removal closed the FastAPI deprecation warning."""
    # Skip background daemons during pytest. The daemons query persistent
    # tables (media, reports) that pytest's per-test transactions roll
    # back; the daemons then spam stderr with 'relation does not exist'
    # which drowns the pytest summary line.
    in_pytest = bool(os.environ.get("PYTEST_CURRENT_TEST"))

    # Purge worker
    if not in_pytest:
        t = threading.Thread(target=_purge_loop, daemon=True)
        t.start()
        logging.getLogger(__name__).info("Deletion purge worker started (runs every 15 min)")

    # Phase F image-reliability (May 2026). Two-stage recovery:
    #   ① boot-time sweep — runs synchronously RIGHT NOW so we don't
    #      ship traffic to a backend with stale 'assembling' rows from
    #      the previous instance's crash. Same logic as the periodic
    #      sweep below.
    #   ② periodic daemon — every _ASSEMBLE_SWEEP_INTERVAL_S (5 min)
    #      thereafter, finds rows the PWA never finished delivering
    #      and flips them to 'failed' with abandon_reason so the
    #      dashboard renders "Original lost" instead of perpetual
    #      "uploading…".
    if not in_pytest:
        try:
            _run_assembly_recovery_sweep(boot=True)
        except Exception as e:
            logging.getLogger(__name__).warning(
                f"Boot-time assembly recovery sweep failed: {e}"
            )
        threading.Thread(target=_assembly_recovery_loop, daemon=True).start()
        logging.getLogger(__name__).info(
            f"Assembly recovery daemon started "
            f"(interval={_ASSEMBLE_SWEEP_INTERVAL_S}s, "
            f"abandon_stale={_ABANDON_STALE_MIN}m, "
            f"assemble_deadline={_ASSEMBLE_DEADLINE_MIN}m)"
        )

    # Phase K K.6.b — AI retry queue daemon. Picks up
    # `ai_retry_queue` rows whose `next_attempt_at <= NOW()` and
    # re-runs the failed Whisper / Claude vision / truth_scoring
    # call with exponential backoff (1m / 5m / 30m / 2h / 12h).
    # Pre-K.6.b a transient AI failure left the report's AI fields
    # NULL forever — no automated retry. The boot-time reclaim
    # sweeps rows stuck in 'in_progress' from a crashed previous
    # instance so they're picked up by the next periodic tick.
    if not in_pytest:
        try:
            from app.db.session import SessionLocal as _SL_ai
            from app.services.ai_retry_queue import reclaim_stuck_in_progress
            _ai_db = _SL_ai()
            try:
                reclaim_stuck_in_progress(_ai_db, older_than_minutes=30)
            finally:
                _ai_db.close()
        except Exception as e:
            logging.getLogger(__name__).warning(
                f"Boot-time AI retry reclaim failed: {e}"
            )
        try:
            from app.services.ai_retry_queue import _ai_retry_loop
            threading.Thread(target=_ai_retry_loop, daemon=True).start()
            logging.getLogger(__name__).info(
                "AI retry daemon started "
                "(backoff 1m / 5m / 30m / 2h / 12h, 5-attempt cap)"
            )
        except Exception as e:
            logging.getLogger(__name__).warning(
                f"AI retry daemon failed to start: {e}"
            )

    # Auto-start Telegram polling if token is configured
    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if telegram_token:
        try:
            from messaging_bot.telegram.webhook import telegram_router
            import httpx
            # Delete any stale webhook and start polling
            async with httpx.AsyncClient(timeout=10) as c:
                await c.get(f"https://api.telegram.org/bot{telegram_token}/deleteWebhook", params={"drop_pending_updates": "false"})
            from messaging_bot.telegram.webhook import _poll_loop, _polling_active
            import messaging_bot.telegram.webhook as tg_wh
            tg_wh._polling_active = True
            tg_wh._polling_task = asyncio.create_task(tg_wh._poll_loop())
            logging.getLogger(__name__).info("Telegram polling auto-started on boot")
        except Exception as e:
            logging.getLogger(__name__).warning(f"Telegram auto-start failed: {e}")
