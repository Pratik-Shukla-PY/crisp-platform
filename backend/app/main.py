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
import logging
import time
from collections import defaultdict
from dotenv import load_dotenv

# Load .env into os.environ BEFORE any service singletons are imported
_env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
load_dotenv(dotenv_path=_env_path, override=True)

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

# For development MVP: auto-create tables if they don't exist.
# Production generally requires Alembic migrations.
Base.metadata.create_all(bind=engine)

# Migrate existing DBs: add new columns that don't exist yet (idempotent)
def _migrate_schema():
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    if "reports" in insp.get_table_names():
        existing = {c["name"] for c in insp.get_columns("reports")}
        new_cols = {
            "damage_classification": "VARCHAR(20)",
            "crisis_type": "VARCHAR(30)",
            "infrastructure_name": "VARCHAR(255)",
            "debris_clearing_needed": "BOOLEAN",
            "service_status": "JSON",
            "building_id": "VARCHAR(36)",
        }
        with engine.begin() as conn:
            for col, typ in new_cols.items():
                if col not in existing:
                    conn.execute(text(f"ALTER TABLE reports ADD COLUMN {col} {typ}"))
                    logging.getLogger(__name__).info(f"Migrated: added reports.{col}")

    # P1.1 — `media.updated_at` is used by the assembly lock's stale-escape
    # logic. Add it if missing on an existing DB. SQLite can't add a column
    # with a non-constant default, so we add as NULL and backfill with
    # created_at so existing rows aren't treated as infinitely-stale.
    if "media" in insp.get_table_names():
        existing_media = {c["name"] for c in insp.get_columns("media")}
        if "updated_at" not in existing_media:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE media ADD COLUMN updated_at DATETIME"))
                conn.execute(text("UPDATE media SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP)"))
                logging.getLogger(__name__).info("Migrated: added media.updated_at and backfilled")

        # Guaranteed-delivery pipeline — SMALL/MEDIUM/LARGE variants of one
        # captured photo share a `photo_group_id`. Nullable so existing media
        # (pre-variant-pipeline) keeps working unchanged. Index speeds up the
        # dashboard's group-by query.
        if "photo_group_id" not in existing_media:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE media ADD COLUMN photo_group_id VARCHAR(36)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_media_photo_group ON media(photo_group_id)"))
                logging.getLogger(__name__).info("Migrated: added media.photo_group_id + index")

        # Apr 2026 — `client_blur_applied` flag. When the client has already
        # face-blurred the image locally, the server skips its own blur_pii
        # pass to avoid a second lossy re-encode. Legacy clients that don't
        # send the flag default to FALSE so server blur still runs for them.
        if "client_blur_applied" not in existing_media:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE media ADD COLUMN client_blur_applied "
                    "BOOLEAN NOT NULL DEFAULT 0"
                ))
                logging.getLogger(__name__).info("Migrated: added media.client_blur_applied")

    # Phase 4 (Apr 2026) — AutoSubmitRegion model. Idempotent CREATE TABLE
    # so existing deployments pick it up on next boot without an external
    # migration tool. `create_all` on Base.metadata handles this for any
    # model declared on the same Base — that call already happens at
    # import time in app/db/session.py, but we touch it here as a belt so
    # the order is explicit even if that changes.
    try:
        from app.models.report import AutoSubmitRegion  # noqa: F401
        AutoSubmitRegion.__table__.create(bind=engine, checkfirst=True)
    except Exception as e:
        logging.getLogger(__name__).warning(f"AutoSubmitRegion migration: {e}")

    # Phase 5 (Apr 2026) — reviewer workflow columns on reports.
    if "reports" in insp.get_table_names():
        existing_r = {c["name"] for c in insp.get_columns("reports")}
        reviewer_cols = {
            "reviewed_at": "DATETIME",
            "reviewer_verdict": "VARCHAR(20)",
            "action_taken": "TEXT",
            "help_dispatched_at": "DATETIME",
            "help_arrived_at": "DATETIME",
        }
        with engine.begin() as conn:
            added = []
            for col, typ in reviewer_cols.items():
                if col not in existing_r:
                    conn.execute(text(f"ALTER TABLE reports ADD COLUMN {col} {typ}"))
                    added.append(col)
            if "reviewer_verdict" in added:
                # Backfill existing rows to NOT_REVIEWED so the enum never
                # hits a NULL on read.
                conn.execute(text(
                    "UPDATE reports SET reviewer_verdict = 'NOT_REVIEWED' "
                    "WHERE reviewer_verdict IS NULL"
                ))
            if added:
                logging.getLogger(__name__).info(
                    f"Migrated: added reports.{', reports.'.join(added)}"
                )

_migrate_schema()

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    description="Community-driven Rapid Infrastructure Sensing Platform Backend API"
)

# CORS — P2.7: tighter rules in production.
#
# In dev we happily accept localhost + LAN IPs. In production we require
# CORS_ORIGINS to be explicitly set to the real dashboard domain — a missing
# env var would previously have silently allowed the dev defaults, giving
# a same-LAN attacker on the host a free authenticated-request channel
# thanks to `allow_credentials=True`.
_default_dev_origins = "http://localhost:8080,http://localhost:8000,http://localhost:3000"
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
if not _cors_env:
    if APP_ENV == "production":
        raise RuntimeError(
            "CORS_ORIGINS env var is required when APP_ENV=production. "
            "Set it to a comma-separated list of the exact origins your "
            "dashboard is served from (e.g. 'https://dashboard.crisp.undp.org')."
        )
    _cors_env = _default_dev_origins
    logging.getLogger(__name__).warning(
        "CORS_ORIGINS not set and APP_ENV=%s — defaulting to localhost.",
        APP_ENV,
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

@app.on_event("startup")
async def start_background_workers():
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
