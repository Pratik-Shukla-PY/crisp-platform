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
import logging
from dotenv import load_dotenv

# Load .env into os.environ BEFORE any service singletons are imported
_env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
load_dotenv(dotenv_path=_env_path, override=True)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.api.router import api_router

# Configure logging to show debug messages
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

if not os.path.exists("uploads"):
    os.makedirs("uploads")

from app.core.config import settings
from app.db.session import engine
from app.models.report import Base

# For development MVP: auto-create tables if they don't exist. 
# Production generally requires Alembic migrations.
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    description="Community-driven Rapid Infrastructure Sensing Platform Backend API"
)

# CORS Configuration for the Web Dashboard integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
