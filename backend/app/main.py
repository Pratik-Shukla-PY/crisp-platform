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

# Environment-aware logging (default INFO, set LOG_LEVEL=DEBUG for dev)
_log_level = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _log_level, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ── Security: Admin API Key ──────────────────────────────────────────────────
ADMIN_KEY = os.getenv("CRISP_ADMIN_KEY", "")

def verify_admin_key(request: Request):
    """Dependency: require X-Admin-Key header for admin-only endpoints."""
    if not ADMIN_KEY:
        return  # No key configured = dev mode (all allowed)
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

_migrate_schema()

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    description="Community-driven Rapid Infrastructure Sensing Platform Backend API"
)

# CORS — restricted to configured origins
_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:8080,http://localhost:8000,http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Admin-Key"],
)


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

@app.get("/health", tags=["system"])
def health_check():
    return {"status": "CRISP Core Backend Online", "version": settings.VERSION}


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
