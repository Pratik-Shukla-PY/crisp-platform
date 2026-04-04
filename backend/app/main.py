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
def start_purge_worker():
    t = threading.Thread(target=_purge_loop, daemon=True)
    t.start()
    logging.getLogger(__name__).info("Deletion purge worker started (runs every 15 min)")
