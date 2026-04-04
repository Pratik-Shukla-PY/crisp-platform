"""
WhatsApp Webhook — Secure FastAPI router for Meta Cloud API.

Security features:
  - Non-guessable webhook path using a random secret string
  - HMAC-SHA256 signature validation
  - Strict payload structure validation
  - Rate limiting (per-IP)
  - Masked phone number logging (no sensitive data in logs)
  - No raw payload logging
"""
import os
import hmac
import hashlib
import logging
import secrets
import time
from collections import defaultdict
from datetime import datetime, timezone
from fastapi import APIRouter, Request, Query, HTTPException, BackgroundTasks

from .handlers import handle_incoming_message

logger = logging.getLogger(__name__)

whatsapp_router = APIRouter()

# ── Configuration ──────────────────────────────────────────────────────────────
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "crisp-webhook-verify-2026")
APP_SECRET = os.getenv("WHATSAPP_APP_SECRET", "")

# Non-guessable webhook path segment — generated once per server start,
# or use a fixed value from .env for stable ngrok configuration.
WEBHOOK_SECRET_PATH = os.getenv(
    "WHATSAPP_WEBHOOK_PATH_SECRET",
    secrets.token_urlsafe(24)  # e.g. "xK9mP2qR7vT4wY6z..."
)

# ── Rate Limiting ──────────────────────────────────────────────────────────────
_rate_store: dict = defaultdict(list)  # IP → [timestamps]
RATE_LIMIT = 30         # max requests per window
RATE_WINDOW = 60        # window in seconds


def _check_rate_limit(ip: str) -> bool:
    """Returns True if request should be allowed, False if rate-limited."""
    now = time.time()
    # Prune old timestamps
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT:
        return False
    _rate_store[ip].append(now)
    return True


# ── Helpers ────────────────────────────────────────────────────────────────────
def _mask_phone(phone: str) -> str:
    """Mask phone number for safe logging: +91987654321 → +91****4321"""
    if len(phone) > 6:
        return phone[:3] + "****" + phone[-4:]
    return "****"


def _validate_signature(payload: bytes, signature: str) -> bool:
    """Validate X-Hub-Signature-256 header using HMAC-SHA256."""
    if not APP_SECRET:
        return True  # Skip in dev mode (no secret configured)
    expected = "sha256=" + hmac.new(
        APP_SECRET.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _validate_whatsapp_payload(data: dict) -> bool:
    """Validate that the payload has the expected WhatsApp Cloud API structure."""
    if not isinstance(data, dict):
        return False
    if "object" not in data or data["object"] != "whatsapp_business_account":
        return False
    entries = data.get("entry")
    if not isinstance(entries, list) or len(entries) == 0:
        return False
    for entry in entries:
        if not isinstance(entry, dict) or "changes" not in entry:
            return False
    return True


# ── Secure Webhook Endpoints ──────────────────────────────────────────────────
# The path includes a non-guessable secret: /webhook/<secret>
# Configure this full path in Meta WhatsApp settings.

@whatsapp_router.get(f"/webhook/{WEBHOOK_SECRET_PATH}")
async def verify_webhook(
    request: Request,
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
):
    """
    Meta Webhook Verification — called once when you register the webhook URL.
    Returns hub.challenge if hub.verify_token matches. Rejects all others.
    """
    client_ip = request.client.host if request.client else "unknown"

    if not _check_rate_limit(client_ip):
        logger.warning(f"Rate limited verification attempt from {client_ip}")
        raise HTTPException(status_code=429, detail="Too many requests")

    if hub_mode == "subscribe" and hub_verify_token == VERIFY_TOKEN:
        logger.info(f"Webhook verified — ip={client_ip}")
        return int(hub_challenge)

    logger.warning(f"Webhook verification REJECTED — ip={client_ip}, mode={hub_mode}")
    raise HTTPException(status_code=403, detail="Verification failed")


@whatsapp_router.post(f"/webhook/{WEBHOOK_SECRET_PATH}")
async def receive_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    Receive incoming WhatsApp messages from Meta Cloud API.
    Validates signature, structure, and rate limits before processing.
    """
    client_ip = request.client.host if request.client else "unknown"

    # Rate limit
    if not _check_rate_limit(client_ip):
        logger.warning(f"Rate limited POST from {client_ip}")
        raise HTTPException(status_code=429, detail="Too many requests")

    # Read body once for both signature check and JSON parsing
    body = await request.body()

    # Reject empty payloads
    if not body or len(body) < 10:
        raise HTTPException(status_code=400, detail="Empty payload")

    # Validate HMAC signature
    signature = request.headers.get("X-Hub-Signature-256", "")
    if APP_SECRET and not _validate_signature(body, signature):
        logger.warning(f"Invalid signature — ip={client_ip}")
        raise HTTPException(status_code=401, detail="Invalid signature")

    # Parse JSON
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # Validate WhatsApp payload structure
    if not _validate_whatsapp_payload(payload):
        logger.warning(f"Malformed WhatsApp payload — ip={client_ip}")
        raise HTTPException(status_code=400, detail="Invalid payload structure")

    # Process messages — only log safe metadata
    msg_count = 0
    try:
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                messages = value.get("messages", [])

                for message in messages:
                    phone = message.get("from", "")
                    if not phone:
                        continue

                    msg_type = message.get("type", "unknown")
                    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
                    msg_count += 1

                    # Safe logging — only type and masked phone
                    logger.info(f"[{ts}] WA msg: type={msg_type} from={_mask_phone(phone)}")

                    # Process in background — return 200 immediately
                    background_tasks.add_task(handle_incoming_message, phone, message)

    except Exception as e:
        # Log error class only, not full message (might contain PII)
        logger.error(f"Webhook processing error: {type(e).__name__}")

    if msg_count == 0:
        # Status updates, read receipts, etc. — acknowledge silently
        logger.debug(f"Non-message webhook event from {client_ip}")

    return {"status": "ok"}


# ── Status & Info ──────────────────────────────────────────────────────────────

@whatsapp_router.get("/status")
async def whatsapp_status():
    """Health check for WhatsApp integration. Does NOT expose the secret path."""
    from .session_manager import _sessions
    active = sum(1 for s in _sessions.values() if s.state not in ("DONE",))
    return {
        "status": "WhatsApp Bot Online",
        "active_sessions": active,
        "verify_token_set": bool(VERIFY_TOKEN),
        "access_token_set": bool(os.getenv("WHATSAPP_ACCESS_TOKEN")),
        "phone_id_set": bool(os.getenv("WHATSAPP_PHONE_NUMBER_ID")),
        "webhook_path_configured": bool(WEBHOOK_SECRET_PATH),
    }


@whatsapp_router.get("/webhook-url")
async def get_webhook_url(request: Request):
    """
    Returns the full webhook URL to configure in Meta WhatsApp settings.
    Only accessible from localhost (not exposed via ngrok).
    """
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Local access only")

    base = str(request.base_url).rstrip("/")
    path = f"/api/v1/whatsapp/webhook/{WEBHOOK_SECRET_PATH}"
    return {
        "webhook_url": f"{base}{path}",
        "verify_token": VERIFY_TOKEN,
        "note": "Use the webhook_url in Meta WhatsApp Cloud API settings. For ngrok, replace the base URL with your ngrok HTTPS URL.",
    }
