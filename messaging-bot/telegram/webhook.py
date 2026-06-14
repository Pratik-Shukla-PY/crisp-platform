"""
Telegram Webhook - FastAPI router that receives updates from Telegram Bot API.
Supports both webhook mode and polling mode (for local development).

Webhook: POST /webhook/<secret> - receives updates from Telegram
Polling: GET /start-polling - starts long-polling in background (no ngrok needed)
"""
import os
import hashlib
import logging
import secrets
import asyncio
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks

from .handlers import handle_update

logger = logging.getLogger(__name__)

telegram_router = APIRouter()

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

# Non-guessable webhook path
WEBHOOK_SECRET_PATH = os.getenv(
    "TELEGRAM_WEBHOOK_PATH_SECRET",
    secrets.token_urlsafe(24)
)

# Polling state
_polling_active = False
_polling_task = None


# ── Webhook Mode (for production / ngrok) ──────────────────────────────────────

@telegram_router.post(f"/webhook/{WEBHOOK_SECRET_PATH}")
async def receive_update(request: Request, background_tasks: BackgroundTasks):
    """Receive an update from Telegram via webhook.

    P2.16 - defence in depth:
      1. The URL path itself includes a per-deploy secret (existing).
      2. Telegram's ``X-Telegram-Bot-Api-Secret-Token`` header is verified
         when ``TELEGRAM_WEBHOOK_SECRET_TOKEN`` is configured. Matches the
         value registered with ``setWebhook`` on Telegram's side.
      3. Rate limit: 60 updates/min per source IP (= 1/s) - prevents a
         hostile actor who leaked the secret path from DoSing the endpoint.
    """
    import os
    from app.main import check_rate_limit
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(f"tg_webhook:{client_ip}", max_requests=60, window=60):
        raise HTTPException(status_code=429, detail="rate limit")

    expected_token = os.getenv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "").strip()
    if expected_token:
        got = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if got != expected_token:
            raise HTTPException(status_code=403, detail="bad secret token")

    try:
        update = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    if not isinstance(update, dict) or "update_id" not in update:
        raise HTTPException(status_code=400, detail="Invalid update")

    # Process in background
    background_tasks.add_task(handle_update, update)
    return {"ok": True}


# ── Polling Mode (for local dev - no ngrok needed) ─────────────────────────────

async def _poll_loop():
    """Long-polling loop: fetches updates from Telegram API directly."""
    global _polling_active
    import httpx

    offset = 0
    api = f"https://api.telegram.org/bot{BOT_TOKEN}"
    logger.info("Telegram polling started")

    while _polling_active:
        try:
            async with httpx.AsyncClient(timeout=35) as c:
                r = await c.get(f"{api}/getUpdates", params={
                    "offset": offset,
                    "timeout": 30,
                    "allowed_updates": '["message","callback_query"]',
                })
                if r.status_code == 409:
                    # Another polling instance is active - wait and retry
                    logger.warning("Polling conflict (409) - retrying in 3s")
                    await asyncio.sleep(3)
                    continue
                if r.status_code != 200:
                    logger.warning(f"Polling error ({r.status_code}): {r.text[:100]}")
                    await asyncio.sleep(5)
                    continue

                data = r.json()
                updates = data.get("result", [])

                for update in updates:
                    offset = update["update_id"] + 1
                    msg = update.get("message", {})
                    cb = update.get("callback_query", {})
                    utype = "callback" if cb else ("photo" if msg.get("photo") else "voice" if msg.get("voice") else "location" if msg.get("location") else "text")
                    logger.info(f"[TG Poll] update_id={update['update_id']} type={utype}")
                    try:
                        await handle_update(update)
                    except Exception as e:
                        logger.error(f"Update handling error: {type(e).__name__}: {e}")
                        import traceback
                        logger.error(traceback.format_exc())

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"Polling connection error: {e}")
            await asyncio.sleep(5)

    logger.info("Telegram polling stopped")


@telegram_router.get("/start-polling")
async def start_polling(request: Request):
    """
    Start long-polling mode (for local dev without ngrok).
    Only accessible from localhost.
    """
    global _polling_active, _polling_task

    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")

    if not BOT_TOKEN:
        return {"error": "TELEGRAM_BOT_TOKEN not set in .env"}

    # Stop any existing polling first
    if _polling_active or _polling_task:
        _polling_active = False
        if _polling_task and not _polling_task.done():
            _polling_task.cancel()
            try:
                await _polling_task
            except (asyncio.CancelledError, Exception):
                pass
        _polling_task = None
        await asyncio.sleep(1)

    # Delete any existing webhook AND drop pending updates
    import httpx
    async with httpx.AsyncClient(timeout=10) as c:
        await c.get(f"https://api.telegram.org/bot{BOT_TOKEN}/deleteWebhook", params={"drop_pending_updates": "true"})

    _polling_active = True
    _polling_task = asyncio.create_task(_poll_loop())
    return {"status": "Polling started - send a message to your bot on Telegram"}


@telegram_router.get("/stop-polling")
async def stop_polling(request: Request):
    """Stop long-polling mode."""
    global _polling_active, _polling_task
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")

    _polling_active = False
    if _polling_task and not _polling_task.done():
        _polling_task.cancel()
    _polling_task = None
    return {"status": "Polling stopped"}


# ── Status ─────────────────────────────────────────────────────────────────────

@telegram_router.get("/status")
async def telegram_status():
    """Health check for Telegram integration."""
    from .session_manager import _sessions
    active = sum(1 for s in _sessions.values() if s.state not in ("DONE",))
    return {
        "status": "Telegram Bot Online" if BOT_TOKEN else "Not configured",
        "active_sessions": active,
        "bot_token_set": bool(BOT_TOKEN),
        "polling_active": _polling_active,
        "webhook_path_configured": bool(WEBHOOK_SECRET_PATH),
    }


@telegram_router.get("/webhook-url")
async def get_webhook_url(request: Request):
    """Returns the webhook URL for Telegram setup (local only)."""
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")

    base = str(request.base_url).rstrip("/")
    path = f"/api/v1/telegram/webhook/{WEBHOOK_SECRET_PATH}"
    return {
        "webhook_url": f"{base}{path}",
        "note": "For ngrok: replace base URL with your ngrok HTTPS URL. For local dev: use /start-polling instead (no ngrok needed).",
    }
