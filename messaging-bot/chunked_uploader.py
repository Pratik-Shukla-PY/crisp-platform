"""
Adaptive Chunked Media Uploader — Server-side (Telegram/WhatsApp/IVR).

Server-to-server uploads (localhost) use large chunks + high concurrency.
Adapts dynamically if backend becomes slow (e.g., under load).

Chunk sizes:
  Normal (localhost):  64KB chunks, 5 concurrent
  Slow (high latency): 8KB chunks, 2 concurrent
  Degraded:            1KB chunks, sequential
"""
import os
import time
import logging
import asyncio
from uuid import uuid4

import httpx

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")

# Start with fast settings (server-to-server = localhost)
_chunk_size = 524288  # 512KB (req: 512KB–1MB for FAST)
_concurrency = 5
_consecutive_successes = 0
_consecutive_failures = 0


def _djb2_checksum(data: str) -> str:
    """DJB2 hash — must match backend exactly."""
    h = 5381
    for ch in data:
        h = ((h << 5) + h) ^ ord(ch)
        h &= 0xFFFFFFFF
    return format(h, '08x')


def _adapt_on_success():
    """Gradually increase chunk size after consecutive successes."""
    global _chunk_size, _concurrency, _consecutive_successes, _consecutive_failures
    _consecutive_successes += 1
    _consecutive_failures = 0
    if _consecutive_successes >= 10 and _chunk_size < 524288:
        _chunk_size = min(_chunk_size * 2, 524288)
        _concurrency = min(_concurrency + 1, 5)
        _consecutive_successes = 0
        logger.info(f"Adaptive: upgraded to {_chunk_size}B chunks, {_concurrency} concurrent")


def _adapt_on_failure():
    """Immediately reduce chunk size on failure."""
    global _chunk_size, _concurrency, _consecutive_successes, _consecutive_failures
    _consecutive_failures += 1
    _consecutive_successes = 0
    if _chunk_size > 1024:
        _chunk_size = max(_chunk_size // 2, 1024)
        _concurrency = max(_concurrency - 1, 1)
        logger.info(f"Adaptive: downgraded to {_chunk_size}B chunks, {_concurrency} concurrent")


async def upload_media_chunked(
    report_id: str,
    data_b64: str,
    media_type: str,
    mime_type: str = "image/jpeg",
) -> bool:
    """Upload media with adaptive chunk sizing and concurrent batching."""
    media_id = str(uuid4())
    total_len = len(data_b64)

    if total_len == 0:
        return False

    logger.info(f"Upload: {media_type} {total_len:,} chars, chunk={_chunk_size}B, concurrency={_concurrency}")

    async with httpx.AsyncClient(timeout=30) as c:
        # Thumbnail for instant preview
        if media_type == "IMAGE":
            thumb_size = min(total_len, 20000)
            thumb_b64 = data_b64[:thumb_size]
            pad = (4 - len(thumb_b64) % 4) % 4
            thumb_url = f"data:{mime_type};base64,{thumb_b64 + '=' * pad}"
            try:
                await c.post(f"{BACKEND_URL}/api/v1/reports/{report_id}/media/thumbnail",
                             json={"media_id": media_id, "thumbnail_data": thumb_url})
            except Exception:
                pass

        # Adaptive chunked upload
        offset = 0
        total_chunks = (total_len + _chunk_size - 1) // _chunk_size
        success_count = 0
        start_time = time.time()

        while offset < total_len:
            # Build batch of chunks
            batch = []
            for _ in range(_concurrency):
                if offset >= total_len:
                    break
                end = min(offset + _chunk_size, total_len)
                chunk_data = data_b64[offset:end]
                seq = len(batch) + (success_count)
                batch.append((seq, chunk_data, offset))
                offset += _chunk_size

            # Send batch concurrently
            tasks = [
                _send_chunk_with_retry(c, report_id, media_id, media_type,
                                       seq, total_chunks, chunk_data)
                for seq, chunk_data, _ in batch
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for r in results:
                if r is True:
                    success_count += 1
                    _adapt_on_success()
                else:
                    _adapt_on_failure()

        elapsed = time.time() - start_time
        speed = total_len / 1024 / max(elapsed, 0.01)
        logger.info(f"Upload done: {success_count} chunks, {elapsed:.1f}s, {speed:.0f} KB/s")
        return success_count > 0


async def _send_chunk_with_retry(client, report_id, media_id, media_type, seq, total, data):
    """Send a single chunk with exponential backoff retry."""
    checksum = _djb2_checksum(data)
    payload = {
        "media_id": media_id, "type": media_type,
        "seq_num": seq, "total_chunks": total,
        "data": data, "checksum": checksum,
    }
    delays = [2, 5, 10, 30]  # Exponential backoff (req: 2→5→10→30s)
    for attempt in range(len(delays) + 1):
        try:
            r = await client.post(
                f"{BACKEND_URL}/api/v1/reports/{report_id}/media/chunk",
                json=payload,
            )
            if r.status_code == 200:
                return True
        except Exception:
            pass
        if attempt < len(delays):
            await asyncio.sleep(delays[attempt])
    return False


def extract_b64_from_data_url(data_url: str) -> tuple:
    """Extract raw base64 and MIME type from a data: URL."""
    if data_url.startswith("data:"):
        header, b64 = data_url.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        return b64, mime
    return data_url, "application/octet-stream"
