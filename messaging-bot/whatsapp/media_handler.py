"""
WhatsApp Media Handler — Downloads media from Meta Cloud API servers,
encodes to base64 for CRISP backend consumption.
"""
import os
import base64
import logging
import httpx

logger = logging.getLogger(__name__)

GRAPH_API = "https://graph.facebook.com/v19.0"
TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
MAX_RETRIES = 3


async def download_media(media_id: str) -> dict:
    """
    Download media from WhatsApp servers.

    1. GET media URL from Graph API
    2. Download binary content from the URL
    3. Return {data_b64, mime_type, size_bytes}

    Returns empty dict on failure.
    """
    headers = {"Authorization": f"Bearer {TOKEN}"}

    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                # Step 1: Get the download URL
                r = await c.get(f"{GRAPH_API}/{media_id}", headers=headers)
                if r.status_code != 200:
                    logger.warning(f"Media URL fetch failed ({r.status_code}): {r.text}")
                    continue

                media_info = r.json()
                download_url = media_info.get("url")
                mime_type = media_info.get("mime_type", "application/octet-stream")

                if not download_url:
                    logger.warning(f"No download URL in media response: {media_info}")
                    continue

                # Step 2: Download the actual binary content
                r2 = await c.get(download_url, headers=headers)
                if r2.status_code != 200:
                    logger.warning(f"Media download failed ({r2.status_code})")
                    continue

                content = r2.content
                b64 = base64.b64encode(content).decode()
                data_url = f"data:{mime_type};base64,{b64}"

                logger.info(f"Media downloaded: {media_id} ({len(content):,} bytes, {mime_type})")
                return {
                    "data_url": data_url,
                    "data_b64": b64,
                    "mime_type": mime_type,
                    "size_bytes": len(content),
                }

        except Exception as e:
            logger.warning(f"Media download attempt {attempt+1}/{MAX_RETRIES} failed: {e}")

    logger.error(f"Media download failed after {MAX_RETRIES} retries: {media_id}")
    return {}


def get_media_type(mime_type: str) -> str:
    """Map MIME type to CRISP media type (IMAGE or AUDIO)."""
    if mime_type.startswith("image/"):
        return "IMAGE"
    if mime_type.startswith("audio/"):
        return "AUDIO"
    if mime_type.startswith("video/"):
        return "IMAGE"  # treat video as image for now
    return "IMAGE"


def get_data_url(data_b64: str, mime_type: str) -> str:
    """Build a data: URL from base64 content."""
    return f"data:{mime_type};base64,{data_b64}"
