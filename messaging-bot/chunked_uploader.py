"""
Adaptive Chunked Media Uploader — Server-side (Telegram/WhatsApp/IVR).

Server-to-server uploads (localhost) use large chunks + high concurrency.
Adapts dynamically if backend becomes slow (e.g., under load).

Chunk sizes:
  Normal (localhost):  64KB chunks, 5 concurrent
  Slow (high latency): 8KB chunks, 2 concurrent
  Degraded:            1KB chunks, sequential

Transport (May 2026)
====================
Primary path: multipart/form-data raw bytes to
``POST /api/v1/reports/{id}/media/chunk-bin``. Matches the modern PWA
binary transport — saves the ~33% base64 bandwidth overhead and the
JSON encode/decode round-trip per chunk. Server-to-server is already
fast, so the saving translates directly to lower assembly latency on
the dashboard side.

Fallback path: JSON+base64 to ``POST .../media/chunk`` if the binary
endpoint isn't on this backend yet (a 404 response). Process-scoped
sticky flag — once we fall back, we stay on base64 for the rest of
this bot process. Restart picks up the binary path again.

Caller contract is unchanged: pass a base64 string in, get a bool
back. The Telegram/WhatsApp/IVR adapters all hand us base64 today
(extracted from data URLs via ``extract_b64_from_data_url``), so we
decode once at the top of ``upload_media_chunked`` and chunk raw
bytes downstream.
"""
import base64
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

# Process-scoped sticky fallback flag. Once the binary endpoint returns
# 404 (backend too old / temporarily routed elsewhere), every subsequent
# upload in THIS bot process uses the legacy base64 path. Resets on
# restart. Mirrors the PWA's `_binaryChunkFallback404`.
_binary_chunk_unavailable = False


def _djb2_checksum(data: str) -> str:
    """DJB2 hash over a text/base64 string — kept for the legacy
    base64 fallback path and any external callers. The polynomial
    is identical to `_djb2_bytes`; only the input alphabet differs."""
    h = 5381
    for ch in data:
        h = ((h << 5) + h) ^ ord(ch)
        h &= 0xFFFFFFFF
    return format(h, '08x')


