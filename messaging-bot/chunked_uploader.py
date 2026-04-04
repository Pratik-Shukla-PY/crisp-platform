"""
Chunked Media Uploader — Shared by WhatsApp and Telegram bots.
Splits media into ~1KB base64 chunks and uploads progressively via
the same /media/chunk endpoint used by the mobile app, enabling
real-time streaming preview on the web dashboard.

Flow:
  1. POST /reports/{id}/media/thumbnail — send low-res preview first
  2. POST /reports/{id}/media/chunk — send ~1KB packets with seq_num
  3. Backend assembles partial files every 3 (image) / 5 (audio) chunks
  4. Dashboard shows progressive loading in real-time
"""
import os
import base64
import hashlib
import logging
import asyncio
from uuid import uuid4
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")
CHUNK_SIZE = 1024  # ~1KB base64 chars per chunk (matches mobile app)


def _djb2_checksum(data: str) -> str:
    """DJB2 hash for chunk integrity — must match backend djb2_checksum() exactly."""
    h = 5381
    for ch in data:
        h = ((h << 5) + h) ^ ord(ch)
        h &= 0xFFFFFFFF
    return format(h, '08x')


async def upload_media_chunked(
    report_id: str,
    data_b64: str,
    media_type: str,  # "IMAGE" or "AUDIO"
    mime_type: str = "image/jpeg",
) -> bool:
    """
    Upload media in progressive chunks, exactly like the mobile app.

    Args:
        report_id: CRISP report ID
        data_b64: Raw base64 string (no data: prefix)
        media_type: "IMAGE" or "AUDIO"
        mime_type: MIME type for thumbnail

    Returns:
        True if all chunks uploaded successfully
    """
    media_id = str(uuid4())
    total_len = len(data_b64)
    total_chunks = (total_len + CHUNK_SIZE - 1) // CHUNK_SIZE

    if total_chunks == 0:
        logger.warning(f"Empty media data for {report_id}")
        return False

    logger.info(
        f"Chunked upload: {media_type} for {report_id} — "
        f"{total_len:,} base64 chars → {total_chunks} chunks"
    )

    async with httpx.AsyncClient(timeout=20) as c:
        # Step 1: Send thumbnail first (for immediate dashboard preview)
        if media_type == "IMAGE":
            # Use first ~16KB of base64 as low-res thumbnail
            thumb_size = min(total_len, 20000)
            thumb_b64 = data_b64[:thumb_size]
            # Pad to valid base64
            pad = (4 - len(thumb_b64) % 4) % 4
            thumb_b64_padded = thumb_b64 + "=" * pad
            thumb_data_url = f"data:{mime_type};base64,{thumb_b64_padded}"

            try:
                r = await c.post(
                    f"{BACKEND_URL}/api/v1/reports/{report_id}/media/thumbnail",
                    json={"media_id": media_id, "thumbnail_data": thumb_data_url},
                )
                if r.status_code == 200:
                    logger.info(f"Thumbnail sent for {media_id}")
            except Exception as e:
                logger.warning(f"Thumbnail upload failed: {e}")

        # Step 2: Send chunks progressively
        success_count = 0
        for seq in range(total_chunks):
            start = seq * CHUNK_SIZE
            end = min(start + CHUNK_SIZE, total_len)
            chunk_data = data_b64[start:end]
            checksum = _djb2_checksum(chunk_data)

            payload = {
                "media_id": media_id,
                "type": media_type,
                "seq_num": seq,
                "total_chunks": total_chunks,
                "data": chunk_data,
                "checksum": checksum,
            }

            for attempt in range(3):  # retry up to 3 times
                try:
                    r = await c.post(
                        f"{BACKEND_URL}/api/v1/reports/{report_id}/media/chunk",
                        json=payload,
                    )
                    if r.status_code == 200:
                        success_count += 1
                        break
                    else:
                        logger.warning(f"Chunk {seq}/{total_chunks} failed ({r.status_code})")
                except Exception as e:
                    logger.warning(f"Chunk {seq} attempt {attempt+1} error: {e}")
                    await asyncio.sleep(0.5)

            # Small delay between chunks to simulate progressive streaming
            # and avoid overwhelming the server
            if seq % 5 == 0 and seq > 0:
                await asyncio.sleep(0.1)

        logger.info(
            f"Chunked upload complete: {media_type} {media_id} — "
            f"{success_count}/{total_chunks} chunks succeeded"
        )
        return success_count == total_chunks


def extract_b64_from_data_url(data_url: str) -> tuple:
    """
    Extract raw base64 and MIME type from a data: URL.
    Returns (base64_string, mime_type)
    """
    if data_url.startswith("data:"):
        # data:image/jpeg;base64,/9j/4AAQ...
        header, b64 = data_url.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        return b64, mime
    return data_url, "application/octet-stream"
