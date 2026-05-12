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
_rate_limits = defaultdict(list)

def check_rate_limit(key: str, max_requests: int = 30, window: int = 60) -> bool:
    """In-memory rate limiter. Returns False if limit exceeded."""
    now = time.time()
    _rate_limits[key] = [t for t in _rate_limits[key] if now - t < window]
    if len(_rate_limits[key]) >= max_requests:
        return False
    _rate_limits[key].append(now)
    return True


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
    allow_headers=["Content-Type", "Authorization", "X-Admin-Key"],
    expose_headers=["X-Total-Count", "X-Limit", "X-Offset"],
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

async def _run_startup_tasks():
    """Body runs once at app startup, invoked from the lifespan handler
    above (line ~241). Was @app.on_event('startup') before May 2026;
    rename + decorator removal closed the FastAPI deprecation warning."""
    # Purge worker
    t = threading.Thread(target=_purge_loop, daemon=True)
    t.start()
    logging.getLogger(__name__).info("Deletion purge worker started (runs every 15 min)")

    # P1.1 / P2.15 — Assembly recovery sweep. If the previous backend was
    # killed (crash, uvicorn --reload, OOM) while assembling a media, its
    # assembly_status stayed 'assembling' with no worker left to finish it.
    # On boot we:
    #   1) reset any media whose status is 'assembling' or 'failed' AND all
    #      chunks have in fact arrived back to 'pending';
    #   2) actively RE-SUBMIT those rows to the assembly pool so they finish
    #      even when no more client chunks are on the way (this is common for
    #      the guaranteed-delivery pipeline — every variant finishes chunking
    #      before the next one starts, so a crash mid-assembly on the last
    #      variant has nothing to retrigger it).
    # Only resets rows >2 min old to avoid interfering with a legitimately-
    # in-flight assembly on a sibling process.
    try:
        from app.db.session import SessionLocal
        from app.models.report import Media
        from app.api.endpoints.reports import _try_full_assembly_bg, _assembly_executor
        from datetime import datetime, timedelta, timezone as _tz
        _db = SessionLocal()
        try:
            stale = datetime.now(_tz.utc) - timedelta(minutes=2)
            # First pass — collect the rows we're about to reset so we can
            # re-submit them by id after the UPDATE commits.
            to_resubmit = _db.query(
                Media.id, Media.type, Media.report_id
            ).filter(
                Media.assembly_status.in_(['assembling', 'failed', 'pending']),
                Media.updated_at < stale,
                Media.chunk_count > 0,
                Media.received_chunks >= Media.chunk_count,
            ).all()
            # Reset stuck 'assembling' / 'failed' back to 'pending'; leave
            # genuinely-pending rows alone on the status flip but still
            # enqueue them (they were never submitted in the first place).
            rowcount = _db.query(Media).filter(
                Media.assembly_status.in_(['assembling', 'failed']),
                Media.updated_at < stale,
                Media.chunk_count > 0,
                Media.received_chunks >= Media.chunk_count,
            ).update({'assembly_status': 'pending'}, synchronize_session=False)
            _db.commit()
            if rowcount:
                logging.getLogger(__name__).info(
                    f"Assembly recovery: reset {rowcount} stuck media to 'pending'"
                )
            # Re-submit to the assembly pool. _try_full_assembly_bg does its
            # own CAS internally so double-submits are safe.
            if to_resubmit:
                for m in to_resubmit:
                    _assembly_executor.submit(
                        _try_full_assembly_bg, m.id, m.type.value, m.report_id
                    )
                logging.getLogger(__name__).info(
                    f"Assembly recovery: re-submitted {len(to_resubmit)} media to pool"
                )
        finally:
            _db.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Assembly recovery sweep failed: {e}")

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