def _djb2_bytes(data: bytes) -> str:
    """DJB2 hash over raw bytes — mirrors backend ``djb2_bytes``.

    For pure-ASCII input ``_djb2_bytes(b"x") == _djb2_checksum("x")``
    because ``ord(char) == byte``. The byte variant exists because the
    new ``/media/chunk-bin`` endpoint reads raw bytes (not base64
    text), so the checksum must match what the server computes after
    reading the multipart file part."""
    h = 5381
    for b in data:
        h = ((h << 5) + h) ^ b
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
    """Upload media with adaptive chunk sizing and concurrent batching.

    Caller still passes base64 (Telegram / WhatsApp / IVR adapters all
    give us base64 today). Internally we decode once to raw bytes and
    chunk on byte boundaries for the binary transport — saves the
    ~33 % base64 bloat over the wire. Old base64 transport stays as
    a process-scoped fallback if the binary endpoint 404s.
    """
    media_id = str(uuid4())

    # Decode base64 once. Pad if needed — Telegram/WhatsApp sometimes
    # strip padding on data URLs. Same padding behaviour as the legacy
    # backend assembler used to apply per-chunk.
    try:
        padded = data_b64 + '=' * ((4 - len(data_b64) % 4) % 4)
        raw_bytes = base64.b64decode(padded)
    except Exception as e:
        logger.error(f"Upload: base64 decode failed: {e}")
        return False

    total_len = len(raw_bytes)
    if total_len == 0:
        return False

    # Phase C.1 — compute whole-asset djb2 once over the raw payload.
    # Sent on chunk 0 only; the backend stores it on the Media row and
    # re-verifies post-assembly. Gives the messaging-bot path the same
    # integrity guarantee the modern PWA has.
    full_asset_checksum = _djb2_bytes(raw_bytes)

    logger.info(
        f"Upload[bin]: {media_type} {total_len:,} bytes, "
        f"chunk={_chunk_size}B, concurrency={_concurrency}, "
        f"fullChecksum={full_asset_checksum}"
    )

    async with httpx.AsyncClient(timeout=30) as c:
        # Thumbnail for instant preview. Stays on the JSON+base64
        # ``/media/thumbnail`` endpoint — payload is capped at ~20 KB so
        # the b64 overhead is negligible, and the endpoint expects a
        # data URL string anyway.
        if media_type == "IMAGE":
            thumb_size = min(total_len, 15000)  # ≈ 20 KB after b64 expansion
            try:
                thumb_b64 = base64.b64encode(raw_bytes[:thumb_size]).decode("ascii")
                thumb_url = f"data:{mime_type};base64,{thumb_b64}"
                await c.post(
                    f"{BACKEND_URL}/api/v1/reports/{report_id}/media/thumbnail",
                    # Tier matches the SMALL the chunk POSTs send below — the
                    # backend used to hard-code MEDIUM on this row regardless,
                    # which left every messaging-bot photo mis-tagged.
                    # Phase L (May 2026) — canonical SMALL (was LOW pre-rename).
                    json={
                        "media_id": media_id,
                        "thumbnail_data": thumb_url,
                        "resolution_tier": "SMALL",
                    },
                )
            except Exception:
                pass

        # Adaptive chunked upload — binary transport.
        offset = 0
        total_chunks = (total_len + _chunk_size - 1) // _chunk_size
        success_count = 0
        start_time = time.time()

        while offset < total_len:
            # Build batch of chunks.
            batch = []
            for _ in range(_concurrency):
                if offset >= total_len:
                    break
                end = min(offset + _chunk_size, total_len)
                chunk_bytes = raw_bytes[offset:end]
                seq = len(batch) + success_count
                batch.append((seq, chunk_bytes, offset))
                offset += _chunk_size

            # Send batch concurrently. Chunk 0 carries the whole-asset
            # checksum; later chunks pass None and the backend silently
            # ignores the field.
            tasks = [
                _send_chunk_with_retry(
                    c, report_id, media_id, media_type, seq,
                    total_chunks, chunk_bytes,
                    full_asset_checksum=(full_asset_checksum if seq == 0 else None),
                )
                for seq, chunk_bytes, _ in batch
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
        transport = "b64-fallback" if _binary_chunk_unavailable else "bin"
        logger.info(
            f"Upload[{transport}] done: {success_count} chunks, "
            f"{elapsed:.1f}s, {speed:.0f} KB/s"
        )
        return success_count > 0


async def _send_chunk_with_retry(client, report_id, media_id, media_type,
                                  seq, total, chunk_bytes,
                                  full_asset_checksum=None):
    """Send a single chunk with exponential backoff retry.

    Primary path: ``POST /media/chunk-bin`` with raw bytes as a
    multipart file part. Fallback: ``POST /media/chunk`` with the
    same chunk re-encoded as base64 in a JSON body. The fallback
    fires the FIRST time the binary endpoint 404s for this process,
    after which every subsequent call uses base64 until restart.
    """
    global _binary_chunk_unavailable

    if _binary_chunk_unavailable:
        return await _send_chunk_b64_fallback(
            client, report_id, media_id, media_type, seq, total, chunk_bytes,
        )

    checksum = _djb2_bytes(chunk_bytes)
    # BUGFIX May 2026 — Telegram-channel Originals never reached the
    # dashboard (operator-reported).
    #
    # Single-tier transport: messaging-channel media isn't run through
    # the PWA's SMALL/MEDIUM/ORIGINAL variant ladder. The previous default
    # (`LOW` / now `SMALL` for every chunk) made the bot's full-resolution
    # photo land on the backend as a SMALL row, and the dashboard's
    # "Open original" / Originals UI strictly filters on
    # `resolution_tier === 'ORIGINAL'`. Net effect: every Telegram photo
    # was permanently hidden from the Originals tab.
    #
    # Telegram serves photos in 4-5 progressively larger renditions
    # (max 1280×1280 for legacy Bot API). The bot already picks
    # `photos[-1]` — the largest the channel can deliver — so those
    # bytes ARE the "Original" for that report from Telegram's
    # perspective. Tag the chunks as ORIGINAL for IMAGE uploads so the
    # dashboard surfaces them as the Original. AUDIO stays SMALL
    # because the resolution_tier semantics there are still
    # minimum-tier on the dashboard side.
    #
    # Phase L (May 2026) — tier vocabulary is SMALL/MEDIUM/ORIGINAL.
    # Pre-L this code used LOW/HIGH; the rename keeps the same
    # operator-visible behaviour with the cleaner canonical names.
    #
    # The backend's existing tier-upgrade logic at
    # `attach_media_chunk` already allows a chunk to *upgrade* an
    # existing SMALL/MEDIUM row to ORIGINAL — so even if the
    # thumbnail (SMALL) lands first via /media/thumbnail, the chunks'
    # ORIGINAL tag wins and the Media row ends up at ORIGINAL for IMAGE.
    tier = "ORIGINAL" if media_type == "IMAGE" else "SMALL"
    form = {
        "media_id": media_id,
        "seq_num": str(seq),
        "total_chunks": str(total),
        "type": media_type,
        "resolution_tier": tier,
        "client_blur_applied": "false",  # server runs its PII pass on assembly
        "checksum": checksum,
    }
    if full_asset_checksum:
        form["full_asset_checksum"] = full_asset_checksum
    files = {"data": ("chunk.bin", chunk_bytes, "application/octet-stream")}

    delays = [2, 5, 10, 30]
    for attempt in range(len(delays) + 1):
        try:
            r = await client.post(
                f"{BACKEND_URL}/api/v1/reports/{report_id}/media/chunk-bin",
                data=form,
                files=files,
            )
            if r.status_code == 200:
                return True
            # Endpoint missing — backend predates April 2026 binary
            # transport. Flip the sticky flag + retry via base64. We
            # also reattempt THIS chunk via the fallback so the upload
            # doesn't lose a chunk to the version-skew window.
            if r.status_code == 404:
                logger.warning(
                    "/media/chunk-bin returned 404 — backend predates "
                    "binary transport; falling back to base64 for the "
                    "rest of this process."
                )
                _binary_chunk_unavailable = True
                return await _send_chunk_b64_fallback(
                    client, report_id, media_id, media_type,
                    seq, total, chunk_bytes,
                )
        except Exception as e:
            logger.debug(f"chunk seq={seq} attempt {attempt+1} failed: {e}")
        if attempt < len(delays):
            await asyncio.sleep(delays[attempt])
    return False


async def _send_chunk_b64_fallback(client, report_id, media_id, media_type,
                                    seq, total, chunk_bytes):
    """Legacy JSON+base64 chunk POST. Used only when ``/media/chunk-bin``
    is unavailable on this backend (process-sticky fallback)."""
    data_b64 = base64.b64encode(chunk_bytes).decode("ascii")
    checksum = _djb2_checksum(data_b64)
    # Match the ORIGINAL-tier-for-IMAGE behaviour of the primary binary
    # path. Otherwise a backend that 404s on /media/chunk-bin would
    # still mis-tag every Telegram photo as SMALL and hide it from the
    # Originals tab. (See the long comment in the bin path above.)
    # Phase L — canonical SMALL/ORIGINAL (was LOW/HIGH pre-rename).
    tier = "ORIGINAL" if media_type == "IMAGE" else "SMALL"
    payload = {
        "media_id": media_id, "type": media_type,
        "seq_num": seq, "total_chunks": total,
        "data": data_b64, "checksum": checksum,
        "resolution_tier": tier,
    }
    delays = [2, 5, 10, 30]
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
