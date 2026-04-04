"""
Telegram Media Handler — Downloads media from Telegram Bot API servers,
encodes to base64 for CRISP backend consumption.
"""
import os
import base64
import logging
import httpx

logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"
FILE_BASE = f"https://api.telegram.org/file/bot{BOT_TOKEN}"
MAX_RETRIES = 3


async def download_media(file_id: str) -> dict:
    """
    Download media from Telegram servers.

    1. Call getFile to get the file_path
    2. Download binary from https://api.telegram.org/file/bot<token>/<file_path>
    3. Return {data_url, data_b64, mime_type, size_bytes}
    """
    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                # Step 1: Get file path
                r = await c.get(f"{API_BASE}/getFile", params={"file_id": file_id})
                if r.status_code != 200:
                    logger.warning(f"getFile failed ({r.status_code})")
                    continue

                result = r.json().get("result", {})
                file_path = result.get("file_path", "")
                file_size = result.get("file_size", 0)

                if not file_path:
                    logger.warning(f"No file_path in getFile result")
                    continue

                # Determine MIME type from file path
                mime_type = _guess_mime(file_path)

                # Step 2: Download binary
                r2 = await c.get(f"{FILE_BASE}/{file_path}")
                if r2.status_code != 200:
                    logger.warning(f"File download failed ({r2.status_code})")
                    continue

                content = r2.content
                b64 = base64.b64encode(content).decode()
                data_url = f"data:{mime_type};base64,{b64}"

                logger.info(f"Media downloaded: {file_id} ({len(content):,} bytes, {mime_type})")
                return {
                    "data_url": data_url,
                    "data_b64": b64,
                    "mime_type": mime_type,
                    "size_bytes": len(content),
                }

        except Exception as e:
            logger.warning(f"Media download attempt {attempt+1}/{MAX_RETRIES} failed: {e}")

    logger.error(f"Media download failed after {MAX_RETRIES} retries: {file_id}")
    return {}


def _guess_mime(file_path: str) -> str:
    """Guess MIME type from Telegram file path."""
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    mime_map = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp",
        "ogg": "audio/ogg", "oga": "audio/ogg", "mp3": "audio/mpeg",
        "wav": "audio/wav", "webm": "audio/webm",
        "mp4": "video/mp4",
    }
    return mime_map.get(ext, "application/octet-stream")
