import base64
import json
import os
import tempfile
import time
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
import httpx
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import or_, and_, func as sa_func, text

from app.core.config import settings
from app.db.session import get_db
from app.models.report import (
    Device, Report, Location, Media, MediaChunk, AIAnalysis,
    SatelliteVerification, DeletionAuditLog, ReportDuplicateDecision,
    Incident, IncidentStatusEnum,
    MediaTypeEnum, ResolutionEnum, ReportStatusEnum, SyncStatusEnum,
    SeverityEnum, InfraTypeEnum,
)
from app.schemas.report import (
    ReportCreate, ReportResponse, ReportMetaCreate, MediaAttach,
    ReportDescriptionUpdate, ThumbnailPayload, MediaChunkPayload,
    VerificationResponse,
    ReportNearbyResponse, ReportNearbyGroup,
    _utc_iso,
)
from app.services.nearby_aggregator import (
    aggregate_nearby, aggregate_disaster_zones, is_disaster_density,
    bbox_for_radius, haversine_km,
    RESOLVED_RECENT_RETENTION_HOURS,
    NearbyReportInput,
)
from app.services.nearby_lifecycle import detect_and_persist as _nearby_detect_and_persist
from app.services.fraud_detector import device_trust_weight as _device_trust_weight
from app.services.ai_service import ai_service
from app.services.satellite_fetcher import satellite_fetcher
from app.services.truth_scorer import truth_scorer
from app.core.deps import get_optional_user, require_viewer, require_analyst, require_admin, require_super_admin
from app.core.observability import (
    variant_uploads_total,
    time_to_first_image_seconds,
    time_to_full_image_seconds,
    chunk_transport_total,
    media_asset_integrity_fail_total,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# env-configurable upload dir. Prod defaults to `backend/uploads/`;
# pytest's conftest overrides via CRISP_UPLOAD_DIR so test-generated media
# lands in a separate dir (`backend/uploads_test/`) that's safe to wipe on
# session teardown. Production uploads are therefore NEVER touched by pytest.
_UPLOAD_DEFAULT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
)
UPLOAD_DIR = os.environ.get("CRISP_UPLOAD_DIR", _UPLOAD_DEFAULT)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# UNDP scaling. Media reads/writes route through the
# pluggable storage backend (LocalStorage by default; S3Storage when
# MEDIA_BACKEND=s3). UPLOAD_DIR remains the local-disk path so legacy
# rows keep working - the abstraction handles the actual file IO so
# call-sites don't have to know which backend is active.
from app.services.storage import get_storage as _get_media_storage  # noqa: E402


def _resolve_user_location_name(loc_data: dict) -> None:
    """HC55 (May 2026) - forward-geocode an offline-typed place name
    through the proper cascade (Mapbox → rate-limited Nominatim) and
    mutate ``loc_data`` with the resolved coordinates.

    Replaces two inline ``GET nominatim.openstreetmap.org/search`` calls
    that were hitting the upstream without rate-limit or Mapbox primary,
    in violation of Nominatim's usage policy. Both callers were
    synchronous routes, so we bridge to the async ``geocode_text``
    helper via ``asyncio.run`` (FastAPI runs sync routes in a thread
    pool, so this is safe - no event loop is already running here).

    Best-effort: failures are logged and swallowed so the report row
    still saves with the user-typed name and (0, 0) coords.
    """
    user_name = loc_data.get("user_location_name")
    if not user_name:
        return
    try:
        import asyncio as _asyncio
        import sys as _sys
        _sys.path.insert(
            0,
            os.path.join(os.path.dirname(__file__), "..", "..", ".."),
        )
        from messaging_bot.sms.geocoder import geocode_text  # noqa: E402
        result = _asyncio.run(
            geocode_text(user_name, country_hint="India", language="en")
        )
        if result and result.get("latitude") is not None:
            loc_data["latitude"] = float(result["latitude"])
            loc_data["longitude"] = float(result["longitude"])
            loc_data["is_user_corrected"] = True
            logger.info(
                "Geocoded '%s' -> %.4f, %.4f (src=%s)",
                user_name, loc_data["latitude"], loc_data["longitude"],
                result.get("source", "unknown"),
            )
    except Exception as exc:
        logger.warning(
            "Server-side geocoding failed for '%s': %s", user_name, exc
        )


def _normalize_crisis_type(value):
    """Normalise crisis-type wire values to UNDP-canonical enums.

    UNDP Problem Statement (page 8) lists 'Hurricane/Cyclone' as a single
    natural-hazard category. The codebase historically accepted both
    `HURRICANE` (legacy clients) and `CYCLONE` (UNDP-aligned), which let
    the same physical event populate two different enum buckets in the
    DB and confused dashboard filtering / counts. We pick `CYCLONE` as
    the canonical name (matches the UNDP-aligned grouping in the backend
    enum file) and rewrite `HURRICANE` to `CYCLONE` at every write site.

    Idempotent - passing through `CYCLONE`, `EARTHQUAKE`, etc. returns
    them unchanged. `None` / empty string / unknown values are returned
    unchanged too (validation happens at the Pydantic / SQLAlchemy enum
    layer, not here).
    """
    if value is None:
        return None
    s = value.value if hasattr(value, "value") else str(value)
    if s == "HURRICANE":
        return "CYCLONE"
    return value


def _content_type_for(filename: str) -> str:
    """Best-effort content-type from filename suffix. Used for S3 PUT
    so the dashboard's <img> / <audio> tags get the right MIME."""
    f = (filename or "").lower()
    if f.endswith(".jpg") or f.endswith(".jpeg"): return "image/jpeg"
    if f.endswith(".png"):                         return "image/png"
    if f.endswith(".webp"):                        return "image/webp"
    if f.endswith(".m4a"):                         return "audio/mp4"
    if f.endswith(".mp4"):                         return "video/mp4"
    if f.endswith(".webm"):                        return "audio/webm"
    if f.endswith(".ogg"):                         return "audio/ogg"
    if f.endswith(".wav"):                         return "audio/wav"
    if f.endswith(".mp3"):                         return "audio/mpeg"
    return "application/octet-stream"


# fix for "Uncaught NotSupportedError: Failed to load
# because no supported source was found" on dashboard audio playback.
#
# Root cause: the legacy single-shot base64 attach path (attach_media
# + create_full_report) used `ext = "jpg" if "image" in header else
# "webm"` - every audio data: URL got renamed to `.webm` regardless of
# what the client actually recorded. iOS Safari records as MP4/AAC
# (the data: URL header is `data:audio/mp4;base64,...`); after
# rewrite the file landed as `<id>.webm` with Content-Type=audio/webm,
# and the browser fed MP4 bytes into a WebM decoder → fail.
#
# This helper trusts the magic bytes first (cannot lie) and falls
# back to the data: URL MIME header if the bytes are unrecognisable.
# Mirrors the magic-byte sniffer in _assemble_partial_audio +
# _assemble_media_file so all three paths agree on what a file is.
def _detect_audio_format(data_url_header: str, raw_bytes: bytes) -> tuple[str, str]:
    """Resolve (extension, content_type) for an audio data: URL.

    `data_url_header` is the prefix part of `data:audio/mp4;base64,...`
    up to the comma. `raw_bytes` is the decoded payload - magic bytes
    win because the data: URL header sometimes lies (e.g. when a PWA
    uses MediaRecorder.mimeType="audio/webm" but the underlying iOS
    decoder hands back MP4 anyway).

    Returns ("m4a", "audio/mp4") for unknown/empty input - that's the
    safest default since AAC-in-MP4 is universally supported across
    browsers and (uniquely) plays cleanly on iOS Safari without
    transcoding.
    """
    # Magic-byte detection first. Same checks as _assemble_partial_audio.
    if len(raw_bytes) >= 12 and raw_bytes[4:8] == b'ftyp':
        return ("m4a", "audio/mp4")
    if len(raw_bytes) >= 4 and raw_bytes[0:4] == b'\x1a\x45\xdf\xa3':
        return ("webm", "audio/webm")
    if len(raw_bytes) >= 4 and raw_bytes[0:4] == b'OggS':
        return ("ogg", "audio/ogg")
    if len(raw_bytes) >= 4 and raw_bytes[0:4] == b'RIFF':
        return ("wav", "audio/wav")
    if len(raw_bytes) >= 4 and raw_bytes[0:4] == b'caff':
        # Apple Core Audio - the assembly pipeline transcodes these
        # to WAV, but on the single-shot attach path we leave it; PyAV
        # would've already mucked with it if the chunked path saw it.
        return ("caf", "audio/x-caf")
    if len(raw_bytes) >= 3 and (raw_bytes[:3] == b'ID3' or raw_bytes[0:1] == b'\xff'):
        return ("mp3", "audio/mpeg")

    # Magic-byte sniffing failed → trust the data: URL MIME header.
    h = (data_url_header or "").lower()
    if "audio/mp4" in h or "audio/x-m4a" in h or "audio/aac" in h:
        return ("m4a", "audio/mp4")
    if "audio/webm" in h:
        return ("webm", "audio/webm")
    if "audio/ogg" in h or "audio/opus" in h:
        return ("ogg", "audio/ogg")
    if "audio/wav" in h or "audio/x-wav" in h or "audio/wave" in h:
        return ("wav", "audio/wav")
    if "audio/mpeg" in h or "audio/mp3" in h:
        return ("mp3", "audio/mpeg")

    # Truly unknown - fall back to m4a/aac which is the most-portable
    # audio container. Worst case is a re-decode failure on the
    # dashboard side, but that's strictly no worse than the prior
    # behaviour of always-webm.
    logger.warning(
        f"Unknown audio format (header={data_url_header!r}, "
        f"first_bytes={raw_bytes[:8].hex()}); defaulting to m4a"
    )
    return ("m4a", "audio/mp4")


# UNDP scaling, Phase 2. The inline processing pipeline
# (CAFF→WAV transcode, server-side PII blur, perceptual hash, Whisper
# transcription) is filesystem-based - cv2.imread, PIL.Image.open,
# faster-whisper all expect a path on disk. To keep the persistent
# UPLOAD_DIR empty under MEDIA_BACKEND=s3, we stage the bytes in a
# tempfile under /tmp/ for the lifetime of the worker call, then
# delete it. /tmp is independent of UPLOAD_DIR (the persistent media
# volume) and doesn't accumulate across uploads - even at UNDP scale
# (500k reports/incident) we never exceed `<concurrent_uploads> ×
# <single_image_size>` in /tmp, which is bounded by the assembly +
# AI executor pool sizes (4+2 = 6 workers max).
import tempfile
from contextlib import contextmanager

@contextmanager
def _stage_from_storage(db_url: str, filename: str):
    """Read bytes from the storage backend, write to an ephemeral
    tempfile, yield the path, delete the tempfile on exit.

    Use this whenever a worker needs a filesystem path but we don't
    want a persistent local copy. The tempfile is cleaned up on context
    exit even if the worker raises."""
    suffix = os.path.splitext(filename)[1] or ".bin"
    tf = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    path = tf.name
    try:
        data = _get_media_storage().read(db_url)
        tf.write(data)
        tf.flush()
        tf.close()
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


@contextmanager
def _stage_bytes(filename: str, data: bytes):
    """Same as _stage_from_storage but for callers that already have
    bytes in memory (e.g. assembled chunks pre-storage-save). Avoids
    a redundant write-then-read round-trip through storage."""
    suffix = os.path.splitext(filename)[1] or ".bin"
    tf = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    path = tf.name
    try:
        tf.write(data)
        tf.flush()
        tf.close()
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

# P2.2 - bounded thread pool for background assembly.
#
# Previously every final-chunk arrival called `threading.Thread(...).start()`
# directly. Under 100 concurrent uploads this would spawn 100 OS threads, all
# blocking on the GIL during PII blur (MediaPipe + easyocr on CPU) and
# Whisper transcription. Effective parallelism was ~1, memory use 100× worse.
#
# 4 workers is chosen to match typical cloud instance core counts and because
# the bottleneck is Python's GIL + disk I/O + ffmpeg/Torch workloads that
# release the GIL - so more threads past cores adds overhead without speedup.
# Override via CRISP_ASSEMBLY_WORKERS env var for bigger boxes.
_ASSEMBLY_WORKERS = max(1, int(os.getenv("CRISP_ASSEMBLY_WORKERS", "4")))
_assembly_executor = ThreadPoolExecutor(
    max_workers=_ASSEMBLY_WORKERS,
    thread_name_prefix="assembly",
)

# P2.3 - separate pool for the slow AI tasks (PII blur with MediaPipe +
# easyocr, and Whisper transcription). These can each take 5–30 s on CPU
# and would otherwise back up the assembly pool. Two workers is deliberately
# conservative: Whisper and easyocr both spawn internal thread pools that
# already saturate a few cores, so running too many in parallel just thrashes
# the L3 cache. Increase via CRISP_AI_WORKERS on bigger instances.
_AI_WORKERS = max(1, int(os.getenv("CRISP_AI_WORKERS", "2")))
_ai_executor = ThreadPoolExecutor(
    max_workers=_AI_WORKERS,
    thread_name_prefix="ai",
)
logger_for_pool = logging.getLogger(__name__)
logger_for_pool.info(
    f"Assembly pool: {_ASSEMBLY_WORKERS} workers; AI pool: {_AI_WORKERS} workers"
)


# ── Phase L L.12.6 - server-side ORIGINAL 5 MB cap ────────────────────────
#
# The PWA / RN / Telegram-bot / WhatsApp-bot encoder ladders (L.2.b /
# L.2.b' / L.2.b'') apply the quality + downscale ladder before
# upload, so legitimate clients never exceed 5 MB. This server-side
# guard is the defense-in-depth seatbelt: any channel (3rd-party
# integration, buggy client, future channel that bypasses the
# client ladder) is rejected with 413 at /attach or marked
# `assembly_status='failed', abandon_reason='original_too_large'`
# at chunked-assembly time so the dashboard chip surfaces it.
#
# Operators get K.6.c counter
# `crisp_media_abandon_reason_total{reason="original_too_large"}`
# so a runaway bypass rate is immediately visible.
_ORIGINAL_MAX_BYTES = int(os.getenv("CRISP_ORIGINAL_MAX_BYTES", str(5 * 1024 * 1024)))


# ── Data Integrity ────────────────────────────────────────────────────────────
def djb2_checksum(s: str) -> str:
    """djb2 hash over the char-code sequence of `s`.

    Matches client-side ``simpleChecksum()`` in ``mobile-app/src/app.js``
    (PRD §3.7). Used by the legacy base64 chunk endpoint
    ``/reports/{id}/media/chunk`` where the payload ships as a JSON
    string of base64 characters (ASCII codes 43–122).
    """
    h = 5381
    for c in s:
        h = ((h << 5) + h) ^ ord(c)
        h &= 0xFFFFFFFF
    return format(h, '08x')


def djb2_bytes(b: bytes) -> str:
    """djb2 hash over the byte sequence `b`.

    Used by the April-2026 binary chunk endpoint
    ``/reports/{id}/media/chunk-bin`` where the payload ships as raw
    bytes (multipart/form-data). The polynomial is identical to
    ``djb2_checksum`` - the only difference is the input alphabet
    (full byte range 0–255 vs. base64 ASCII).

    Client parity: mirrored by ``djb2Bytes()`` in
    ``mobile-app/src/app.js`` + ``crisp-mobile/services/syncEngine.ts``.
    Pairwise unit-tested against ``test_chunk_binary.py::test_djb2_parity``.
    """
    h = 5381
    for byte in b:
        h = ((h << 5) + h) ^ byte
        h &= 0xFFFFFFFF
    return format(h, '08x')


def _assemble_media_file(media_id: str, media_type: str, db: Session) -> Optional[str]:
    """Concatenate all received chunks in seq order and write to disk.

    April 2026 - dual-transport assembly. A chunk row stores its payload
    in ONE of two columns:

      * ``data_binary`` (LargeBinary) - new `/media/chunk-bin` endpoint.
      * ``data_b64``    (Text)        - legacy `/media/chunk` endpoint.

    We read each chunk row and take whichever column is populated. The
    CHECK constraint on ``media_chunks`` guarantees exactly one is set.

    Mixed-format chunks for a single ``media_id`` are not produced by
    client logic (one upload session picks one transport), but if they
    ever appear - e.g. retry across an app update - the assembler
    concatenates them transparently since both columns ultimately yield
    bytes.
    """
    chunks = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id
    ).order_by(MediaChunk.seq_num).all()

    if not chunks:
        return None

    # Decode each chunk to bytes in seq order. Binary rows bypass base64
    # entirely. Legacy base64 rows are decoded per-chunk so one corrupted
    # row doesn't poison the entire assembly (we log + skip the bad one,
    # matching the prior behaviour that failed the whole media).
    parts: List[bytes] = []
    for c in chunks:
        if c.data_binary is not None:
            parts.append(bytes(c.data_binary))
            continue
        if c.data_b64:
            # Pad per-chunk to avoid cross-chunk padding ambiguity.
            b64 = c.data_b64
            padding = (4 - len(b64) % 4) % 4
            try:
                parts.append(base64.b64decode(b64 + ('=' * padding)))
            except Exception as e:
                logger.error(
                    f"Base64 decode failed for {media_id} seq={c.seq_num}: {e}"
                )
                return None
            continue
        logger.error(
            f"Chunk {media_id} seq={c.seq_num} has neither data_binary nor "
            f"data_b64 - CHECK constraint violated; aborting assembly."
        )
        return None

    file_bytes = b"".join(parts)

    # Phase L L.12.6 (May 2026) - server-side ORIGINAL 5 MB cap on the
    # chunked-assembly path. Same rationale as the /attach guard: even if
    # a client (or future channel) bypasses the L.2.b encoder ladder, the
    # backend rejects oversized ORIGINAL rows so storage + downstream
    # pipelines (PII blur, dashboard, exports) stay bounded. Stamp the
    # row with `abandon_reason='original_too_large'` so the K.5.a chip
    # surfaces it to operators instead of leaving a silently-failed
    # assembly.
    media_row_for_cap = db.query(Media).filter(Media.id == media_id).first()
    if (media_row_for_cap is not None
            and getattr(getattr(media_row_for_cap, "resolution_tier", None), "value", None) == "ORIGINAL"
            and len(file_bytes) > _ORIGINAL_MAX_BYTES):
        logger.error(
            "[Assembly:size-cap] %s ORIGINAL tier %d bytes exceeds %d cap - "
            "marking row failed (abandon_reason=original_too_large). Client "
            "must apply the Phase L L.2.b compression ladder.",
            media_id, len(file_bytes), _ORIGINAL_MAX_BYTES,
        )
        try:
            from datetime import datetime as _dt, timezone as _tz
            db.query(Media).filter(Media.id == media_id).update(
                {
                    "assembly_status": "failed",
                    "abandon_reason": "original_too_large",
                    "abandoned_at": _dt.now(_tz.utc),
                },
                synchronize_session=False,
            )
            db.commit()
            try:
                from app.core.observability import media_abandon_reason_total
                media_abandon_reason_total.labels(
                    reason="original_too_large",
                ).inc()
            except Exception:
                pass
        except Exception as _e:
            logger.warning(
                "[Assembly:size-cap] %s abandon-stamp failed: %s",
                media_id, _e,
            )
        return None

    # Phase C.1 (May 2026) - whole-asset integrity check. The PWA computes
    # djb2 over the FULL original bytes once before chunking and ships it
    # on chunk 0. We re-compute over the concatenated payload here and
    # compare. NULL on the Media row means the client didn't send one
    # (legacy / pre-Phase-C.1 PWA) - skip the check entirely, preserving
    # back-compat. Mismatch => abort assembly, flag the row failed in the
    # caller (`_try_full_assembly_bg` already handles None-returns), and
    # bump the metric so the failure shows up on the Prometheus dashboard.
    # Done BEFORE writing to storage so a corrupted assembly never lands
    # on disk / S3 even briefly.
    media_row = db.query(Media).filter(Media.id == media_id).first()
    expected_checksum = getattr(media_row, "full_asset_checksum", None) if media_row else None
    if expected_checksum:
        computed_checksum = djb2_bytes(file_bytes)
        if computed_checksum != expected_checksum:
            # Phase L (May 2026) - canonical tier label is SMALL for the
            # "minimum-fidelity" tier. Pre-L wrote 'LOW' here; rows are
            # backfilled by alembic 0035, so falling back to SMALL is
            # consistent with the post-migration vocabulary.
            tier_label = "SMALL"
            try:
                tier_label = getattr(getattr(media_row, "resolution_tier", None), "value", "SMALL") or "SMALL"
            except Exception:
                pass
            logger.error(
                "[Assembly:integrity] %s tier=%s djb2 MISMATCH expected=%s got=%s - "
                "aborting assembly, marking row failed. Most likely cause: "
                "_assemble_media_file sort/decode/concat regression OR a "
                "compromised chunk row that bypassed the per-chunk djb2 check.",
                media_id, tier_label, expected_checksum, computed_checksum,
            )
            try:
                media_asset_integrity_fail_total.labels(tier=tier_label).inc()
            except Exception:
                pass
            # K.2.c (May 2026, Phase K) - propagate the checksum-mismatch
            # signal to the Media row's abandon metadata so the dashboard
            # can render an explicit "Media corrupt" chip (K.5.a) instead
            # of the generic "failed" state. Was previously just
            # `assembly_status='failed'` with `abandon_reason=NULL`,
            # making it indistinguishable from worker-lost or
            # chunks-never-arrived failures.
            try:
                from datetime import datetime as _dt, timezone as _tz
                db.query(Media).filter(Media.id == media_id).update(
                    {
                        "assembly_status": "failed",
                        "abandon_reason": "checksum_mismatch",
                        "abandoned_at": _dt.now(_tz.utc),
                    },
                    synchronize_session=False,
                )
                db.commit()
                # K.6.c - operator-visible abandon-reason SLI.
                try:
                    from app.core.observability import media_abandon_reason_total
                    media_abandon_reason_total.labels(
                        reason="checksum_mismatch",
                    ).inc()
                except Exception:
                    pass
            except Exception as _e:
                logger.warning(f"[Assembly:integrity] abandon-stamp failed for {media_id}: {_e}")
            return None

    # Detect audio format from magic bytes (first few bytes)
    if media_type == 'IMAGE':
        ext = 'jpg'
    else:
        # Audio: sniff format for correct extension
        if len(file_bytes) > 12 and file_bytes[4:8] == b'ftyp':
            ext = 'm4a'       # MPEG-4 Audio (AAC) - iOS, Android
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'OggS':
            ext = 'ogg'       # Ogg container (Opus) - WhatsApp, Telegram
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'\x1a\x45\xdf\xa3':
            ext = 'webm'      # WebM (PWA MediaRecorder)
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'caff':
            # Apple Core Audio Format - older iOS recorder configs produced
            # this silently. Not playable in HTML5 <audio>; we transcode it
            # to .m4a via ffmpeg below so the dashboard player works.
            ext = 'caf'
        elif len(file_bytes) >= 3 and (file_bytes[0:3] == b'ID3' or (file_bytes[0] == 0xFF and (file_bytes[1] & 0xE0) == 0xE0)):
            ext = 'mp3'       # MP3
        elif len(file_bytes) >= 12 and file_bytes[0:4] == b'RIFF' and file_bytes[8:12] == b'WAVE':
            ext = 'wav'       # WAV
        else:
            ext = 'm4a'       # Default to m4a (most compatible for mobile)

    filename = f"{media_id}_assembled.{ext}"

    # (PR 2 - UNDP scaling) - the assembly path no longer
    # writes to UPLOAD_DIR. CAFF→WAV transcode runs on PyAV BytesIO
    # in memory; the assembled bytes go directly to the storage
    # backend (S3 in prod). Workers receive the storage URL +
    # filename and stage their own ephemeral tempfile in /tmp/ when
    # they need a real path on disk (cv2.imread, faster-whisper).
    # Net effect: EC2's persistent disk stays untouched at scale.

    # CAFF → WAV transcode. Apple Core Audio isn't supported by HTML5
    # <audio> or most non-Apple players. Older iOS recorder configs
    # produced CAFF even when the filename said .m4a. PyAV bundles
    # FFmpeg libs and supports BytesIO file-likes for both input and
    # output, so we transcode entirely in memory.
    if ext == 'caf':
        try:
            import io
            import av
            input_buf = io.BytesIO(file_bytes)
            output_buf = io.BytesIO()
            input_c = av.open(input_buf)
            output_c = av.open(output_buf, mode='w', format='wav')
            try:
                in_stream = input_c.streams.audio[0]
                out_stream = output_c.add_stream('pcm_s16le', rate=in_stream.rate)
                out_stream.layout = in_stream.layout
                for frame in input_c.decode(in_stream):
                    frame.pts = None
                    for packet in out_stream.encode(frame):
                        output_c.mux(packet)
                for packet in out_stream.encode():
                    output_c.mux(packet)
            finally:
                output_c.close()
                input_c.close()
            wav_bytes = output_buf.getvalue()
            if wav_bytes:
                file_bytes = wav_bytes
                filename = f"{media_id}_assembled.wav"
                ext = 'wav'
                logger.info(f"Transcoded CAFF → WAV for {media_id} ({len(file_bytes):,} bytes, in-memory)")
            else:
                logger.warning(f"CAFF→WAV transcode produced no output for {media_id}")
        except Exception as e:
            logger.warning(f"CAFF→WAV transcode failed for {media_id}: {e}")

    # Persist to storage backend (LocalStorage → /static/<file>;
    # S3Storage → s3://<file>). Returned `file_url` is what gets
    # stored in media.url; the response serializer resolves it to a
    # signed URL when it leaves the API.
    try:
        file_url = _get_media_storage().save(filename, file_bytes, _content_type_for(filename))
    except Exception as e:
        logger.error(
            f"[Assembly] storage.save failed for {filename} ({len(file_bytes):,} bytes): {e}. "
            "Local backend: likely disk full / permissions. S3: likely IAM / network."
        )
        return None

    # Defense-in-depth PII blur (always runs, regardless of client_blur_applied).
    # Worker gets (media_id, file_url, filename) and uses storage.read()
    # + a /tmp/ tempfile for cv2 - no persistent local disk usage.
    if media_type == 'IMAGE':
        media_row = db.query(Media).filter(Media.id == media_id).first()
        client_claim = bool(getattr(media_row, 'client_blur_applied', False)) if media_row else False
        db.query(Media).filter(Media.id == media_id).update(
            {'pii_blur_status': 'pending'}, synchronize_session=False
        )
        db.commit()
        _ai_executor.submit(_run_server_pii_blur, media_id, file_url, filename)
        logger.info(
            f"Server PII blur queued for {media_id} "
            f"(client_blur_applied={client_claim} - server runs anyway for defense-in-depth)"
        )
        # Perceptual-hash for redundancy detection. Same /tmp/ pattern
        # - worker stages from storage, computes phash, deletes tempfile.
        _ai_executor.submit(_run_photo_phash, media_id, file_url, filename)
    else:
        # K.2.b (May 2026, Phase K) - AUDIO leg of the chunked-assembly
        # path. Audio bypasses PII blur entirely, so 'not_needed' is
        # the correct terminal state. Mirrors the /attach handler's
        # audio default (the row-create branch around line 2862 stamps
        # pii_blur_outcome='not_needed' for audio).
        # Pre-fix this branch left pii_blur_status=NULL, which broke
        # the "non-NULL always" invariant for every audio capture from
        # the PWA - the PWA exclusively uses chunked transport for
        # audio, so 100% of production audio rows were affected.
        db.query(Media).filter(Media.id == media_id).update(
            {'pii_blur_status': 'not_needed'}, synchronize_session=False
        )
        db.commit()
        # K.6.c - bump the persisted-state SLI to match what the /attach
        # path does at row-create time. Counts the PERSISTED column
        # value, not the worker outcome (audio has no worker).
        try:
            from app.core.observability import pii_blur_status_total
            pii_blur_status_total.labels(status='not_needed').inc()
        except Exception:
            pass

    logger.info(f"Assembled {media_id}: {len(file_bytes):,} bytes → {filename}")
    return file_url


def _run_photo_phash(media_id: str, db_url: str, filename: str) -> None:
    """Compute + persist perceptual hash of an assembled photo.

    Fire-and-forget helper invoked from `_assemble_media_file` after the
    PII-blur submission. Opens a short-lived DB session so we don't piggy-
    back on the caller's transaction. Any failure is logged + swallowed -
    `photo_phash` stays NULL and the dashboard treats that as "not yet
    scanned" rather than "unique".

    Apr 2026 (PR 2) - reads bytes through the storage abstraction +
    stages a /tmp/ tempfile for the PIL.Image.open call. No persistent
    local-disk usage.
    """
    from app.services.phash import compute_phash
    from app.db.session import SessionLocal as _SL
    try:
        with _stage_from_storage(db_url, filename) as tmp_path:
            h = compute_phash(tmp_path)
        if not h:
            logger.info(f"[pHash] {media_id}: no hash computed (unavailable or non-image)")
            return
        _db = _SL()
        try:
            _db.query(Media).filter(Media.id == media_id).update(
                {'photo_phash': h}, synchronize_session=False
            )
            _db.commit()
            logger.info(f"[pHash] {media_id}: stored {h}")
        finally:
            _db.close()
    except Exception as e:                          # pragma: no cover
        logger.warning(f"[pHash] {media_id}: failed: {e}")


def _maybe_geotag_stamp(media_id: str, db_url: str, filename: str, tmp_path: str) -> None:
    """HC98 - burn a geotag caption + GPS EXIF into the stored photo, AFTER PII
    blur. Only MEDIUM/ORIGINAL image tiers (SMALL is a thumbnail). Keeps a
    pristine pre-stamp ORIGINAL in the internal archival store. Best-effort -
    the caller wraps this so a failure never changes the blur outcome.

    ALWAYS re-uploads the stamped bytes - including for the `complete_clean`
    path that otherwise skips re-upload (conditional save). cv2 re-encodes at
    q95 so quality holds. Coordinates come from the report's Location (not image
    EXIF), so they're correct regardless of capture orientation.
    """
    from app.core.config import settings
    if not getattr(settings, "CRISP_GEOTAG_WATERMARK_ENABLED", False):
        return
    from app.db.session import SessionLocal
    from app.models.report import Media as _Media, Report as _Report
    from app.services import geotag_stamp

    db = SessionLocal()
    try:
        m = db.query(_Media).filter(_Media.id == media_id).first()
        if not m:
            return
        _t = getattr(m, "type", None)
        if str(getattr(_t, "value", _t) or "").upper() != "IMAGE":
            return
        _tier = getattr(m, "resolution_tier", None)
        tier = str(getattr(_tier, "value", _tier) or "").upper()
        if tier not in geotag_stamp.WATERMARK_TIERS:
            return  # SMALL / LOW thumbnails skipped
        if getattr(m, "watermark_applied", False):
            return  # idempotent - already stamped
        rep = db.query(_Report).filter(_Report.id == m.report_id).first()
        loc = getattr(rep, "location", None) if rep else None
        if not loc or loc.latitude is None or loc.longitude is None:
            return  # no geotag to embed
        building = getattr(rep, "infrastructure_name", None)
        ts = getattr(rep, "client_created_at", None) or getattr(rep, "server_created_at", None)
        time_str = ts.strftime("%H:%M UTC") if ts else None

        # Archive the pristine pre-stamp ORIGINAL (internal-only, recoverable).
        if tier == "ORIGINAL":
            try:
                with open(tmp_path, "rb") as _fh:
                    _get_media_storage().save_internal(
                        f"archival/{media_id}", _fh.read(), _content_type_for(filename))
            except Exception as _ar_e:
                logger.warning(f"[geotag] archival copy failed for {media_id[:8]}: {_ar_e}")

        geotag_stamp.embed_geotag(
            tmp_path,
            lat=loc.latitude, lng=loc.longitude,
            accuracy_m=getattr(loc, "accuracy_meters", None),
            building=building, time_str=time_str,
            write_exif=getattr(settings, "CRISP_GEOTAG_EXIF_ENABLED", True),
        )
        # Re-upload the stamped bytes (always - the clean path skips re-upload).
        with open(tmp_path, "rb") as _fh:
            _get_media_storage().save(filename, _fh.read(), _content_type_for(filename))
        db.query(_Media).filter(_Media.id == media_id).update(
            {"watermark_applied": True}, synchronize_session=False)
        db.commit()
        logger.info("[geotag] stamped %s %s @ %.4f,%.4f", tier, media_id[:8],
                    float(loc.latitude), float(loc.longitude))
    except Exception:
        try: db.rollback()
        except Exception: pass
        raise
    finally:
        try: db.close()
        except Exception: pass


def _run_server_pii_blur(media_id: str, db_url: str, filename: str) -> None:
    """Server-side PII blur (MediaPipe faces + easyocr PII text). Runs in
    the AI thread pool so it doesn't block assembly. Never raises -
    failure is logged and the media row's ``pii_blur_status`` is updated
    accordingly so the dashboard can flag the file.

    May 2026 (Batch B-A) - writes the canonical 4-state taxonomy
    (alembic 0037). Outcome resolution:

      - blur ran + detections found  → 'complete_with_redactions'
                                       (bytes re-uploaded; green chip)
      - blur ran + no detections     → 'complete_clean'
                                       (bytes unchanged; no chip)
      - blur ran + backends missing  → 'failed'
                                       (was 'skipped' pre-0037;
                                       bytes are unblurred; red chip
                                       - operator must investigate)
      - blur raised an exception     → 'failed'
                                       (red chip - operator action)

    Observability:
      * bumps ``pii_blur_runs_total{outcome}`` Prometheus counter
      * bumps ``pii_blur_status_total{status}`` Prometheus counter
      * writes ``pii_blur_status`` on the Media row

    URL gating: while pii_blur_status='pending', the public-facing
    ``GET /media/{id}/file`` route returns 425 Too Early - the
    operator can't accidentally fetch unblurred bytes through any
    cache layer. The 425 lifts as soon as this worker writes the
    terminal status.
    """
    outcome = 'failed'  # Final pii_blur_status value (one of the 4 canonical
                       # values + 'not_needed' for audio, handled elsewhere).
    db = None
    try:
        from app.services.pii_blur import blur_pii, blur_pii_with_hints
        from app.db.session import SessionLocal

        # B-C (May 2026, alembic 0038) - pick up client-supplied face
        # box hints (PWA's BlazeFace pass). If present, the union of
        # client + server boxes is blurred; if absent, server-only
        # MediaPipe behaviour is preserved (back-compat with non-PWA
        # channels + pre-B-C uploads).
        _read_db = SessionLocal()
        client_hints = None
        try:
            _row = _read_db.query(Media).filter(Media.id == media_id).first()
            if _row:
                client_hints = getattr(_row, 'client_face_boxes_normalized', None)
        finally:
            try: _read_db.close()
            except Exception: pass

        # B-F (May 2026, alembic 0039) - pre-blur retention. Before
        # blur runs, snapshot the assembled bytes into the internal
        # `pre_blur/` store. If a higher-tier arrival later detects
        # additional PII, the retroactive upgrade path reads from this
        # snapshot to re-blur lower tiers without losing original
        # detail. Sweep Action ⑤ purges entries after 24 h.
        try:
            _pre_blur_bytes = _get_media_storage().read(db_url)
            _pre_blur_key = f"{media_id}__pre_blur"
            _get_media_storage().save_internal(
                _pre_blur_key, _pre_blur_bytes,
                _content_type_for(filename),
            )
            # Stamp the row so the sweep knows when to purge.
            _retain_db = SessionLocal()
            try:
                _retain_db.query(Media).filter(Media.id == media_id).update(
                    {
                        'pre_blur_internal_key': _pre_blur_key,
                        'pre_blur_retained_until': (
                            datetime.now(timezone.utc) + timedelta(hours=24)
                        ),
                    },
                    synchronize_session=False,
                )
                _retain_db.commit()
            finally:
                try: _retain_db.close()
                except Exception: pass
        except Exception as _pre_e:
            # Non-fatal: retroactive upgrade is a bonus, not the
            # privacy guarantee. Log + continue with the in-place blur.
            logger.warning(
                f"[B-F] pre-blur snapshot failed for {media_id[:8]}: "
                f"{_pre_e}. Retroactive upgrade disabled for this row; "
                f"in-place blur still runs."
            )

        # Stage bytes from storage into a /tmp/ tempfile for the
        # filesystem-based cv2.imread inside blur_pii. The tempfile
        # is auto-deleted when the context exits - EC2's persistent
        # disk stays empty regardless of upload volume.
        with _stage_from_storage(db_url, filename) as tmp_path:
            if client_hints:
                pii_result = blur_pii_with_hints(tmp_path, client_hints)
                logger.info(
                    f"PII blur with hints for {filename}: "
                    f"client_box_count={pii_result.get('client_box_count', 0)}, "
                    f"union_box_count={pii_result.get('union_box_count', 0)}"
                )
            else:
                pii_result = blur_pii(tmp_path)
            if pii_result.get('ran'):
                if pii_result.get('blurred'):
                    outcome = 'complete_with_redactions'
                    logger.info(
                        f"PII blurred in {filename}: "
                        f"faces={pii_result['faces']} pii_text={pii_result['pii_texts']}"
                    )
                    # Re-upload the blurred bytes back to storage. blur_pii
                    # rewrote tmp_path in place; we read the new bytes and
                    # storage.save() to overwrite the original (S3 PUT or
                    # local-disk write - backend agnostic).
                    try:
                        with open(tmp_path, "rb") as _fh:
                            blurred_bytes = _fh.read()
                        _get_media_storage().save(
                            filename, blurred_bytes, _content_type_for(filename)
                        )
                    except Exception as _re_e:
                        logger.warning(
                            f"Re-upload of blurred bytes failed for {filename}: {_re_e}. "
                            "Storage object may still hold unblurred bytes - re-run blur worker to fix."
                        )
                elif pii_result.get('clean'):
                    # B-B (May 2026) - explicit conditional-save path.
                    # Pipeline ran end-to-end, found NO PII. blur_pii
                    # did NOT call cv2.imwrite; the bytes on disk are
                    # byte-identical to the assembled input. We skip
                    # the re-upload entirely - storage still has the
                    # original assembled bytes, full JPEG quality
                    # preserved. Important for the 70-80 % of crisis
                    # photos that legitimately have no PII.
                    outcome = 'complete_clean'
                    logger.info(
                        f"PII blur ran on {filename}: no PII detected - "
                        f"bytes unchanged (B-B conditional save)"
                    )
                else:
                    # ran=True but neither blurred nor clean - defensive
                    # fallback (shouldn't happen given blur_pii contract).
                    outcome = 'complete_clean'
                    logger.warning(
                        f"PII blur ran on {filename} but neither blurred "
                        f"nor clean flag set - defaulting to complete_clean. "
                        f"Result: {pii_result!r}"
                    )

                # HC98 - server-side geotag embed. After blur (so the caption
                # isn't blurred), for completed IMAGE tiers MEDIUM/ORIGINAL,
                # burn lat/long + building + time + GPS EXIF into the stored
                # bytes (always re-uploads; clean path included). Best-effort -
                # never changes the blur outcome above.
                if outcome in ('complete_with_redactions', 'complete_clean'):
                    try:
                        _maybe_geotag_stamp(media_id, db_url, filename, tmp_path)
                    except Exception as _gt_e:
                        logger.warning(f"[geotag] stamp skipped for {media_id[:8]}: {_gt_e}")
            else:
                # Backends unavailable - the storage object still holds
                # the unblurred bytes. Treated as 'failed' under the new
                # taxonomy (was 'skipped' pre-0037 - same operational
                # meaning, unified vocabulary).
                outcome = 'failed'
                logger.error(
                    f"PII-BLUR FAILED (backends unavailable) for {filename}: "
                    f"{pii_result.get('error')} - object kept as-is, dashboard "
                    "will flag via pii_blur_status='failed'."
                )
    except Exception as e:
        outcome = 'failed'
        logger.warning(f"PII blur failed for {filename}: {e}")
    finally:
        # Update the Media row in a fresh session - this runs on the
        # `_ai_executor` worker thread which doesn't carry the request's
        # DB session. Swallow DB errors so one bad commit doesn't wedge
        # the worker.
        try:
            from app.db.session import SessionLocal
            from app.models.report import Media as _Media
            db = SessionLocal()
            db.query(_Media).filter(_Media.id == media_id).update(
                {'pii_blur_status': outcome}, synchronize_session=False
            )
            db.commit()
        except Exception as e:
            logger.warning(f"pii_blur_status update failed for {media_id}: {e}")
        finally:
            if db:
                try: db.close()
                except Exception: pass
        # Prometheus counters. `import inside` + try/except so a missing
        # observability module can't break the blur worker.
        #   pii_blur_runs_total   - counts worker EXECUTIONS by outcome
        #                            (success/fail of this thread).
        #   pii_blur_status_total - counts the row's PERSISTED
        #                            pii_blur_status as actually stored.
        # These usually agree, but diverge when the DB update above
        # raised: the worker ran (runs ticks) yet the row stays NULL
        # (status doesn't). That divergence is the operator signal.
        try:
            from app.core.observability import (
                pii_blur_runs_total,
                pii_blur_status_total,
            )
            pii_blur_runs_total.labels(outcome=outcome).inc()
            pii_blur_status_total.labels(status=outcome).inc()
        except Exception:
            pass
        # OOM hotfix (May 2026): reclaim the per-blur working set (cv2
        # arrays + easyocr/PyTorch inference tensors) so RSS doesn't ratchet
        # up across many blurs. Module-cached models stay resident; this only
        # prompts release of the per-call allocations. Cheap relative to a
        # blur; harmless if it no-ops.
        try:
            import gc as _gc
            _gc.collect()
        except Exception:
            pass


def _assemble_partial_image(media_id: str, db: Session) -> Optional[str]:
    """
    Assemble consecutive chunks received so far into a partial JPEG for real-time preview.
    A truncated JPEG renders whatever scan-lines have been received (top portion visible).
    Called every 10 chunks so dashboard can show progressive image as data arrives.
    """
    chunks = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id
    ).order_by(MediaChunk.seq_num).all()

    if len(chunks) < 3:
        return None

    # Collect only consecutive chunks (stop at first gap - no gaps in
    # partial JPEG). April 2026: dual-transport - each chunk decodes to
    # bytes separately, then we concat. Parity with the full-assembly
    # path so partial-render works regardless of transport mix.
    byte_parts: List[bytes] = []
    expected_seq = 0
    for c in chunks:
        if c.seq_num != expected_seq:
            break
        if c.data_binary is not None:
            byte_parts.append(bytes(c.data_binary))
        elif c.data_b64:
            b64 = c.data_b64
            padding = (4 - len(b64) % 4) % 4
            try:
                byte_parts.append(base64.b64decode(b64 + ('=' * padding)))
            except Exception:
                # Partial-render is best-effort; skip undecodable chunk.
                break
        expected_seq += 1

    if not byte_parts:
        return None

    try:
        file_bytes = b"".join(byte_parts)
    except Exception as e:
        logger.warning(f"Partial assembly decode failed for {media_id}: {e}")
        return None

    # Phase-2.3 safeguards - don't write an unreadable partial.
    #   (a) Validate JPEG Start-Of-Image marker. A truncated JPEG at least
    #       has to start with 0xFFD8 to even attempt to render; without
    #       this the dashboard shows a "broken image" icon which is worse
    #       UX than no placeholder at all.
    #   (b) Minimum byte threshold. At VERY_SLOW tier (1 KB chunks), a
    #       3-chunk prefix is only 3 KB - too small to contain the quant
    #       + Huffman tables for most JPEG encoders, so the file would be
    #       unreadable. 2 KB is the empirical floor below which partial
    #       rendering is useless; above it most decoders will render a
    #       banded preview even with only a few scanlines.
    if len(file_bytes) < 2048:
        logger.debug(
            f"Partial assembly skipped for {media_id}: only {len(file_bytes)} bytes "
            f"(need ≥2048 for a renderable JPEG prefix)"
        )
        return None
    if not (len(file_bytes) >= 2 and file_bytes[0] == 0xFF and file_bytes[1] == 0xD8):
        logger.warning(
            f"Partial assembly skipped for {media_id}: missing JPEG SOI marker "
            f"(first 2 bytes: {file_bytes[:2].hex() if len(file_bytes) >= 2 else 'empty'})"
        )
        return None

    filename = f"{media_id}_partial.jpg"

    # (PR 2) - partial-image PII blur via /tmp/ tempfile so
    # we never write to UPLOAD_DIR. blur_pii is filesystem-based; we
    # stage briefly, blur in place, read back, and storage.save().
    # Tempfile is auto-deleted on context exit.
    final_bytes = file_bytes
    try:
        with _stage_bytes(filename, file_bytes) as tmp_path:
            from app.services.pii_blur import blur_pii
            try:
                blur_pii(tmp_path)
            except Exception:
                pass  # Non-critical for partial images
            with open(tmp_path, "rb") as _fh:
                final_bytes = _fh.read()
    except Exception:
        pass  # Tempfile staging failed; fall back to unblurred bytes

    logger.info(f"Partial image updated: {media_id} ({len(byte_parts)} chunks, {len(file_bytes):,} bytes)")

    try:
        return _get_media_storage().save(filename, final_bytes, "image/jpeg")
    except Exception as e:
        logger.warning(f"[PartialImg] storage.save failed: {e}")
        return None


def _assemble_partial_audio(media_id: str, db: Session) -> Optional[str]:
    """
    Assemble consecutive chunks received so far into a partial WebM for streaming preview.
    WebM/Opus files are playable when truncated as long as the EBML header + track info
    (first ~400-800 bytes) is intact.  Called every 5 chunks so the dashboard can offer
    a "play what we have so far" button while the upload is still in progress.
    """
    chunks = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id
    ).order_by(MediaChunk.seq_num).all()

    if len(chunks) < 5:
        return None

    # Collect only consecutive chunks (stop at first gap).
    # April 2026 dual-transport: decode each chunk to bytes separately
    # (binary rows pass through, legacy base64 rows decode per-row).
    byte_parts: List[bytes] = []
    expected_seq = 0
    for c in chunks:
        if c.seq_num != expected_seq:
            break
        if c.data_binary is not None:
            byte_parts.append(bytes(c.data_binary))
        elif c.data_b64:
            b64 = c.data_b64
            padding = (4 - len(b64) % 4) % 4
            try:
                byte_parts.append(base64.b64decode(b64 + ('=' * padding)))
            except Exception:
                break   # skip undecodable tail; best-effort partial render
        expected_seq += 1

    if not byte_parts:
        return None

    file_bytes = b"".join(byte_parts)

    # Detect audio format from magic bytes
    if len(file_bytes) > 12 and file_bytes[4:8] == b'ftyp':
        ext = 'm4a'
    elif len(file_bytes) >= 4 and file_bytes[0:4] == b'OggS':
        ext = 'ogg'
    elif len(file_bytes) >= 4 and file_bytes[0:4] == b'\x1a\x45\xdf\xa3':
        ext = 'webm'
    else:
        ext = 'm4a'

    filename = f"{media_id}_partial.{ext}"

    # (PR 2) - direct in-memory persist via storage abstraction.
    # The partial-transcription worker (Whisper, _run_partial_transcription_bg)
    # reads via storage.read() + a /tmp/ tempfile when it runs, so we
    # don't need to keep a local working copy here.
    logger.info(f"Partial audio updated: {media_id} ({len(byte_parts)} chunks, {len(file_bytes):,} bytes)")

    try:
        return _get_media_storage().save(filename, file_bytes, _content_type_for(filename))
    except Exception as e:
        logger.warning(f"[PartialAudio] storage.save failed: {e}")
        return None


def _run_partial_transcription_bg(report_id: str, partial_url: str):
    """Background task: transcribe partial audio to English as chunks arrive.

    Apr 2026 (PR 2) - reads bytes via the storage abstraction + stages a
    /tmp/ tempfile for faster-whisper. No persistent local-disk usage.
    """
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        # Filename inferred from the URL tail (works for /static/foo.m4a
        # and s3://foo.m4a alike).
        filename = partial_url.rsplit("/", 1)[-1].split("://", 1)[-1].rsplit("/", 1)[-1]
        with _stage_from_storage(partial_url, filename) as tmp_path:
            text = ai_service.transcribe_audio_partial(tmp_path, translate_to_english=True)
        if text:
            ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report_id).first()
            if ai:
                ai.transcription = text
            else:
                db.add(AIAnalysis(report_id=report_id, transcription=text))
            db.commit()
            logger.info(f"Partial transcription updated for {report_id}: {len(text)} chars")
    except Exception as e:
        logger.warning(f"Partial transcription bg task failed: {e}")
    finally:
        db.close()


def _run_ai_pipeline_bg(report_id: str, media_type: str, file_url: str):
    """Background task wrapper - opens its own DB session so the HTTP response
    is not blocked by Whisper transcription (which can take 10–30 s).

    Phase K K.6.b: any uncaught exception lands a row in
    ``ai_retry_queue`` so the daemon can re-attempt with exponential
    backoff. Pre-K.6.b the exception was silently swallowed (it
    runs in a background thread + the bg wrapper had no except
    clause), leaving the report's ai_assessment NULL forever.
    """
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        _run_ai_pipeline(report_id, media_type, file_url, db)
    except Exception as e:
        # Roll back any partial AI-pipeline writes; record the
        # failure in the retry queue so the daemon picks it up.
        try:
            db.rollback()
        except Exception:
            pass
        try:
            from app.services.ai_retry_queue import enqueue as _ai_enqueue
            kind = 'transcription' if media_type == 'AUDIO' else 'image_analysis'
            _ai_enqueue(
                db,
                report_id=report_id,
                kind=kind,
                file_url=file_url,
                media_type=media_type,
                error=str(e),
            )
            db.commit()
        except Exception as q_err:
            logger.warning(
                "[ai_pipeline] failed to enqueue retry for report=%s "
                "kind=%s: %s (orig err: %s)",
                report_id, media_type, q_err, e,
            )
        logger.warning(
            "[ai_pipeline] report=%s media_type=%s failed: %s "
            "(queued for retry)",
            report_id, media_type, e,
        )
    finally:
        db.close()


def _try_partial_image_bg(media_id: str):
    """Background partial-image assembly - runs PII blur (slow: easyocr + MediaPipe).
    Non-blocking so the chunk handler can return in <100ms."""
    # ── OOM hotfix (May 2026): partial-preview pipeline disabled by default ──
    # Root cause of the PROD OOM crash-loop: _assemble_partial_image ran the
    # FULL PII blur (MediaPipe + easyocr/PyTorch) on EVERY partial render
    # (~every 10 chunks). Multi-image uploads turned that into a blur storm →
    # uvicorn RSS ≈ 3.5 GB on a 3.75 GB host → kernel OOM-kill → container
    # restart → in-flight blur tasks orphaned → media stuck
    # pii_blur_status='pending' → GET /media/{id}/file 425 forever
    # ("Checking PII" broken images). Disabling the partial preview removes the
    # storm: each image now runs ONE final blur, and the dashboard shows the
    # 425-gated FINAL image instead of an unblurred progressive partial - so we
    # also never serve an unblurred face (UNDP must-have #7).
    # Re-enable ONLY behind a memory-safe partial path: set CRISP_PARTIAL_PREVIEW=1.
    import os as _os
    if _os.getenv("CRISP_PARTIAL_PREVIEW", "0") != "1":
        return
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        media = db.query(Media).filter(Media.id == media_id).first()
        if not media or media.assembly_status == 'complete':
            return
        partial_url = _assemble_partial_image(media_id, db)
        if partial_url:
            # Re-fetch so we don't overwrite a later update
            db.refresh(media)
            if media.assembly_status != 'complete':
                media.thumbnail_url = partial_url
                db.commit()
    except Exception as e:
        logger.warning(f"[PartialImgBG] {media_id[:8]} failed: {e}")
    finally:
        db.close()


def _try_partial_audio_bg(media_id: str, report_id: str):
    """Background partial-audio assembly + live transcription."""
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        media = db.query(Media).filter(Media.id == media_id).first()
        if not media or media.assembly_status == 'complete':
            return
        partial_url = _assemble_partial_audio(media_id, db)
        if partial_url:
            db.refresh(media)
            if media.assembly_status != 'complete':
                media.thumbnail_url = partial_url
                db.commit()
            # Live transcription (translates to English) - own try/except in the fn
            _run_partial_transcription_bg(report_id, partial_url)
    except Exception as e:
        logger.warning(f"[PartialAudioBG] {media_id[:8]} failed: {e}")
    finally:
        db.close()


def _try_full_assembly_bg(media_id: str, media_type: str, report_id: str):
    """Background full-assembly task.

    Moving assembly off the HTTP handler prevents two problems:
      1) iOS fetch timing out on the last chunk while the server runs PII blur
         + file I/O (5–15 s). When the client aborts mid-handler we can end up
         with received_chunks == total but assembly_status still 'pending'
         (the symptom we saw for media b36a0511 - image stuck at 50–100 %).
      2) Concurrent retries racing each other inside the same handler.

    The task is idempotent: it flips status 'pending' → 'assembling' in a single
    UPDATE (optimistic locking) and only runs when that UPDATE actually changed
    a row. A second task for the same media_id will see 'assembling' or
    'complete' and exit immediately.
    """
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        media = db.query(Media).filter(Media.id == media_id).first()
        if not media:
            logger.warning(f"[AssemblyBG] media {media_id} not found")
            return
        if media.assembly_status == 'complete':
            logger.info(f"[AssemblyBG] {media_id[:8]} already complete - skip")
            return
        if media.chunk_count == 0 or media.received_chunks < media.chunk_count:
            logger.info(
                f"[AssemblyBG] {media_id[:8]} not ready: "
                f"{media.received_chunks}/{media.chunk_count}"
            )
            return

        # Optimistic lock: accept either 'pending' (we got here before the
        # handler pre-claimed - rare) OR 'assembling' (the handler pre-claimed
        # the slot for us via its own CAS in the chunk endpoint, which is the
        # common path). We must NOT bail on 'assembling' because the handler's
        # CAS IS our handoff signal - before this fix, every chunk logged
        # "acquired assembly lock" on the handler side and then "lock lost"
        # on the worker side, leaving the media in 'assembling' forever.
        # We still exclude 'complete' and 'failed' so re-submissions no-op.
        locked = db.query(Media).filter(
            Media.id == media_id,
            Media.assembly_status.in_(['pending', 'assembling'])
        ).update({'assembly_status': 'assembling'}, synchronize_session=False)
        db.commit()
        if locked == 0:
            logger.info(f"[AssemblyBG] {media_id[:8]} already terminal (complete/failed) - skip")
            return

        logger.info(
            f"[AssemblyBG] start {media_id[:8]} type={media_type} "
            f"chunks={media.received_chunks}/{media.chunk_count}"
        )

        # Guaranteed-delivery: capture tier + group NOW (before assembly) so
        # we can label metrics even on the failure branches. `tier_label` is
        # kept as the Enum value's string form for stable Prometheus label sets.
        # Phase L (May 2026) - fallback to canonical 'SMALL' (was 'LOW' pre-L).
        _tier_label = getattr(getattr(media, 'resolution_tier', None), 'value', 'SMALL') or 'SMALL'
        _group_id = getattr(media, 'photo_group_id', None)

        try:
            file_url = _assemble_media_file(media_id, media_type, db)
        except Exception as e:
            logger.error(f"[AssemblyBG] {media_id[:8]} assemble failed: {e}", exc_info=True)
            db.query(Media).filter(Media.id == media_id).update(
                {'assembly_status': 'failed'}, synchronize_session=False
            )
            db.commit()
            if media_type == 'IMAGE':
                try:
                    variant_uploads_total.labels(tier=_tier_label, outcome='fail').inc()
                except Exception:
                    pass
            return

        if not file_url:
            logger.error(f"[AssemblyBG] {media_id[:8]} assemble returned no url")
            # K.2.c (May 2026, Phase K) - only stamp `assembly_status='failed'`
            # if the checksum-mismatch path didn't already do it (in which
            # case `abandon_reason='checksum_mismatch'` is already set and
            # we'd otherwise overwrite assembly_status redundantly without
            # touching the reason). Conditional update preserves the
            # specific abandon_reason for dashboard chip rendering (K.5.a).
            db.query(Media).filter(
                Media.id == media_id,
                Media.assembly_status != 'failed',
            ).update(
                {'assembly_status': 'failed'}, synchronize_session=False
            )
            db.commit()
            if media_type == 'IMAGE':
                try:
                    variant_uploads_total.labels(tier=_tier_label, outcome='fail').inc()
                except Exception:
                    pass
            return

        # Mark complete + bump report sync state.
        db.refresh(media)
        media.url = file_url
        media.assembly_status = 'complete'
        media.is_synced = True
        media.completion_pct = 100.0
        # R1 (May 2026) - stamp recovery audit trail. The row reaches
        # this branch via either the happy path (never abandoned) or the
        # recovery path (abandoned by daemon Action ②/③, revived by a
        # subsequent chunk arrival in the handler's else branch). Only
        # the recovery path needs the timestamp - abandoned_at would be
        # NULL on the happy path. Idempotent (won't overwrite an existing
        # value) so a re-assembly after a partial-bytes window doesn't
        # update a previously-stamped row.
        if media.abandoned_at is not None and media.recovered_at is None:
            from datetime import datetime as _dt_r1, timezone as _tz_r1
            media.recovered_at = _dt_r1.now(_tz_r1.utc)
            try:
                from app.core.observability import (
                    media_recovery_total as _mrt,
                    media_recovery_duration_seconds as _mrd,
                )
                _mrt.labels(outcome='succeeded').inc()
                if media.abandoned_at is not None:
                    _duration = (media.recovered_at - media.abandoned_at).total_seconds()
                    _mrd.observe(max(0.0, _duration))
            except Exception:
                # Recovery metrics arrive in R2.c. Until then this
                # try/except keeps the worker working even when the
                # counters haven't been wired yet.
                pass

        # K.1.a (May 2026, Phase K) - atomic SQL increment.
        # Previous read-modify-write `report.received_media = (report.received_media or 0) + 1`
        # raced with concurrent /attach calls + parallel assembly-bg
        # threads; the count could diverge from reality (stuck PARTIAL
        # forever OR premature SYNCED with files still in flight). The
        # SQL `UPDATE ... SET received_media = received_media + 1` is
        # atomic at the DB engine level; concurrent transactions
        # serialise on the row.
        row = db.query(Report).filter(Report.id == report_id).first()
        if row:
            db.query(Report).filter(Report.id == report_id).update(
                {"received_media": (Report.received_media + 1)},
                synchronize_session="fetch",
            )
            db.commit()
            db.refresh(row)
            if row.expected_media and row.received_media >= row.expected_media:
                row.sync_status = SyncStatusEnum.SYNCED
                db.commit()
                logger.info(f"[AssemblyBG] report {report_id[:8]} fully synced")
        logger.info(f"[AssemblyBG] complete {media_id[:8]} → {file_url}")

        # Reclaim the reassembly buffer (May 2026). media_chunks rows hold
        # the raw uploaded bytes ONLY for assembly; once the file is durably
        # in storage (assembly_status='complete' + url set) nothing reads
        # them again - the public GET /media/{id}/file route serves
        # media.url from storage, never the chunks. We gate the delete on
        # storage.exists(file_url) so the rows drop ONLY after the assembled
        # object is CONFIRMED present; if the check is False/errors we keep
        # the chunks and the periodic backfill
        # (scripts/purge_assembled_chunks.py) reclaims them later. Wrapped +
        # AFTER the completion commit so a cleanup hiccup can never undo a
        # successful assembly (same convention as the metrics block below).
        try:
            if _get_media_storage().exists(file_url):
                _reclaimed = db.query(MediaChunk).filter(
                    MediaChunk.media_id == media_id
                ).delete(synchronize_session=False)
                db.commit()
                if _reclaimed:
                    logger.info(
                        f"[AssemblyBG] reclaimed {_reclaimed} chunk(s) for "
                        f"{media_id[:8]} (assembled file confirmed in storage)"
                    )
            else:
                logger.warning(
                    f"[AssemblyBG] chunk reclaim SKIPPED for {media_id[:8]} - "
                    f"storage.exists({file_url}) False; keeping chunks for the "
                    f"backfill sweep"
                )
        except Exception as _reclaim_e:
            db.rollback()
            logger.warning(
                f"[AssemblyBG] chunk reclaim skipped for {media_id[:8]}: {_reclaim_e}"
            )

        # Guaranteed-delivery: record variant success + time-to-first/full image.
        # These are the SLIs behind the 5-s first-image promise.
        if media_type == 'IMAGE':
            try:
                variant_uploads_total.labels(tier=_tier_label, outcome='success').inc()
                if report and report.server_created_at:
                    now = datetime.now(timezone.utc)
                    created_at = report.server_created_at
                    if created_at.tzinfo is None:
                        created_at = created_at.replace(tzinfo=timezone.utc)
                    delta = (now - created_at).total_seconds()
                    # First image of THIS photo group?
                    first_in_group = True
                    if _group_id:
                        sibling_count = db.query(Media).filter(
                            Media.photo_group_id == _group_id,
                            Media.id != media_id,
                            Media.assembly_status == 'complete',
                        ).count()
                        first_in_group = sibling_count == 0
                    if first_in_group and delta >= 0:
                        time_to_first_image_seconds.observe(delta)
                    # Phase L - `time_to_full_image_seconds` measures
                    # time-to-highest-tier-landed (ORIGINAL post-rename).
                    if _tier_label == 'ORIGINAL' and delta >= 0:
                        time_to_full_image_seconds.observe(delta)
            except Exception as e:
                # Metrics must never break the assembly pipeline.
                logger.debug(f"[AssemblyBG] variant metric skipped: {e}")

        # P2.3 - dispatch AI pipeline (Whisper / vision) to the AI pool instead
        # of running it inline. Whisper alone can take 10–30 s on CPU; keeping
        # it here would hold an assembly worker idle for that entire window.
        _ai_executor.submit(_run_ai_pipeline_bg, report_id, media_type, file_url)
    finally:
        db.close()


def _run_ai_pipeline(report_id: str, media_type: str, file_url: str, db: Session):
    """Trigger transcription after media assembly.

    Apr 2026 (PR 2) - reads bytes via the storage abstraction + stages
    a /tmp/ tempfile for the underlying filesystem API (faster-whisper).
    No persistent local-disk usage. Only AUDIO produces a stored result;
    image media carries no automated analysis (the analyst-facing AI
    credibility dossier comes from POST /{id}/ai-assess, not this path).
    """
    if not file_url:
        return
    filename = file_url.rsplit("/", 1)[-1].split("://", 1)[-1].rsplit("/", 1)[-1]

    if media_type == 'AUDIO':
        with _stage_from_storage(file_url, filename) as tmp_path:
            transcription = ai_service.transcribe_audio(tmp_path)
        if transcription:
            ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report_id).first()
            if ai:
                ai.transcription = transcription
            else:
                db.add(AIAnalysis(report_id=report_id, transcription=transcription))
            db.commit()


def _push_status_change_safely(report: Report) -> None:
    """Fire-and-forget call into the Web Push service.

    Wrapped in a try/except so a push-side failure (VAPID misconfig,
    provider 5xx, anything else) NEVER breaks the analyst's status-
    change request. The DB commit already happened; whatever happens
    here is best-effort UX polish.
    """
    try:
        from app.services.push import push_report_status_change
        push_report_status_change(report)
    except Exception:
        logger.exception(
            "[push] failed to enqueue notification for report %s; status change is fine",
            getattr(report, "id", "?"),
        )


def _audit_report_action(
    db: Session,
    user,
    action: str,
    report_id: str,
    details: Optional[dict] = None,
):
    """Phase F.2.b - Write an AuthAuditLog row for admin actions taken
    on a report. The dashboard surfaces these as a compact ribbon
    above the per-incident timeline so operators have an at-a-glance
    "what happened, by whom, when" view.

    Bounded vocabulary for `action`:
      REPORT_DISPATCH    - operator dispatched help
      REPORT_RESOLVE     - operator marked resolved
      REPORT_FALSE_ALARM - operator marked false alarm
      REPORT_ACCEPT      - analyst accepted verdict
      REPORT_REJECT      - analyst rejected verdict
      REPORT_DELETE      - operator soft-deleted (grace window)
      REPORT_VERIFY      - analyst kicked off satellite verification
    """
    from app.models.auth import AuthAuditLog
    db.add(AuthAuditLog(
        user_id=getattr(user, "id", None),
        user_email=getattr(user, "email", None),
        action=action,
        resource_type="report",
        resource_id=report_id,
        details=details,
    ))
    # No db.commit() here - caller already commits.


# P1-1: allowed report-status transitions. The status setters below used to be
# UNCONDITIONAL assignments, so an analyst could false-alarm a RESOLVED report or
# dispatch a FALSE_ALARM one with no warning. This is the `status` axis ONLY;
# `reviewer_verdict` is orthogonal and intentionally NOT guarded here. Idempotent
# self-transitions (re-applying the same status) are always allowed.
_REPORT_STATUS_TRANSITIONS = {
    # PENDING → act. The reverse edges back to PENDING (Jun 2026) power the
    # operator's "undo notify" / "reopen" actions on the incident detail: a
    # decision is reversible (RESPONDING/RESOLVED/FALSE_ALARM → PENDING) via the
    # /reopen endpoint. Rejection is verdict-based (reviewer_verdict) + reverted
    # via /review {NOT_REVIEWED}, so REJECTED status stays terminal here.
    ReportStatusEnum.PENDING:     {ReportStatusEnum.RESPONDING, ReportStatusEnum.RESOLVED, ReportStatusEnum.FALSE_ALARM},
    ReportStatusEnum.RESPONDING:  {ReportStatusEnum.RESOLVED, ReportStatusEnum.FALSE_ALARM, ReportStatusEnum.PENDING},
    ReportStatusEnum.RESOLVED:    {ReportStatusEnum.PENDING},   # reopen
    ReportStatusEnum.FALSE_ALARM: {ReportStatusEnum.PENDING},   # reopen
    # Deprecated/inert statuses (never written; see ReportStatusEnum docstring) -
    # treat a legacy VERIFIED row like PENDING, REJECTED as terminal.
    ReportStatusEnum.VERIFIED:    {ReportStatusEnum.RESPONDING, ReportStatusEnum.RESOLVED, ReportStatusEnum.FALSE_ALARM},
    ReportStatusEnum.REJECTED:    set(),
}


def _guard_status_transition(report, target: ReportStatusEnum):
    """Raise 409 if `target` is not a legal move from the report's current
    status. Self-transition (idempotent re-apply) is always allowed."""
    current = report.status
    if current == target:
        return  # idempotent no-op
    if target not in _REPORT_STATUS_TRANSITIONS.get(current, set()):
        cur = getattr(current, "value", current)
        raise HTTPException(
            status_code=409,
            detail=f"Illegal status transition: {cur} -> {target.value}",
        )


@router.patch("/{report_id}/false-alarm", response_model=ReportResponse)
def mark_false_alarm(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as a FALSE_ALARM without deleting it."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _guard_status_transition(report, ReportStatusEnum.FALSE_ALARM)
    report.status = ReportStatusEnum.FALSE_ALARM
    _audit_report_action(db, user, "REPORT_FALSE_ALARM", report_id)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


@router.patch("/{report_id}/dispatch", response_model=ReportResponse)
def dispatch_team(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as RESPONDING - rescue team has been dispatched.

    April 2026: the first time a report leaves PENDING for a verified
    status (RESPONDING / RESOLVED) we bump the reporter's
    ``verified_count`` so quality-based credibility (see §3.8 of
    docs/INCENTIVES.md) reflects the accepted report.

    The endpoint-level ``was_pending`` guard catches the common case
    (status transition from PENDING). For the parallel-request race
    (two analysts both dispatch + resolve at the same instant), the
    real idempotency gate is inside
    ``_mark_report_verified_for_credibility`` - it uses
    ``SELECT … FOR UPDATE`` + a ``first_verified_at`` timestamp check
    to serialize. See May 2026 audit C-2 fix."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _guard_status_transition(report, ReportStatusEnum.RESPONDING)
    was_pending = report.status == ReportStatusEnum.PENDING
    report.status = ReportStatusEnum.RESPONDING
    if was_pending:
        # SessionLocal uses ``autoflush=False`` (see app/db/session.py)
        # so the in-memory status change above does NOT reach the DB
        # before ``_mark_report_verified_for_credibility`` runs.
        # Inside that function ``_recompute_tier`` COUNTS reports by
        # status via a fresh DB query - without an explicit flush,
        # the count returns 0 RESPONDING / RESOLVED rows and the
        # profile falls back to T2_SIGNAL instead of promoting to
        # T3_CHANGEMAKER. Operator-facing UX of "click Dispatch →
        # see your tier go up" depends on this flush.
        # Same fix in resolve_report below.
        db.flush()
        _mark_report_verified_for_credibility(report, db)
    _audit_report_action(db, user, "REPORT_DISPATCH", report_id)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


@router.patch("/{report_id}/resolve", response_model=ReportResponse)
def resolve_report(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as RESOLVED - situation handled."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _guard_status_transition(report, ReportStatusEnum.RESOLVED)
    was_pending = report.status == ReportStatusEnum.PENDING
    report.status = ReportStatusEnum.RESOLVED
    if was_pending:
        # See dispatch_team for the autoflush rationale - flush the
        # status change BEFORE the recompute counts by status.
        db.flush()
        _mark_report_verified_for_credibility(report, db)
    _audit_report_action(db, user, "REPORT_RESOLVE", report_id)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


@router.patch("/{report_id}/reopen", response_model=ReportResponse)
def reopen_report(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Revert a RESPONDING / RESOLVED / FALSE_ALARM report back to PENDING (open) -
    the operator's "undo notify" / "reopen" action on the incident detail. Clears
    the dispatch/arrival timestamps so the queue predicates treat it as open again.
    (Reverting a REJECTION is verdict-based: PATCH /review {verdict: NOT_REVIEWED}.)"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _guard_status_transition(report, ReportStatusEnum.PENDING)
    report.status = ReportStatusEnum.PENDING
    report.help_dispatched_at = None
    report.help_arrived_at = None
    _audit_report_action(db, user, "REPORT_REOPEN", report_id)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


# ── Command Center: global FILTERED-slice cascade (set-based) ───────────────────
# The realistic 10k-incident response: an admin acts on a SLICE (critical /
# unattended / needs-response / by-operation), not row-by-row. One set-based
# transaction percolates to every incident + report in the slice — audited +
# reversible. Admin-gated because a global blast radius can be very large; a
# meaningful filter is required (no blind whole-DB mutation). dry_run first shows
# the blast radius.
@router.post("/cascade", summary="Cascade an action across a global filtered slice (set-based, admin)")
def cascade_global(body: dict, db: Session = Depends(get_db), user=Depends(require_admin)):
    from app.services.cascade import run_cascade, CascadeError
    try:
        return run_cascade(db, user, scope_type="global", scope_id=None,
                           action=body.get("action"), filters=(body.get("filters") or {}),
                           reason=body.get("reason"), dry_run=bool(body.get("dry_run")))
    except CascadeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/cascade-revert", summary="Undo a prior cascade precisely (set-based)")
def cascade_revert(body: dict, db: Session = Depends(get_db), user=Depends(require_analyst)):
    from app.services.cascade import revert_cascade, CascadeError
    try:
        return revert_cascade(db, user, body.get("log_id"))
    except CascadeError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Notify Response Team (Actions section) ──────────────────────
# The "Notify Response Team" modal lists the responders linked to the incident's
# building + operation and lets the analyst alert a selected set by SMS / Email.
# Contact is a single free-text field, so the channel is derived: a value
# containing "@" is an email; one with digits is a phone (SMS).

def _responder_channel(contact: Optional[str]) -> Optional[str]:
    c = (contact or "").strip()
    if not c:
        return None
    if "@" in c:
        return "email"
    return "sms" if any(ch.isdigit() for ch in c) else None


@router.get("/{report_id}/responders")
def list_report_responders(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """List the active responders (building + operation scoped) for an incident,
    each annotated with the channel its contact supports (sms / email / none)."""
    from app.models.report import BuildingResponder
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    conds = []
    if report.building_id:
        conds.append(BuildingResponder.building_id == report.building_id)
    if report.crisis_event_id:
        conds.append(BuildingResponder.crisis_event_id == report.crisis_event_id)
    if not conds:
        return {"responders": [], "building_id": report.building_id, "crisis_event_id": report.crisis_event_id}
    rows = (
        db.query(BuildingResponder)
        .filter(BuildingResponder.cleared_at.is_(None))
        .filter(or_(*conds))
        .order_by(BuildingResponder.assigned_at.desc())
        .all()
    )
    return {
        "building_id": report.building_id,
        "crisis_event_id": report.crisis_event_id,
        "responders": [
            {
                "id": r.id,
                "name": r.responder_name,
                "org": r.responder_org,
                "org_type": r.org_type,
                "contact": r.responder_contact,
                "channel": _responder_channel(r.responder_contact),
                "target_type": r.target_type,
                "dispatched_at": r.dispatched_at.isoformat() if r.dispatched_at else None,
            }
            for r in rows
        ],
    }


@router.post("/{report_id}/notify-responders")
def notify_responders(
    report_id: str,
    payload: dict,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
):
    """Alert the selected responders by SMS / Email, log the notification, move
    the incident into Active Response, and confirm to the reporter (push).

    Body: {"responder_ids": [...], "channels": ["sms","email"]}.
    A responder is messaged only on a channel its contact supports."""
    from app.models.report import BuildingResponder
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    ids = [str(x) for x in (payload.get("responder_ids") or [])]
    channels = {str(c).lower() for c in (payload.get("channels") or ["sms", "email"])}
    if not ids:
        raise HTTPException(status_code=400, detail="No responders selected")

    rows = db.query(BuildingResponder).filter(BuildingResponder.id.in_(ids)).all()
    loc = report.location
    place = (getattr(loc, "user_location_name", None) or getattr(loc, "device_location_name", None)) if loc else None
    sev = report.severity.value if report.severity else ""
    infra = (report.infrastructure_type.value if report.infrastructure_type else "incident").replace("_", " ").lower()
    body = (
        f"CRISP response request: {sev} {infra}"
        + (f" near {place}" if place else "")
        + f". Please respond. Incident ref {report_id[:8]}."
    )
    subject = f"CRISP: response needed - {sev} {infra}".strip()

    from app.services.sms import send_sms, validate_e164
    from app.core.security import send_email

    notified, failures = [], []
    sms_ok = email_ok = 0
    now = datetime.now(timezone.utc)
    for r in rows:
        ch = _responder_channel(r.responder_contact)
        sent = False
        if ch == "email" and "email" in channels:
            if send_email(r.responder_contact.strip(), subject, body):
                email_ok += 1
                sent = True
            else:
                failures.append({"name": r.responder_name, "channel": "email", "reason": "email not configured / send failed"})
        elif ch == "sms" and "sms" in channels:
            try:
                send_sms(validate_e164(r.responder_contact), body)
                sms_ok += 1
                sent = True
            except Exception as e:
                failures.append({"name": r.responder_name, "channel": "sms", "reason": e.__class__.__name__})
        else:
            failures.append({"name": r.responder_name, "channel": ch or "none", "reason": "no matching selected channel"})
        if sent:
            notified.append(r.responder_name)
            if r.dispatched_at is None:
                r.dispatched_at = now

    _audit_report_action(
        db, user, "REPORT_NOTIFY_RESPONDERS", report_id,
        details={"responders": notified[:25], "channels": sorted(channels), "count": len(notified)},
    )

    # Move into Active Response (mirrors dispatch) when still pending, so the
    # reporter gets the standard status-change push ("Help is on the way").
    moved = False
    if report.status in (ReportStatusEnum.PENDING, ReportStatusEnum.VERIFIED):
        report.status = ReportStatusEnum.RESPONDING
        db.flush()
        _mark_report_verified_for_credibility(report, db)
        moved = True

    db.commit()
    db.refresh(report)
    if moved:
        _push_status_change_safely(report)
    return {
        "notified": len(notified),
        "sms": sms_ok,
        "email": email_ok,
        "failures": failures,
        "status": report.status.value if report.status else None,
        "moved_to_responding": moved,
    }


# ── Phase 5 - reviewer workflow ─────────────────────────────────

@router.patch("/{report_id}/review", response_model=ReportResponse)
def set_review_verdict(
    report_id: str,
    payload: dict,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
):
    """Record an analyst's explicit accept/reject verdict. Stamps
    `reviewed_at=now()` so response-time metrics work. REJECTED requires a
    non-empty `action_taken` so reviewers always capture a rationale."""
    from app.models.report import ReviewerVerdictEnum
    from datetime import datetime, timezone as _tz

    verdict = str(payload.get("verdict", "")).upper()
    if verdict not in {v.value for v in ReviewerVerdictEnum}:
        raise HTTPException(status_code=400, detail=f"Invalid verdict: {verdict!r}")
    action_taken = payload.get("action_taken")
    if verdict == ReviewerVerdictEnum.REJECTED.value and not (action_taken and str(action_taken).strip()):
        raise HTTPException(
            status_code=400,
            detail="action_taken is required when verdict is REJECTED",
        )

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.reviewer_verdict = verdict
    report.reviewed_at = datetime.now(_tz.utc)
    # P5-redesign: persist WHO reviewed it (closes the audit-trail gap).
    report.reviewed_by = getattr(user, "id", None)
    if action_taken is not None:
        report.action_taken = str(action_taken).strip()[:500] or None

    # Phase 5 metric. Never let observability failures break the endpoint.
    try:
        from app.core.observability import (
            reports_reviewed_total,  # type: ignore[attr-defined]
        )
        if verdict in ("ACCEPTED", "REJECTED"):
            reports_reviewed_total.labels(verdict=verdict).inc()
    except Exception:
        pass

    # Phase F.2.b - audit the analyst verdict for the per-report ribbon.
    if verdict == "ACCEPTED":
        _audit_report_action(db, user, "REPORT_ACCEPT", report_id)
    elif verdict == "REJECTED":
        _audit_report_action(db, user, "REPORT_REJECT", report_id,
                             details={"action_taken": (action_taken or "")[:120]})

    db.commit()
    db.refresh(report)
    logger.info(f"[Reviewer] {report_id[:8]} verdict={verdict} by {user.id[:8]}")
    return report


@router.patch("/{report_id}/timestamps", response_model=ReportResponse)
def set_responder_timestamps(
    report_id: str,
    payload: dict,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
):
    """Stamp dispatched/arrived moments for the response team. The admin UI
    can either pass explicit ISO timestamps OR set `stamp_dispatched_now` /
    `stamp_arrived_now` to have the server write `datetime.now(UTC)`.
    Computed `response_time_seconds` on the read path derives from these +
    `reviewed_at`."""
    from datetime import datetime, timezone as _tz

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    def _parse(v):
        if not v:
            return None
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid datetime: {v!r}")

    if payload.get("stamp_dispatched_now"):
        report.help_dispatched_at = datetime.now(_tz.utc)
    elif "help_dispatched_at" in payload:
        report.help_dispatched_at = _parse(payload.get("help_dispatched_at"))
    if payload.get("stamp_arrived_now"):
        report.help_arrived_at = datetime.now(_tz.utc)
    elif "help_arrived_at" in payload:
        report.help_arrived_at = _parse(payload.get("help_arrived_at"))

    # Cross-field sanity: arrival cannot precede dispatch. SQLite reads
    # stored datetimes back tz-naive; freshly-stamped values (above) are
    # tz-aware. Normalise both to UTC-aware before comparing or Python
    # raises TypeError on the mixed comparison (caught by E2E test
    # tests/backend/01-report-lifecycle.spec.ts → end-to-end flow).
    if report.help_dispatched_at and report.help_arrived_at:
        d = report.help_dispatched_at
        a = report.help_arrived_at
        if d.tzinfo is None:
            d = d.replace(tzinfo=_tz.utc)
        if a.tzinfo is None:
            a = a.replace(tzinfo=_tz.utc)
        if a < d:
            raise HTTPException(status_code=400, detail="help_arrived_at before help_dispatched_at")

    db.commit()
    db.refresh(report)
    logger.info(
        f"[Reviewer] {report_id[:8]} timestamps dispatched="
        f"{report.help_dispatched_at} arrived={report.help_arrived_at}"
    )
    return report


def _resolve_device_id(device_hash: str, db: Session) -> Optional[str]:
    """Resolve a client-side device_hash (e.g. DEV-XXXXXXXX) to the internal device UUID."""
    device = db.query(Device).filter(Device.device_hash == device_hash).first()
    if device:
        return device.id
    # Fallback: try direct match on device_id (for backward compatibility)
    existing = db.query(Report).filter(Report.device_id == device_hash).first()
    return device_hash if existing else None


def _authorize_report_mutation(report, request, db, user=None, device_hash=None):
    """Authorize a mutation of an EXISTING report. A bare report_id is NOT
    sufficient authorization - report ids leak via /evidence share links, so
    anyone holding one could otherwise edit/relocate the report. Three
    legitimate caller classes are allowed:

      1. channel bot   - sends the shared ``X-Bot-Key`` header (== CRISP_BOT_KEY),
                         server-to-server (the SMS/IVR/WhatsApp/Telegram pipeline).
      2. operator      - an authenticated ANALYST / ADMIN / SUPER_ADMIN session.
      3. owning device - ``device_hash`` resolves to ``report.device_id`` (citizen
                         self-service; mirrors the undo-delete ownership check).

    Rollout safety: enforcement is gated by the env flag
    ``CRISP_ENFORCE_REPORT_MUTATION_AUTH``. While OFF (the default) an
    unauthorized call is still ALLOWED but logged as a 'would-reject' warning,
    so the clients (PWA/RN send device_hash, bots send X-Bot-Key) can be rolled
    out first and the warning logs confirmed clean. Flip the flag ON to start
    returning 403. Returns the authorized actor label.
    """
    from app.models.auth import RoleEnum
    import hmac as _hmac
    actor = None
    bot_key = (os.environ.get("CRISP_BOT_KEY") or "").strip()
    if bot_key:
        sent = (request.headers.get("X-Bot-Key") or "").strip()
        if sent and _hmac.compare_digest(sent, bot_key):
            actor = "bot"
    if actor is None and user is not None and getattr(user, "role", None) in (
            RoleEnum.ANALYST.value, RoleEnum.ADMIN.value, RoleEnum.SUPER_ADMIN.value):
        actor = "operator"
    if actor is None and device_hash:
        resolved = _resolve_device_id(device_hash, db)
        if resolved and report.device_id and resolved == report.device_id:
            actor = "owner"
    if actor:
        return actor
    enforce = (os.environ.get("CRISP_ENFORCE_REPORT_MUTATION_AUTH", "").strip().lower()
               in ("1", "true", "yes", "on"))
    if enforce:
        raise HTTPException(status_code=403, detail="Not authorized to modify this report")
    logger.warning(
        "[authz] report mutation ALLOWED with no valid actor (enforcement off) "
        "report=%s ip=%s path=%s - set CRISP_ENFORCE_REPORT_MUTATION_AUTH=1 to block",
        getattr(report, "id", "?"),
        request.client.host if request and request.client else "?",
        request.url.path if request else "?",
    )
    return "unauthorized-allowed"


def _report_mutate_rate_limit(request) -> None:
    """Per-IP rate limit shared by the unauthenticated report-mutation routes."""
    from app.main import check_rate_limit
    client_ip = request.client.host if request and request.client else "unknown"
    if not check_rate_limit(f"report-mutate:{client_ip}", max_requests=120, window=60):
        raise HTTPException(status_code=429, detail="Too many requests; slow down and retry.")


def _attach_reporter_tier(db: Session, reports: list) -> None:
    """Phase 1.6 (May 2026) - Dashboard V4 field parity helper.

    Bulk-attaches the reporter's gamification tier (one of T1_SCOUT /
    T2_SIGNAL / T3_CHANGEMAKER / T4_LIFEKEEPER) onto each Report as a
    transient ``reporter_tier`` attribute. Pydantic auto-extracts
    declared schema fields off the ORM instance when
    ``from_attributes=True`` is set, so the response payload picks up
    the value with no further wiring.

    Performance: ONE query for the device_hash → badge_level map
    (keyed by device_hash IN (...)), then in-memory lookup per
    report. For a 100-report page this is one extra query instead of
    100, keeping ``/api/v1/reports/`` polling cheap.

    Failure mode: any SQLAlchemy error here silently leaves
    ``reporter_tier`` unset on every report (the schema field is
    Optional and the dashboard treats NULL as "no tier badge"). The
    listing endpoint MUST not 500 just because the tier-join failed.
    """
    if not reports:
        return
    try:
        # Collect distinct device_hashes by walking the eager-loaded
        # Report.device relationship. Reports without a device row
        # (legacy / channel imports) are silently skipped.
        from app.models.report import ReporterProfile
        hashes: set[str] = set()
        for r in reports:
            dev = getattr(r, "device", None)
            if dev is not None and getattr(dev, "device_hash", None):
                hashes.add(dev.device_hash)
        if not hashes:
            return
        rows = (
            db.query(ReporterProfile.device_hash, ReporterProfile.badge_level)
              .filter(ReporterProfile.device_hash.in_(hashes))
              .all()
        )
        tier_map = {h: bl for (h, bl) in rows if bl}
        # Only stamp tiers that match the V4 gamification taxonomy
        # (T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER / T4_LIFEKEEPER).
        # Legacy badge_level values (HERO/GUARDIAN/HELPER/NEWCOMER)
        # are skipped so the dashboard doesn't render a stale label
        # - operators see "no tier badge" until the next dispatch
        # re-credits the device under the new taxonomy.
        _V4_TIERS = {"T1_SCOUT", "T2_SIGNAL", "T3_CHANGEMAKER", "T4_LIFEKEEPER"}
        for r in reports:
            dev = getattr(r, "device", None)
            if dev is None:
                continue
            tier = tier_map.get(getattr(dev, "device_hash", None))
            if tier in _V4_TIERS:
                # Stamp the transient attribute. Pydantic's
                # `from_attributes=True` config picks this up by
                # name when serialising ReportResponse - no schema-
                # side validator needed.
                r.reporter_tier = tier  # type: ignore[attr-defined]
    except Exception:
        logger.exception("Failed to attach reporter_tier to reports list")
        # Best-effort - leave unset. The dashboard already handles NULL.
        return


# P3-3 (KEPT - deliberate perf optimization, not removed): this bulk-attaches the
# operation name in ONE query per page rather than an ORM relationship traversal
# per report. The audit noted a join could replace it but flagged "validate at
# 500k scale first" - at that scale the single-query attach is the safe shape.
def _attach_operation_name(db: Session, reports: list) -> None:
    """Operations redesign v2 - bulk-attach each report's operation NAME as a
    transient ``crisis_event_name`` attribute so the dashboard's new-report
    notification can show which operation an incident belongs to (or "Global"
    when it belongs to none). Same shape as ``_attach_reporter_tier``: ONE query
    for the page's distinct crisis_event_ids → name map, in-memory lookup per
    report (no N+1). Pydantic's ``from_attributes=True`` picks the attribute up
    by name. Best-effort - any error leaves it unset (Optional → "Global")."""
    if not reports:
        return
    try:
        from app.models.report import CrisisEvent
        ids = {r.crisis_event_id for r in reports if getattr(r, "crisis_event_id", None)}
        if not ids:
            return
        name_by_id = dict(
            db.query(CrisisEvent.id, CrisisEvent.name).filter(CrisisEvent.id.in_(ids)).all())
        for r in reports:
            cid = getattr(r, "crisis_event_id", None)
            if cid and cid in name_by_id:
                r.crisis_event_name = name_by_id[cid]  # type: ignore[attr-defined]
    except Exception:
        logger.exception("Failed to attach crisis_event_name to reports list")
        return


@router.get("/device/{device_hash}", response_model=List[ReportResponse])
def get_device_reports(device_hash: str, db: Session = Depends(get_db)):
    """List all reports submitted by a specific device (for privacy/deletion UI).
    Accepts the client-side device_hash (e.g. DEV-XXXXXXXX) and resolves it.

    Phase 1.6 follow-up (May 2026) - also stamps ``reporter_tier`` on
    every returned row, same bulk-join as the dashboard list endpoint.
    The PWA / RN "My Reports" pages render the reporter-tier chip per
    row; without this attach the chip stayed blank on those surfaces
    even though the dashboard had it.
    """
    device_id = _resolve_device_id(device_hash, db)
    if not device_id:
        return []
    reports = (
        db.query(Report)
          .options(joinedload(Report.device))
          .filter(Report.device_id == device_id)
          .order_by(Report.server_created_at.desc())
          .all()
    )
    _attach_reporter_tier(db, reports)
    return reports


@router.delete("/device/{device_hash}", status_code=status.HTTP_200_OK)
def delete_device_data(device_hash: str, request: Request, db: Session = Depends(get_db)):
    """Delete ALL reports and media files submitted by a specific device.
    Used by the mobile app's 'Delete My Data' privacy feature.

    Authorization is capability-based: device_hash is a high-entropy
    client secret (SHA-256), so knowing it proves ownership (same model as a
    report UUID). A per-IP rate limit blocks brute-force enumeration of the
    bulk-delete across devices."""
    _report_mutate_rate_limit(request)
    device_id = _resolve_device_id(device_hash, db)
    if not device_id:
        return {"deleted": 0}
    reports = db.query(Report).filter(Report.device_id == device_id).all()
    if not reports:
        return {"deleted": 0}
    count = 0
    for report in reports:
        for m in report.media:
            for suffix in ['', '_partial', '_assembled']:
                for ext in ['jpg', 'webm', 'png']:
                    fpath = os.path.join(UPLOAD_DIR, f"{m.id}{suffix}.{ext}")
                    if os.path.exists(fpath):
                        try: os.remove(fpath)
                        except: pass
            if m.url and m.url.startswith("/static/"):
                disk_path = os.path.join(UPLOAD_DIR, m.url.replace("/static/", ""))
                if os.path.exists(disk_path):
                    try: os.remove(disk_path)
                    except: pass
        # Remove satellite images
        for prefix in ['sat_', 'sat_alt_']:
            for ext in ['png', 'jpg']:
                sat_path = os.path.join(UPLOAD_DIR, f"{prefix}{report.id}.{ext}")
                if os.path.exists(sat_path):
                    try: os.remove(sat_path)
                    except: pass
        db.delete(report)
        count += 1
    db.commit()
    logger.info(f"Privacy deletion: {count} reports removed for device {device_id}")
    return {"deleted": count}


@router.get("/device/{device_hash}/status-since")
def get_device_status_since(device_hash: str, since: str = None, db: Session = Depends(get_db)):
    """Lightweight polling endpoint used by the mobile apps' My Reports
    screen. Returns a flat list of the caller's reports with enough
    detail to render both the list card AND the detail view without
    additional round-trips.

    Apr 2026 expansion (spec: 'My Reports & Individual Report Management'):
    each row now includes location, a thumbnail URL, and the description
    so the My Reports card can show image/place/status at a glance.
    """
    device_id = _resolve_device_id(device_hash, db)
    if not device_id:
        return []
    # joinedload so we don't N+1 on location + media lookups. Each user
    # typically has 1–50 reports; eager loading is cheaper than the round
    # trips, especially on cold DB connections.
    q = db.query(Report).options(
        joinedload(Report.location),
        joinedload(Report.media),
    ).filter(Report.device_id == device_id)
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace('Z', '+00:00'))
            q = q.filter(Report.updated_at > since_dt)
        except Exception:
            pass
    reports = q.all()

    def _iso(dt):
        # Z-suffixed UTC - same guarantee as ReportResponse's field
        # serializers. Bare isoformat() depends on the datetime being
        # tz-aware (true on Postgres timestamptz today, but fragile) and
        # emits '+00:00' instead of 'Z'.
        return _utc_iso(dt)

    def _rt(r):
        """Computed response_time_seconds - the ONE canonical helper (P2-4)."""
        from app.schemas.report import compute_response_time_seconds
        return compute_response_time_seconds(r.reviewed_at, r.help_dispatched_at, r.help_arrived_at)

    def _thumb_url(r):
        """Pick the SMALL photo variant if available - cheap to download,
        always sized for a card thumbnail. Falls back to MEDIUM → any
        complete IMAGE → first IMAGE's thumbnail_url. Returns None when
        the report has no photos yet.

        May 2026 (Phase 16, Delta-thumb-S1) - bug fix: this helper used to
        return ``m.url`` raw, which on PROD (``MEDIA_BACKEND=s3``) is an
        ``s3://crisp-uploads/...`` URI. ``MediaResponse``'s
        ``field_serializer`` rewrites those to ``/api/v1/reports/media/<id>/<file|thumb>``
        on JSON encode, but this aggregator returns a plain dict so the
        serializer never fires. Result: every PROD client received
        ``s3://...`` and concatenated it onto the host, producing a 404 and
        the onerror placeholder for every card thumbnail. The
        ``_stable_url`` helper mirrors the serializer's logic so the
        rewrite happens here too - guaranteeing stable thumbnails across
        every list / detail / recent-reports surface that consumes this
        endpoint.
        """
        def _stable_url(m, *, prefer_file=False):
            """Mirror MediaResponse.field_serializer's rewrite for one
            media row. Returns a stable backend route for s3:// URLs;
            pass-through for /static/, data:, http(s)://.

            ``prefer_file=False`` (default) → /thumb; ``True`` → /file.
            We default to /thumb because every caller of _thumb_url is
            a list-card / small-preview surface."""
            if not (m and m.url):
                return None
            if m.url.startswith('s3://'):
                suffix = 'file' if prefer_file else 'thumb'
                return f'/api/v1/reports/media/{m.id}/{suffix}'
            return m.url

        images = [m for m in (r.media or []) if m.type.value == 'IMAGE']
        if not images:
            return None
        # Prefer a complete SMALL variant (cheapest, best for list thumbs).
        for tier_preference in ('SMALL', 'MEDIUM', 'ORIGINAL'):
            for m in images:
                if (m.resolution_tier and m.resolution_tier.value == tier_preference and
                        m.assembly_status == 'complete' and m.url):
                    return _stable_url(m)
        # Fallback: any complete variant at all.
        for m in images:
            if m.assembly_status == 'complete' and m.url:
                return _stable_url(m)
        # Last resort: the partial-assembly preview thumbnail. Still
        # rewrite s3:// if present; the partial-thumb field is sometimes
        # written as s3:// during chunked-upload assembly.
        last = images[0]
        if last and last.thumbnail_url:
            if last.thumbnail_url.startswith('s3://'):
                return f'/api/v1/reports/media/{last.id}/thumb'
            return last.thumbnail_url
        return None

    def _location(r):
        """Return a compact location descriptor. Prefers user-entered
        name; falls back to device-reported geocoded name; finally bare
        lat/lng. None if no location row exists."""
        loc = r.location
        if not loc:
            return None
        return {
            "user_location_name": loc.user_location_name,
            "device_location_name": loc.device_location_name,
            "latitude": loc.latitude,
            "longitude": loc.longitude,
        }

    return [{
        "id": r.id,
        "client_report_id": r.client_report_id,
        "status": r.status.value,
        "severity": r.severity.value,
        "infrastructure_type": r.infrastructure_type.value,
        "crisis_type": r.crisis_type,
        "damage_classification": r.damage_classification,
        "description": r.description,
        "lives_impacted": r.lives_impacted,
        "server_created_at": _iso(r.server_created_at),
        "updated_at": _iso(r.updated_at),
        # Reviewer workflow.
        "reviewer_verdict": r.reviewer_verdict or "NOT_REVIEWED",
        "action_taken": r.action_taken,
        "help_dispatched_at": _iso(r.help_dispatched_at),
        "help_arrived_at": _iso(r.help_arrived_at),
        "reviewed_at": _iso(r.reviewed_at),
        "response_time_seconds": _rt(r),
        # My Reports card / detail view surfaces.
        "location": _location(r),
        "thumbnail_url": _thumb_url(r),
        "deletion_requested_at": _iso(r.deletion_requested_at),
    } for r in reports]


@router.patch("/{report_id}/impact")
def set_lives_impacted(report_id: str, payload: dict, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Set the number of lives impacted by this incident.

    May 2026 - also recomputes the reporter's tier so a transition
    from 0 → ≥1 lives saved fires the T4 LIFEKEEPER promotion on the
    next /profile read. The PWA picks this up via the My-Reports
    tier-up delta toast (see ``_renderSubmittedReports`` snapshot-v2
    logic).
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.lives_impacted = payload.get("lives_impacted", 0)
    db.commit()
    # Tier recompute walks the device's reports; runs AFTER the commit
    # above so the SUM query sees the new value. Failures here must
    # never break the analyst's PATCH - wrap defensively.
    try:
        _mark_report_lives_impacted_for_tier(report, db)
        db.commit()
    except Exception as e:  # pragma: no cover - observability only
        logger.warning(f"[Tier] recompute on /impact failed for report {report_id[:8]}: {e}")
    return {"id": report_id, "lives_impacted": report.lives_impacted}


@router.delete("/{report_id}", status_code=status.HTTP_200_OK)
def delete_report(report_id: str, user=Depends(require_admin), grace_minutes: int = 1440,
                  deletion_source: str = "DASHBOARD", reason: Optional[str] = None,
                  db: Session = Depends(get_db)):
    """Soft-delete with audit logging. grace_minutes: 1440 (24h) for dashboard, 30 for mobile.
    `reason` is the operator's rationale (compliance) - stored on the deletion audit row."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    reason_clean = (str(reason).strip()[:500] or None) if reason else None
    # Audit log: preserve anonymized metadata before deletion
    loc_snapshot = None
    if report.location:
        loc_snapshot = {"lat": report.location.latitude, "lng": report.location.longitude,
                        "name": report.location.device_location_name or report.location.user_location_name}
    audit = DeletionAuditLog(
        report_id=report_id,
        device_hash=report.device.device_hash if report.device else None,
        location_snapshot=loc_snapshot,
        damage_type=report.infrastructure_type.value if report.infrastructure_type else None,
        severity=report.severity.value if report.severity else None,
        deletion_source=deletion_source,
        deletion_reason=reason_clean,
    )
    db.add(audit)

    report.deletion_requested_at = datetime.now(timezone.utc)
    report.deletion_grace_minutes = grace_minutes
    # Phase F.2.b - audit the soft-delete for the per-report ribbon.
    _audit_report_action(db, user, "REPORT_DELETE", report_id,
                         details={"grace_minutes": grace_minutes, "source": deletion_source,
                                  **({"reason": reason_clean} if reason_clean else {})})
    db.commit()
    grace_label = f"{grace_minutes} minutes" if grace_minutes < 120 else f"{grace_minutes // 60} hours"
    logger.info(f"Soft-delete: report {report_id} ({deletion_source}) - permanent in {grace_label}")
    return {"id": report_id, "deletion_requested_at": report.deletion_requested_at.isoformat(),
            "message": f"Your data will be permanently deleted within {grace_label}."}


@router.post("/{report_id}/undo-delete", response_model=ReportResponse)
def undo_delete(
    report_id: str,
    device_hash: Optional[str] = Query(
        None,
        description="Caller's device hash. Required for citizen self-service undo "
                    "(must match the report's device). Omit when authenticating as admin."),
    user=Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    """Undo a pending deletion within the 24-hour grace window.

    Authorization (Phase-0 hardening): the soft-delete is the privacy / GDPR
    deletion gate (must-have #10), so REVERSING it must be proven, not open to
    any anonymous caller who guesses a report id. Allowed when EITHER:
      - the caller presents an admin / super-admin JWT, OR
      - the caller's device_hash resolves to this report's own device
        (citizen self-service undo from the PWA, mirroring the
        /device/{device_hash} privacy endpoints).
    Any other caller is rejected with 403 before report state is touched."""
    from app.models.auth import RoleEnum
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    is_admin = bool(user and getattr(user, "role", None) in
                    (RoleEnum.ADMIN.value, RoleEnum.SUPER_ADMIN.value))
    owns_device = False
    if device_hash:
        resolved = _resolve_device_id(device_hash, db)
        owns_device = bool(resolved and report.device_id and resolved == report.device_id)
    if not (is_admin or owns_device):
        raise HTTPException(status_code=403, detail="Not authorized to undo this deletion")

    if not report.deletion_requested_at:
        raise HTTPException(status_code=400, detail="Report is not pending deletion")
    # Check if 24h has passed
    elapsed = (datetime.now(timezone.utc) - report.deletion_requested_at.replace(tzinfo=timezone.utc)).total_seconds()
    if elapsed > 86400:
        raise HTTPException(status_code=410, detail="Grace period expired - data already scheduled for permanent deletion")
    report.deletion_requested_at = None
    db.commit()
    db.refresh(report)
    logger.info(f"Undo delete for report {report_id} ({'admin' if is_admin else 'device-owner'}) - restored to active")
    return report


def _purge_expired_deletions(db: Session):
    """Permanently delete reports whose grace period has expired.
    Uses per-report grace_minutes (default 24h, mobile=30min).

    Apr 2026 PR 2 - ALSO decrements the corresponding `ReporterProfile`
    counters. The counter was previously incremented on submit
    (`_update_reporter_profile`) but never decremented anywhere, so a
    user who deleted all their reports still saw "7 REPORTS SUBMITTED"
    on the home screen. Decrementing here (not on soft-delete) matches
    the 24-hour grace window: the user might undo their deletion, so
    their counter stays until the row actually disappears.
    """
    now = datetime.now(timezone.utc)
    # Get all reports with deletion requested
    pending = db.query(Report).filter(Report.deletion_requested_at != None).all()
    expired = []
    for r in pending:
        # `or 1440` would silently rewrite an explicit `grace=0` (which
        # the mobile "purge immediately" path uses) into a 24-hour
        # grace, so a user who asked to delete a report NOW would
        # actually wait a full day. `is None` is the correct null-
        # coalesce - 0 is a legitimate value meaning "no grace".
        grace = r.deletion_grace_minutes if r.deletion_grace_minutes is not None else 1440
        # Coerce to UTC safely regardless of whether the column returned
        # a naive datetime (SQLite behaviour - DateTime(timezone=True) is
        # advisory there, values come back without tzinfo) or a real
        # tz-aware datetime (Postgres). `.replace(tzinfo=utc)` on an
        # already-aware datetime OVERWRITES the offset without shifting
        # the wall-clock - which silently shifted the cutoff 5.5h into
        # the future on IST-defaulted Postgres servers. `.astimezone`
        # correctly converts; the naive-branch replacement assumes the
        # stored value is already UTC (matches how the column is written).
        raw = r.deletion_requested_at
        aware = raw.replace(tzinfo=timezone.utc) if raw.tzinfo is None else raw.astimezone(timezone.utc)
        cutoff = aware + timedelta(minutes=grace)
        if now >= cutoff:
            expired.append(r)
    if not expired:
        return 0

    # Local import so we don't shuffle the top-of-file block; matches the
    # pattern used by _get_reporter_credibility below.
    from app.models.report import ReporterProfile

    # Collect per-device decrements so we only touch each profile once.
    # Keyed by device_id; value is (report_count_delta, verified_count_delta).
    profile_decrements: dict = {}
    VERIFIED_STATUSES = {
        ReportStatusEnum.VERIFIED.value,
        ReportStatusEnum.RESPONDING.value,
        ReportStatusEnum.RESOLVED.value,
    }

    count = 0
    for report in expired:
        for m in report.media:
            for suffix in ['', '_partial', '_assembled']:
                for ext in ['jpg', 'webm', 'png']:
                    fpath = os.path.join(UPLOAD_DIR, f"{m.id}{suffix}.{ext}")
                    if os.path.exists(fpath):
                        try: os.remove(fpath)
                        except: pass
            if m.url and m.url.startswith("/static/"):
                disk_path = os.path.join(UPLOAD_DIR, m.url.replace("/static/", ""))
                if os.path.exists(disk_path):
                    try: os.remove(disk_path)
                    except: pass
        for prefix in ['sat_', 'sat_alt_']:
            for ext in ['png', 'jpg']:
                sat_path = os.path.join(UPLOAD_DIR, f"{prefix}{report.id}.{ext}")
                if os.path.exists(sat_path):
                    try: os.remove(sat_path)
                    except: pass

        # Accumulate counter decrements - look up the device hash before
        # we delete the row so we still have report.device.device_hash.
        device_hash = None
        try:
            if report.device_id:
                device = db.query(Device).filter(Device.id == report.device_id).first()
                device_hash = device.device_hash if device else None
        except Exception:
            device_hash = None
        if device_hash:
            status_val = report.status.value if hasattr(report.status, 'value') else str(report.status or '')
            delta_verified = 1 if status_val in VERIFIED_STATUSES else 0
            prev = profile_decrements.get(device_hash, (0, 0))
            profile_decrements[device_hash] = (prev[0] + 1, prev[1] + delta_verified)

        db.delete(report)
        count += 1

    # Apply the decrements. Clamp at 0 to defend against double-purges
    # or pre-existing drift in the counter.
    for device_hash, (r_delta, v_delta) in profile_decrements.items():
        profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
        if not profile:
            continue
        profile.report_count = max(0, (profile.report_count or 0) - r_delta)
        profile.verified_count = max(0, (profile.verified_count or 0) - v_delta)

    db.commit()
    if count > 0:
        logger.info(
            f"Purge: {count} expired deletion(s) permanently removed; "
            f"counters decremented for {len(profile_decrements)} device(s)"
        )
    return count


def _enforce_retention_policy(db: Session, batch_limit: int = 1000) -> int:
    """Mark reports whose retention window has expired for deletion.

    UNDP Privacy Policy §22-24 + Annex 2 (c): personal data is kept only as
    long as necessary. CRISP retains reports while the crisis response is
    active, then for `CRISP_RETENTION_AFTER_CLOSE_DAYS` (default 365) for
    audit/verification, then permanently deletes them. The window is anchored
    on:
      * the crisis's `ended_at` for reports tied to an ENDED CrisisEvent, OR
      * the report's own `server_created_at` for standalone reports.
    Reports tied to a LIVE/DRAFT crisis are NEVER touched (the response is
    still active).

    This does NOT hard-delete directly: it writes a DeletionAuditLog row and
    sets `deletion_requested_at = now`, `deletion_grace_minutes = 0`, so the
    proven `_purge_expired_deletions` sweep performs the actual hard-delete
    (media cleanup + counter decrement) on the same/next tick. One deletion
    code path, one audit trail.

    Set `CRISP_RETENTION_AFTER_CLOSE_DAYS = 0` to disable entirely.
    """
    from app.core.config import settings
    from app.models.report import CrisisEvent

    window_days = getattr(settings, "CRISP_RETENTION_AFTER_CLOSE_DAYS", 365)
    if not window_days or window_days <= 0:
        return 0  # retention sweep disabled

    now = datetime.now(timezone.utc)
    cutoff_ts = now - timedelta(days=window_days)

    # Query 1 - standalone reports (no crisis activation), anchored on
    # creation. server_created_at is indexed, so this is scale-safe.
    standalone = (
        db.query(Report)
        .filter(
            Report.crisis_event_id.is_(None),
            Report.deletion_requested_at.is_(None),
            Report.server_created_at <= cutoff_ts,
        )
        .limit(batch_limit)
        .all()
    )

    # Query 2 - reports tied to an ENDED crisis, anchored on the crisis's
    # close time (ended_at; fall back to updated_at if the operator ended it
    # without stamping a date).
    #
    # Gated by CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE (default True): an
    # operation's reports must survive its closure - an ENDED crisis becomes a
    # read-only historical record, not a delete trigger. With the flag set, this
    # query is skipped entirely; only standalone (no-crisis) reports above are
    # subject to the time-window sweep. Flip the flag to False to restore the
    # legacy purge-on-close behaviour.
    if getattr(settings, "CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE", True):
        ended_crisis = []
    else:
        ended_crisis = (
            db.query(Report)
            .join(CrisisEvent, Report.crisis_event_id == CrisisEvent.id)
            .filter(
                Report.deletion_requested_at.is_(None),
                CrisisEvent.status == "ENDED",
                sa_func.coalesce(CrisisEvent.ended_at, CrisisEvent.updated_at) <= cutoff_ts,
            )
            .limit(batch_limit)
            .all()
        )

    expired = {r.id: r for r in (standalone + ended_crisis)}.values()
    count = 0
    for report in expired:
        loc_snapshot = None
        if report.location:
            loc_snapshot = {
                "lat": report.location.latitude,
                "lng": report.location.longitude,
                "name": report.location.device_location_name or report.location.user_location_name,
            }
        db.add(DeletionAuditLog(
            report_id=report.id,
            device_hash=report.device.device_hash if report.device else None,
            location_snapshot=loc_snapshot,
            damage_type=report.infrastructure_type.value if report.infrastructure_type else None,
            severity=report.severity.value if report.severity else None,
            deletion_source="RETENTION",
        ))
        report.deletion_requested_at = now
        report.deletion_grace_minutes = 0  # purge on the next sweep tick
        count += 1

    if count:
        db.commit()
        logger.info(f"Retention: marked {count} report(s) past the {window_days}-day window for purge")
    return count


def _require_purge_auth(request: Request, user=Depends(require_super_admin)):
    """Hard-purge is IRREVERSIBLE, so it requires an authenticated SUPER_ADMIN
    PLUS a fresh step-up (TOTP / password re-auth, ~10-min window) presented as
    the X-Step-Up header (see POST /auth/step-up). Replaces the old shared static
    CRISP_ADMIN_KEY + browser prompt - this is per-user, time-boxed, and auditable."""
    from app.core.security import decode_token
    from jwt import PyJWTError as JWTError  # May 2026: jose -> PyJWT (CVE closure)
    token = request.headers.get("X-Step-Up", "")
    if not token:
        raise HTTPException(status_code=401,
            detail="Step-up confirmation required - re-confirm with your authenticator code to purge.")
    try:
        payload = decode_token(token)
    except JWTError:
        raise HTTPException(status_code=401,
            detail="Step-up confirmation expired or invalid - please re-confirm.")
    if payload.get("type") != "step_up" or payload.get("sub") != user.id:
        raise HTTPException(status_code=401, detail="Step-up token does not authorize this action.")
    # PRODUCTION: require a TIME-BASED authenticator (TOTP) re-auth - a reused
    # password is weaker than a 30-second time-based factor for an irreversible
    # purge. Dev/CI may use the mock/password methods. (Defense-in-depth: the
    # step-up endpoint already rejects password in prod.)
    import os
    if os.getenv("APP_ENV", "production").lower() == "production" and payload.get("method") != "totp":
        raise HTTPException(status_code=403,
            detail="Purge requires confirmation with your time-based authenticator (TOTP).")
    return user


@router.post("/purge-expired", status_code=status.HTTP_200_OK)
def purge_expired_deletions(user=Depends(_require_purge_auth), db: Session = Depends(get_db)):
    """Admin endpoint: permanently delete all reports past the 24-hour grace
    period. Retention-policy enforcement runs on the scheduled background
    sweep (see app.main._purge_loop), not here, so this endpoint's contract
    stays a pure grace-purge trigger. Gated by SUPER_ADMIN + a fresh step-up."""
    count = _purge_expired_deletions(db)
    return {"purged": count}


@router.post("/purge-all-pending", status_code=status.HTTP_200_OK)
def purge_all_pending_deletions(user=Depends(_require_purge_auth), db: Session = Depends(get_db)):
    """Admin endpoint: permanently delete ALL reports with deletion_requested_at set,
    regardless of whether the 24-hour grace period has passed. Gated by
    SUPER_ADMIN + a fresh step-up (X-Step-Up)."""
    pending = db.query(Report).filter(Report.deletion_requested_at != None).all()
    if not pending:
        return {"purged": 0}
    count = 0
    for report in pending:
        for m in report.media:
            for suffix in ['', '_partial', '_assembled']:
                for ext in ['jpg', 'webm', 'png']:
                    fpath = os.path.join(UPLOAD_DIR, f"{m.id}{suffix}.{ext}")
                    if os.path.exists(fpath):
                        try: os.remove(fpath)
                        except: pass
            if m.url and m.url.startswith("/static/"):
                disk_path = os.path.join(UPLOAD_DIR, m.url.replace("/static/", ""))
                if os.path.exists(disk_path):
                    try: os.remove(disk_path)
                    except: pass
        for prefix in ['sat_', 'sat_alt_']:
            for ext in ['png', 'jpg']:
                sat_path = os.path.join(UPLOAD_DIR, f"{prefix}{report.id}.{ext}")
                if os.path.exists(sat_path):
                    try: os.remove(sat_path)
                    except: pass
        db.delete(report)
        count += 1
    db.commit()
    logger.info(f"Force purge: {count} pending deletion(s) permanently removed")
    return {"purged": count}


# ── Progressive Upload: Stage 1 - metadata only (tiny, instant) ───────────────
def _optional_user_from_auth(request: Request, db: Session):
    """Phase 1 (Apr 2026 - Optional reporter login) - extract the
    authenticated user from a Bearer token IF one is present, return
    None otherwise. Never raises: an expired / invalid token silently
    falls back to anonymous submission (crisis-reporting posture - we
    ALWAYS accept the report, even if we can't attribute it).

    K.2.e (May 2026, Phase K) - now returns a 2-tuple (user, downgrade_reason)
    so the caller can distinguish:
      - (None, None)          - no auth header (genuine anonymous)
      - (None, 'expired_token') - Bearer token sent but expired beyond grace.
                                  Caller stamps Report.submitted_as_anonymous_due_to_expired_token
                                  so the dashboard surfaces "Attribution lost" chip.
      - (None, 'invalid_token') - Bearer token sent but malformed / not-a-real-user.
                                  Also anonymous, also flagged.
      - (User, None)          - happy path.
    """
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth or not auth.lower().startswith("bearer "):
        return None, None  # no header → genuine anonymous
    parts = auth.split(None, 1)
    if len(parts) < 2:
        return None, None  # "Bearer" alone with no token → no auth attempt
    token = parts[1].strip()
    if not token:
        return None, None  # malformed header without payload → treat as no auth

    try:
        from app.core.security import decode_token
        import jwt as _jwt
        try:
            payload = decode_token(token)
        except _jwt.ExpiredSignatureError:
            return None, 'expired_token'
        except _jwt.PyJWTError:
            return None, 'invalid_token'
        if not payload:
            return None, 'invalid_token'
        user_id = payload.get("sub") or payload.get("user_id")
        if not user_id:
            return None, 'invalid_token'
        from app.models.auth import User as _User
        user = db.query(_User).filter(_User.id == user_id).first()
        if not user or not user.is_active:
            # Token valid but the user is deactivated / deleted →
            # attribution effectively lost. Flag for operator visibility.
            return None, 'invalid_token'
        return user, None
    except Exception:
        # Any unexpected failure → treat as expired-token (visible flag
        # is better than silent anonymous). Never raises 401.
        return None, 'invalid_token'


@router.post("/meta", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report_meta(meta_in: ReportMetaCreate, request: Request, db: Session = Depends(get_db)):
    """
    Stage 1 of progressive upload: Accept metadata only (< 1KB).
    Creates a PARTIAL report immediately. Media follows via PATCH.

    Phase 1 (Apr 2026 - Optional reporter login): if the caller sends
    an `Authorization: Bearer <token>` header AND the token is valid,
    the created row is decorated with `user_id`. Invalid/expired tokens
    are silently ignored - the report still lands as anonymous.
    """
    auth_user, _auth_downgrade_reason = _optional_user_from_auth(request, db)
    # Rate limit: 30 reports/min per device
    from app.main import check_rate_limit
    if not check_rate_limit(f"meta:{meta_in.device_hash}", 30, 60):
        raise HTTPException(status_code=429, detail="Rate limit exceeded - try again later")

    # Idempotency + collision detection (P1.6).
    # Same-device retry must return the existing Report (idempotent). A
    # different-device collision - astronomically rare with UUID-v4 but
    # possible with short device-side IDs - is a potential data-loss path:
    # device B's submission would be silently discarded and its media
    # chunks redirected to device A's Report. Guard with a 409 so the
    # client regenerates its UUID and retries.
    if meta_in.client_report_id:
        existing = db.query(Report).filter(
            Report.client_report_id == meta_in.client_report_id
        ).first()
        if existing:
            # Resolve the requesting device first so we can compare.
            req_device = db.query(Device).filter(Device.device_hash == meta_in.device_hash).first()
            existing_owner_hash = None
            if existing.device_id:
                _dev = db.query(Device).filter(Device.id == existing.device_id).first()
                existing_owner_hash = _dev.device_hash if _dev else None
            # Same device → idempotent replay, normal retry path.
            if existing_owner_hash and existing_owner_hash == meta_in.device_hash:
                logger.info(f"Meta idempotent hit: {meta_in.client_report_id}")
                return existing
            # Different device → collision. Reject so client retries with a new id.
            logger.warning(
                f"client_report_id collision {meta_in.client_report_id} "
                f"(existing owner {existing_owner_hash}, new {meta_in.device_hash})"
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "client_report_id_conflict",
                    "message": "client_report_id already used by a different device - regenerate and retry",
                    "existing_report_id": existing.id,
                }
            )

    # Device resolution
    device = db.query(Device).filter(Device.device_hash == meta_in.device_hash).first()
    if not device:
        device = Device(device_hash=meta_in.device_hash)
        db.add(device)
        db.commit()
        db.refresh(device)

    # Determine sync status based on whether media is expected
    sync = SyncStatusEnum.PARTIAL if meta_in.expected_media > 0 else SyncStatusEnum.SYNCED

    # Create report
    # Crisis-form fields are excluded here and re-added ONLY after server-side
    # validation below (so a client can't write arbitrary form_data / a mismatched
    # version straight into the row).
    report_dict = meta_in.model_dump(exclude={
        "location", "device_hash",
        "crisis_event_id", "form_pack_id", "form_pack_version", "form_data",
    })
    # UNDP must-have #6 - pre-create the parent `buildings` row for any
    # PWA-supplied OSM footprint so the FK on the subsequent report INSERT
    # is satisfied. Without this, a fresh DB (or any client that taps a
    # building not yet mirrored into `buildings`) trips
    # `fk_reports_building_id` and 500s the entire submission. The FK forces us
    # to drop the building_id on upsert failure (we can't reference a row that
    # doesn't exist) — but we KEEP infrastructure_name_from_osm=true: the reporter
    # DID tap a real OSM footprint, so once _auto_assign_building_id (below) links
    # this report to a proximity building the dashboard can still show its real
    # name. (Previously we also reset from_osm=False here, which permanently
    # demoted an explicit "University" tag to "Unnamed Building" on a transient
    # buildings-row upsert hiccup.)
    if report_dict.get("building_id"):
        resolved_bid = _ensure_building_for_pwa_pick(
            db,
            report_dict["building_id"],
            osm_name=(
                report_dict.get("infrastructure_name")
                if report_dict.get("infrastructure_name_from_osm")
                else None
            ),
        )
        if resolved_bid is None:
            report_dict["building_id"] = None   # FK-forced; keep the from_osm provenance
    # Phase 1: attach user_id if the
    # client presented a valid Bearer token. Anonymous path leaves it NULL.
    extra_cols = {}
    if auth_user is not None:
        extra_cols["user_id"] = auth_user.id
    # K.2.e (May 2026, Phase K) - stamp the "lost attribution" flag
    # when the caller presented a Bearer token but it had expired or
    # was invalid. The report is still accepted (UNDP must-have #9 -
    # anonymous submission always works) but the flag surfaces via
    # the K.5.a dashboard chip so operators / the reporter can know.
    if _auth_downgrade_reason == 'expired_token':
        extra_cols["submitted_as_anonymous_due_to_expired_token"] = True
        # K.6.c - surface field-wide token-expiry rate. Operator
        # alert fires at > 5%/h, indicating reporter-side auth-TTL
        # is too short for typical capture → drain windows.
        try:
            from app.core.observability import (
                report_submitted_anonymous_due_to_expired_token_total,
            )
            report_submitted_anonymous_due_to_expired_token_total.inc()
        except Exception:
            pass
        logger.info(
            f"meta create - accepted as anonymous due to expired Bearer "
            f"token (device={meta_in.device_hash[:12]}, "
            f"client_report_id={meta_in.client_report_id})"
        )
    # ── Dynamic Crisis Forms (additive, validated-before-insert) ──────────────
    # Runs ONLY when the client submitted a form_pack_id (report captured inside an
    # active crisis zone). Default submissions skip this block entirely → row shape
    # + behaviour unchanged (multi-channel parity #1). The server re-validates the
    # answers against the captured pack version FOR THIS CHANNEL; on failure → 422
    # BEFORE any DB write (no orphan row). Unknown/unpublished pack → fail-safe:
    # crisis fields are dropped and the report is stored as a standard report.
    if meta_in.form_pack_id:
        from app.models.report import CrisisFormPack, CrisisFormPackVersion, CrisisEvent
        from app.services.crisis_form_schema import validate_submission
        from app.api.endpoints.crisis_forms import resolve_active_event
        pack_ver = None
        if meta_in.form_pack_version:
            pack_ver = (db.query(CrisisFormPackVersion)
                        .filter(CrisisFormPackVersion.pack_id == meta_in.form_pack_id,
                                CrisisFormPackVersion.version == meta_in.form_pack_version)
                        .first())
        if pack_ver is None:
            _pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == meta_in.form_pack_id).first()
            if _pack and _pack.active_version:
                pack_ver = (db.query(CrisisFormPackVersion)
                            .filter(CrisisFormPackVersion.pack_id == _pack.id,
                                    CrisisFormPackVersion.version == _pack.active_version)
                            .first())
        if pack_ver is not None:
            _fd, _fc, _errs = validate_submission(
                pack_ver.schema_json, meta_in.form_data or {}, meta_in.source.value)
            if _errs:
                raise HTTPException(status_code=422, detail={"crisis_form_errors": _errs})
            # Derive the owning CrisisEvent SERVER-SIDE - never blind-trust the
            # client's crisis_event_id. A pack can be reused across events (no
            # uniqueness on CrisisEvent.form_pack_id), so form_pack_id alone can't
            # identify the event. Resolution order:
            #   1. Verify the client-echoed event_id actually owns this pack - the
            #      client got the (event, pack) pair atomically from /active, so a
            #      cheap PK lookup + ownership check is authoritative.
            #   2. Else re-resolve from the submitted location via the SAME matcher
            #      /active uses (covers GPS chat channels that send only the pack,
            #      and self-heals a stale /active cache), accepting only a match
            #      whose pack equals the answered pack.
            #   3. Else NULL - a validated form with no resolvable active owner
            #      degrades to a standard report (multi-channel parity #1).
            owning_event = None
            if meta_in.crisis_event_id:
                _ev = (db.query(CrisisEvent)
                       .filter(CrisisEvent.id == meta_in.crisis_event_id).first())
                if _ev and _ev.form_pack_id == meta_in.form_pack_id:
                    owning_event = _ev
            if owning_event is None and meta_in.location:
                _lat = getattr(meta_in.location, "latitude", None)
                _lng = getattr(meta_in.location, "longitude", None)
                if _lat is not None and _lng is not None:
                    _match = resolve_active_event(db, _lat, _lng, datetime.now(timezone.utc))
                    if _match and _match[1].id == meta_in.form_pack_id:
                        owning_event = _match[0]
            report_dict["crisis_event_id"] = owning_event.id if owning_event else None
            report_dict["form_pack_id"] = meta_in.form_pack_id
            report_dict["form_pack_version"] = pack_ver.version
            report_dict["form_data"] = _fd or None
            report_dict.update(_fc)   # canonical column overrides (enum-guarded by the validator)
    elif meta_in.crisis_event_id and meta_in.location:
        # Operation linkage WITHOUT a form pack - for GPS-capable channels that
        # resolve the active zone but don't render the dynamic Stage 2/3 pack
        # (Telegram / WhatsApp share a precise location, call /crisis-forms/active,
        # and echo the event id). They send NO form_pack_id, so no form validation
        # runs (sending an unfilled pack would 422 on required fields). The server
        # RE-DERIVES crisis_event_id from the submitted location - the client hint
        # only opts the report in; location is authoritative. Channels that never
        # resolve a zone (SMS / IVR - coarse text/audio geocoding, no fake-matching)
        # omit the hint and stay GLOBAL (crisis_event_id NULL).
        from app.api.endpoints.crisis_forms import resolve_active_event
        _lat = getattr(meta_in.location, "latitude", None)
        _lng = getattr(meta_in.location, "longitude", None)
        if _lat is not None and _lng is not None:
            _match = resolve_active_event(db, _lat, _lng, datetime.now(timezone.utc))
            if _match:
                report_dict["crisis_event_id"] = _match[0].id

    db_report = Report(
        **report_dict,
        device_id=device.id,
        received_media=0,
        sync_status=sync,
        **extra_cols,
    )
    db.add(db_report)
    db.commit()
    db.refresh(db_report)

    # Attach location
    if meta_in.location:
        loc_data = meta_in.location.model_dump()
        # HC55 - server-side forward-geocoding now routes through
        # _resolve_user_location_name(), which uses the same Mapbox →
        # rate-limited Nominatim cascade as /geocode/describe. The
        # previous inline Nominatim hit (no UA, no throttle, no Mapbox
        # primary) violated the upstream usage policy.
        if (loc_data.get('user_location_name')
                and loc_data.get('latitude', 0) == 0
                and loc_data.get('longitude', 0) == 0):
            _resolve_user_location_name(loc_data)
        db_loc = Location(**loc_data, report_id=db_report.id)
        db.add(db_loc)
        db.commit()

    # Auto-assign building_id for deduplication/versioning
    _auto_assign_building_id(db_report, db)
    # Building-centric Incident-Feed redesign Phase 2B - assign the report to its
    # operational incident (JOIN on HIGH confidence, else SEED a new one). Runs
    # here, in the shared meta path, so EVERY channel's report gets an incident
    # (must-have #1). Best-effort (savepoint-isolated): never blocks the write.
    _assign_incident(db_report, db)
    # Update reporter gamification profile
    _update_reporter_profile(meta_in.device_hash, db)

    # Phase 3 (May 2026, docs §6.1 + §6.2) - sync trust-score updates.
    # Run BEFORE the final commit so the device's spam_score change
    # lands in the same txn as the report. Both helpers are best-
    # effort + swallow their own errors - they can never block a
    # legitimate user submission.
    from app.services import fraud_detector as _fraud
    _fraud.increment_reports_count(db, db_report.device_id)
    if meta_in.location and (
        meta_in.location.latitude or meta_in.location.longitude
    ):
        _fraud.evaluate_submission(
            db,
            device_id=db_report.device_id,
            lat=meta_in.location.latitude,
            lng=meta_in.location.longitude,
            ts=db_report.server_created_at,
        )

    db.commit()
    logger.info(f"Report meta created: {db_report.id} (expecting {meta_in.expected_media} media)")
    db.refresh(db_report)
    return db_report


@router.patch("/{report_id}/description", response_model=ReportResponse)
def update_report_description(report_id: str, desc_in: ReportDescriptionUpdate, request: Request, user=Depends(get_optional_user), db: Session = Depends(get_db)):
    """
    Stage 2 of progressive upload: Update the text description/transcript.
    This is split from Stage 1 (meta) to keep the initial packet under 1KB.
    """
    _report_mutate_rate_limit(request)
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _authorize_report_mutation(report, request, db, user, getattr(desc_in, "device_hash", None))

    report.description = desc_in.description
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report.id} description updated ({len(desc_in.description)} chars)")
    return report


@router.patch("/{report_id}/classify", response_model=ReportResponse)
def update_report_classification(report_id: str, request: dict, http_request: Request, user=Depends(get_optional_user), db: Session = Depends(get_db)):
    """Update severity and/or infrastructure_type on an existing report.
    Used by Telegram/WhatsApp bots to update classification after initial creation."""
    from app.models.report import SeverityEnum, InfraTypeEnum
    _report_mutate_rate_limit(http_request)
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _authorize_report_mutation(report, http_request, db, user, request.get("device_hash"))
    if "severity" in request:
        try:
            report.severity = SeverityEnum(request["severity"])
        except ValueError:
            pass
    if "infrastructure_type" in request:
        try:
            report.infrastructure_type = InfraTypeEnum(request["infrastructure_type"])
        except ValueError:
            pass
    if "description" in request and request["description"]:
        report.description = request["description"]
    # UNDP extended fields
    if "damage_classification" in request and request["damage_classification"]:
        report.damage_classification = request["damage_classification"]
    if "crisis_type" in request and request["crisis_type"]:
        report.crisis_type = _normalize_crisis_type(request["crisis_type"])
    if "infrastructure_name" in request and request["infrastructure_name"]:
        report.infrastructure_name = request["infrastructure_name"]
    # channel bots (Telegram/WhatsApp/SMS) that
    # prompted the reporter to type the building name in their native
    # language tag the classify call with `infrastructure_name_from_osm:
    # False`. Dashboard flags these rows for manual OSM mapping. Accept
    # explicit False (user typed) and explicit True (future: a channel bot
    # that has an OSM-backed picker); skip the field entirely when the
    # client doesn't specify it so back-compat clients aren't forced to
    # volunteer an answer.
    if "infrastructure_name_from_osm" in request and request["infrastructure_name_from_osm"] is not None:
        report.infrastructure_name_from_osm = bool(request["infrastructure_name_from_osm"])
    if "debris_clearing_needed" in request and request["debris_clearing_needed"] is not None:
        report.debris_clearing_needed = request["debris_clearing_needed"]
    if "service_status" in request and request["service_status"]:
        report.service_status = request["service_status"]
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report.id} classified: sev={report.severity.value} type={report.infrastructure_type.value}")
    return report


@router.post("/geocode/describe")
async def geocode_from_description(payload: dict):
    """Resolve a free-text location description to lat/lng + place name.

    Called by the PWA / RN app when GPS lock fails - the user gets a
    "describe your location" text box as the graceful fallback, and
    this endpoint pipes the result through the same multi-layer
    geocoder (Claude Haiku → Mapbox → Nominatim) the IVR + SMS channels
    already use. Adds w3w if the caller supplies ``include_w3w=true``
    and ``W3W_API_KEY`` is configured.

    Body:
        {
            "text":          "near the big mosque in Koramangala 5th block",
            "country_hint":  "India"  (optional, helps scope fuzzy matches),
            "language":      "ar"     (optional, ISO 639-1 - UNDP §3.1f.5),
            "include_w3w":   true      (optional)
        }

    Response:
        {
            "latitude":       12.9352,
            "longitude":      77.6245,
            "location_name":  "Koramangala, Bengaluru, Karnataka",
            "confidence":     "medium",
            "source":         "mapbox",
            "w3w":            "///example.example.example" | null
        }
    """
    # Lazy import so unit tests that don't exercise this endpoint don't
    # pay the httpx + tokeniser init cost. `messaging_bot` is a symlink
    # inside `backend/` that points at `messaging-bot/` so the hyphenated
    # directory name is reachable as a valid Python package.
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    from messaging_bot.sms.geocoder import geocode_text, _normalise_language

    text = str(payload.get("text", "")).strip()
    if not text or len(text) < 3:
        raise HTTPException(
            status_code=400,
            detail={"code": "text_too_short",
                    "message": "Provide ≥ 3 characters of location description."},
        )
    country_hint = str(payload.get("country_hint", "India")).strip() or "India"
    # UNDP §3.1f.5. Caller passes the active UI locale so the
    # geocoder echoes place names in the same script (e.g. Arabic place
    # names in Arabic instead of Latin transliteration).
    language = _normalise_language(str(payload.get("language", "en")))

    result = await geocode_text(text, country_hint=country_hint, language=language)

    # Optional what3words enrichment. Only resolves if the caller opted in
    # AND the operator supplied W3W_API_KEY - otherwise the field is null
    # (no cost, no leakage of the raw text to a 3rd-party API).
    w3w = None
    if payload.get("include_w3w") and result.get("latitude"):
        w3w_key = os.getenv("W3W_API_KEY", "").strip()
        if w3w_key:
            try:
                async with httpx.AsyncClient(timeout=6) as c:
                    w3w_res = await c.get(
                        "https://api.what3words.com/v3/convert-to-3wa",
                        params={
                            "coordinates": f"{result['latitude']},{result['longitude']}",
                            "key": w3w_key,
                            "language": language,
                        },
                    )
                    if w3w_res.status_code == 200:
                        words = (w3w_res.json() or {}).get("words")
                        if words:
                            w3w = f"///{words}"
            except Exception as exc:
                logger.warning(f"w3w lookup failed: {exc}")

    return {**result, "w3w": w3w}


@router.post("/geocode/reverse")
async def reverse_geocode(payload: dict, db: Session = Depends(get_db)):
    """Reverse geocode lat/lng → place name.

    HC55 (May 2026) - closes the production-grade gap the operator's
    2026-05-24 HAR exposed: the PWA was calling
    ``https://nominatim.openstreetmap.org/reverse`` directly from the
    browser and getting 429-rate-limited (every "Refresh GPS" tap fell
    back to raw lat/lng on the UI). This route routes the call through
    the same backend cascade IVR + SMS already use (Mapbox →
    rate-limited Nominatim → coords-only fallback) and caches every
    successful resolution in ``geocode_cache`` keyed by rounded coord +
    language for 7 days.

    Body:
        {
            "lat":      12.852765,    (required, -90..90)
            "lng":      77.679423,    (required, -180..180)
            "language": "en"          (optional, ISO 639-1 - UNDP §3.1f.5)
        }

    Response:
        {
            "location_name":  "Koramangala, Bengaluru",
            "confidence":     "high" | "medium" | "low" | "none",
            "source":         "mapbox" | "nominatim" | "cache" | "fallback",
            "latitude":       12.852765,
            "longitude":      77.679423
        }

    The response shape is uniform - even when both upstream providers
    fail, the route returns a synthetic "12.85°, 77.68°" location_name
    with ``source: "fallback"`` so the PWA never has to special-case
    null returns.
    """
    # Lazy import - symlink-package pattern (see /geocode/describe).
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    from messaging_bot.sms.geocoder import reverse_geocode_coords

    raw_lat = payload.get("lat")
    raw_lng = payload.get("lng")
    if raw_lat is None or raw_lng is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "missing_coords",
                    "message": "Both 'lat' and 'lng' are required."},
        )
    try:
        lat = float(raw_lat)
        lng = float(raw_lng)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_coords_type",
                    "message": "'lat' and 'lng' must be numbers."},
        )
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_coords_range",
                    "message": "lat must be in [-90,90]; lng in [-180,180]."},
        )

    language = str(payload.get("language", "en"))
    return await reverse_geocode_coords(lat, lng, language=language, db=db)


@router.patch("/{report_id}/location", response_model=ReportResponse)
def update_report_location(report_id: str, loc_data: dict, request: Request, user=Depends(get_optional_user), db: Session = Depends(get_db)):
    """Add or update location on an existing report.

    Used by the AI extractor to backfill coords from IVR/SMS traffic (no
    ``is_user_corrected`` flag → stays False, matching bot-authored data),
    AND by the dashboard's "pin correction" UI to let an analyst move the
    marker. Dashboard callers pass ``is_user_corrected: true`` so the row
    is clearly attributable to a human vs a geocoder.

    Operation re-evaluation: when ``reresolve_operation: true`` is passed, the
    EDITED location is treated as authoritative and the report's owning
    operation (``crisis_event_id``) is RE-DERIVED from the new coords via the
    SAME smallest-radius matcher /crisis-forms/active + intake use - so a
    corrected pin re-homes the report to the operation containing it, or clears
    the link when it leaves every active zone. Precise-GPS channels opt in
    (Telegram / WhatsApp / dashboard pin-correction). AI/SMS/IVR backfill OMITS
    the flag, so ``crisis_event_id`` is untouched - coarse text/audio geocoding
    stays GLOBAL by design (no fake-matching).
    """
    _report_mutate_rate_limit(request)
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    _authorize_report_mutation(report, request, db, user, loc_data.get("device_hash"))
    if report.location:
        # Update existing
        report.location.latitude = loc_data.get("latitude", report.location.latitude)
        report.location.longitude = loc_data.get("longitude", report.location.longitude)
        report.location.device_latitude = loc_data.get("device_latitude", report.location.device_latitude)
        report.location.device_longitude = loc_data.get("device_longitude", report.location.device_longitude)
        report.location.accuracy_meters = loc_data.get("accuracy_meters", report.location.accuracy_meters)
        report.location.device_location_name = loc_data.get("device_location_name", report.location.device_location_name)
        if "is_user_corrected" in loc_data:
            report.location.is_user_corrected = bool(loc_data["is_user_corrected"])
    else:
        # Create new
        db.add(Location(
            report_id=report_id,
            latitude=loc_data.get("latitude", 0),
            longitude=loc_data.get("longitude", 0),
            device_latitude=loc_data.get("device_latitude"),
            device_longitude=loc_data.get("device_longitude"),
            accuracy_meters=loc_data.get("accuracy_meters", 5000),
            device_location_name=loc_data.get("device_location_name"),
            is_user_corrected=bool(loc_data.get("is_user_corrected", False)),
        ))
    # Re-evaluate operation assignment from the EDITED coords (opt-in).
    if loc_data.get("reresolve_operation"):
        from app.api.endpoints.crisis_forms import resolve_active_event
        _lat = loc_data.get("latitude", report.location.latitude if report.location else None)
        _lng = loc_data.get("longitude", report.location.longitude if report.location else None)
        if _lat is not None and _lng is not None:
            _match = resolve_active_event(db, _lat, _lng, datetime.now(timezone.utc))
            report.crisis_event_id = _match[0].id if _match else None
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report_id} location updated: {loc_data.get('device_location_name', 'coords only')}")
    return report


# ── Intelligence Data Enrichment Functions ──────────────────────────────────

def _get_reporter_credibility(device_hash: str, db: Session) -> dict:
    """Build reporter credibility profile from ReporterProfile + report history."""
    from app.models.report import ReporterProfile, ReportStatusEnum
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        return {"badge_level": "NEWCOMER", "total_reports": 0, "verified_reports": 0,
                "false_alarm_rate": 0, "credibility_score": 50}
    total = profile.report_count or 1
    device = db.query(Device).filter(Device.device_hash == device_hash).first()
    false_count = 0
    verified_count = 0
    if device:
        all_reps = db.query(Report).filter(Report.device_id == device.id, Report.deletion_requested_at.is_(None)).all()
        false_count = sum(1 for r in all_reps if r.status == ReportStatusEnum.FALSE_ALARM)
        # P1-2: "verified" here now means analyst-ACCEPTED (reviewer_verdict),
        # the SAME definition Building.verified_report_count + the global
        # distributions.verified already use. It was status-based
        # (RESPONDING/RESOLVED), which silently disagreed with every other
        # "verified" surface. NOTE: ReporterProfile.verified_count is a separate
        # reporter-ENGAGEMENT counter (reports that got actioned/dispatched) and
        # is intentionally NOT this number.
        verified_count = sum(1 for r in all_reps if (r.reviewer_verdict or "") == "ACCEPTED")
    false_rate = round((false_count / max(total, 1)) * 100, 1)
    # Map the LIVE reporter-tier ladder. The legacy HERO/GUARDIAN/HELPER keys
    # were dead (the ladder is T1_SCOUT/T2_SIGNAL/T3_CHANGEMAKER/T4_LIFEKEEPER),
    # so EVERY reporter fell to the 50 default and the badge weighting never
    # fired (audit A5). NEWCOMER kept as the no-profile fallback.
    base = {"T4_LIFEKEEPER": 95, "T3_CHANGEMAKER": 85, "T2_SIGNAL": 70,
            "T1_SCOUT": 55, "NEWCOMER": 50}.get(profile.badge_level, 50)
    cred = max(10, base - int(false_rate * 0.5))
    return {"badge_level": profile.badge_level, "total_reports": total,
            "verified_reports": verified_count, "false_alarm_rate": false_rate, "credibility_score": cred}


def _get_corroboration(report: Report, db: Session) -> dict:
    """Quality-weighted corroboration from nearby reports."""
    if not report.location:
        return {"nearby_total": 0, "nearby_verified": 0, "nearby_same_type": 0,
                "source_diversity": 0, "strongest_score": 0, "temporal_cluster": False, "details": []}
    lat, lng = report.location.latitude, report.location.longitude
    from math import radians, cos, sin, sqrt, atan2
    from datetime import timedelta
    def hav(la1, lo1, la2, lo2):
        R = 6371000
        d1, d2 = radians(la2 - la1), radians(lo2 - lo1)
        a = sin(d1/2)**2 + cos(radians(la1)) * cos(radians(la2)) * sin(d2/2)**2
        return R * 2 * atan2(sqrt(a), sqrt(1-a))

    nearby = db.query(Report).join(Location).filter(
        Report.id != report.id, Report.deletion_requested_at.is_(None),
        Location.latitude.between(lat - 0.05, lat + 0.05),
        Location.longitude.between(lng - 0.05, lng + 0.05),
    ).all()
    result = []
    sources = set()
    two_hr_count = 0
    for n in nearby:
        if not n.location:
            continue
        dist = hav(lat, lng, n.location.latitude, n.location.longitude)
        if dist > 5000:
            continue
        v_score = n.verification.total_score if n.verification else 0
        gap = abs((report.server_created_at - n.server_created_at).total_seconds() / 3600) if report.server_created_at and n.server_created_at else 999
        if gap <= 2:
            two_hr_count += 1
        sources.add(n.source.value if n.source else "APP")
        result.append({
            "dist_m": int(dist), "type": n.infrastructure_type.value if n.infrastructure_type else "OTHER",
            "same_type": n.infrastructure_type == report.infrastructure_type,
            "crisis": n.crisis_type or "", "severity": n.severity.value if n.severity else "UNKNOWN",
            "source": n.source.value if n.source else "APP",
            "v_score": v_score, "hours_ago": round(gap, 1),
            "has_photo": any(m.type.value == "IMAGE" and m.assembly_status == "complete" for m in n.media) if n.media else False,
        })
    result.sort(key=lambda x: x["dist_m"])
    return {
        "nearby_total": len(result), "nearby_verified": sum(1 for r in result if r["v_score"] > 60),
        "nearby_same_type": sum(1 for r in result if r["same_type"]),
        "source_diversity": len(sources), "strongest_score": max((r["v_score"] for r in result), default=0),
        "temporal_cluster": two_hr_count >= 2, "details": result[:5],
    }


def _get_historical(report: Report, db: Session) -> dict:
    """Historical context from the same area over the past 90 days."""
    if not report.location:
        return {"past_30d": 0, "past_90d": 0, "false_alarm_rate": 0,
                "recurring": False, "past_crisis_types": [], "past_avg_severity": "UNKNOWN"}
    from datetime import datetime, timedelta, timezone
    lat, lng = report.location.latitude, report.location.longitude
    now = report.server_created_at or datetime.now(timezone.utc)
    if hasattr(now, 'tzinfo') and now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff_90 = now - timedelta(days=90)
    past_90 = db.query(Report).join(Location).filter(
        Report.id != report.id, Report.deletion_requested_at.is_(None),
        Location.latitude.between(lat - 0.05, lat + 0.05),
        Location.longitude.between(lng - 0.05, lng + 0.05),
        Report.server_created_at >= cutoff_90,
    ).all()
    past_30 = [r for r in past_90 if r.server_created_at and abs((now - (r.server_created_at.replace(tzinfo=timezone.utc) if r.server_created_at.tzinfo is None else r.server_created_at)).days) <= 30]
    false_count = sum(1 for r in past_90 if r.status == ReportStatusEnum.FALSE_ALARM)
    crisis_set = set(r.crisis_type for r in past_90 if r.crisis_type)
    sev_map = {"CRITICAL": 4, "SEVERE": 3, "MODERATE": 2, "MINOR": 1, "UNKNOWN": 0}
    avg_sev = sum(sev_map.get(r.severity.value, 0) for r in past_90) / max(len(past_90), 1)
    avg_label = "CRITICAL" if avg_sev >= 3.5 else "SEVERE" if avg_sev >= 2.5 else "MODERATE" if avg_sev >= 1.5 else "MINOR"
    return {
        "past_30d": len(past_30), "past_90d": len(past_90),
        "false_alarm_rate": round((false_count / max(len(past_90), 1)) * 100, 1),
        "recurring": len(past_90) >= 3, "past_crisis_types": list(crisis_set),
        "past_avg_severity": avg_label,
    }


CRITICALITY = {"HOSPITAL": "CRITICAL", "WATER": "CRITICAL", "POWER": "HIGH", "GOVERNMENT": "HIGH",
               "TELECOM": "HIGH", "ROAD": "MEDIUM", "SCHOOL": "MEDIUM", "HOUSE": "STANDARD", "OTHER": "STANDARD"}


@router.post("/{report_id}/ai-assess")
async def ai_assess_report(
    report_id: str,
    payload: dict,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
    force: bool = Query(
        False,
        description=(
            "Bypass the per-report cache and force a fresh Claude call. "
            "Useful when the report has been re-classified or new media "
            "has been attached since the cached assessment was computed."
        ),
    ),
):
    """Multi-signal intelligence assessment: builds 360° dossier and sends to Claude for analysis.

    Phase 3.3 (May 2026) - Idempotent by report id. The endpoint
    re-uses ``report.ai_assessment`` if it's already populated;
    repeated dashboard clicks (two analysts hitting "Credibility
    Check" in parallel, the dashboard's auto-refresh re-rendering
    on every poll) no longer re-bill Claude.

    Cache miss: a fresh Claude call is made and the result is
    persisted. The response shape is unchanged from the pre-Phase-
    3.3 implementation EXCEPT a new ``_cached: bool`` field is
    added at the top level so the dashboard can surface "cached
    from <timestamp>" without an extra round-trip.

    Cache bypass: pass ``?force=true`` to ignore the cache. The
    dashboard's reviewer-workflow "Re-run AI" button should set
    this flag. Cost is bounded by analyst headcount - only
    explicit force-clicks re-bill.
    """
    import httpx
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # ── Cache check (Phase 3.3) ──────────────────────────────────────
    # Re-use a previously-computed assessment unless `force=true`.
    # We treat any non-empty dict on `report.ai_assessment` as a hit;
    # the runtime accepts whatever shape Claude returned (the dashboard
    # tolerates missing keys gracefully).
    if not force and isinstance(report.ai_assessment, dict) and report.ai_assessment:
        cached = dict(report.ai_assessment)
        cached["_cached"] = True
        # Stamp the cached-at time if the persisted blob carries one;
        # otherwise the dashboard infers from the report's
        # `updated_at`. Idempotent - never overwrites the original.
        logger.info(
            "AI assessment served from cache: %s (pass ?force=true to re-run)",
            report_id,
        )
        return cached

    # ── Gather intelligence from all sources ──
    desc = (report.description or payload.get("description", "") or "")[:600]
    ai = report.ai_analysis
    trans = ((ai.transcription if ai and ai.transcription else None) or payload.get("transcription", "") or "")[:600]
    ai_sum = ((ai.ai_summary if ai and ai.ai_summary else None) or payload.get("ai_summary", "") or "")[:400]
    loc = report.location
    loc_name = (loc.user_location_name or loc.device_location_name or "Unknown") if loc else "Unknown"
    lat = loc.latitude if loc else 0
    lng = loc.longitude if loc else 0
    acc = loc.accuracy_meters if loc else 0
    # Device-vs-submitted location mismatch → CONTEXT for the AI (analyst signal),
    # never a hard penalty: a corrected pin can be a legitimate edit (reporting
    # about damage elsewhere) OR a spoof. Significant = >1 km from the device GPS.
    loc_mismatch_note = ""
    if (loc and getattr(loc, "is_user_corrected", False)
            and getattr(loc, "device_latitude", None) is not None
            and getattr(loc, "device_longitude", None) is not None):
        from math import radians, sin, cos, asin, sqrt
        _a = (sin(radians((lat or 0) - loc.device_latitude) / 2) ** 2
              + cos(radians(loc.device_latitude)) * cos(radians(lat or 0))
              * sin(radians((lng or 0) - loc.device_longitude) / 2) ** 2)
        _dist_km = 2 * 6371.0 * asin(min(1.0, sqrt(_a)))
        if _dist_km > 1.0:
            loc_mismatch_note = (
                f"\n⚠ LOCATION ADJUSTED: the reporter moved the pin {int(round(_dist_km))} km from "
                f"the device GPS ({loc.device_latitude:.4f}, {loc.device_longitude:.4f}). This may be a "
                "legitimate correction or a spoof - weigh it and consider a satellite cross-check. "
                "Do NOT auto-penalise a corrected location.")
    v = report.verification
    caller = report.caller_info or payload.get("caller_info", {}) or {}
    source = report.source.value if report.source else "APP"
    is_voice_sms = source in ("IVR", "SMS")
    infra = report.infrastructure_type.value if report.infrastructure_type else "OTHER"
    criticality = CRITICALITY.get(infra, "STANDARD")

    # Reporter credibility
    device = report.device
    device_hash = device.device_hash if device else ""
    cred = _get_reporter_credibility(device_hash, db)

    # Corroboration
    corr = _get_corroboration(report, db)

    # Historical context
    hist = _get_historical(report, db)

    # Media analysis
    img_media = [m for m in (report.media or []) if m.type.value == "IMAGE" and m.assembly_status == "complete"]
    aud_media = [m for m in (report.media or []) if m.type.value == "AUDIO"]
    has_photo = len(img_media) > 0
    has_audio = len(aud_media) > 0

    # Temporal signals
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    created = report.server_created_at.replace(tzinfo=timezone.utc) if report.server_created_at and report.server_created_at.tzinfo is None else (report.server_created_at or now)
    wait_hours = round((now - created).total_seconds() / 3600, 1)
    is_night = created.hour >= 22 or created.hour < 6
    batch = db.query(Report).filter(
        Report.device_id == report.device_id, Report.id != report.id,
        Report.server_created_at.between(created - timedelta(minutes=5), created + timedelta(minutes=5))
    ).count() if report.device_id else 0

    # Data completeness
    fields_filled = sum([has_photo, has_audio, bool(desc), bool(lat), bool(loc_name != "Unknown"),
                         bool(report.crisis_type), bool(report.damage_classification),
                         bool(report.infrastructure_name)])
    completeness = round((fields_filled / 8) * 100)

    # Service status
    ss = report.service_status or {}

    # ── System prompt (CACHED - 90% token savings) ──
    system_prompt = """You are the Chief Intelligence Analyst for CRISP, a UN crisis response platform deployed in active disaster zones. Your assessment determines whether rescue teams are dispatched to save lives. You receive a full intelligence dossier per incident.

DECISION FRAMEWORK:
1. LIVES AT STAKE - a false negative (dismissing real crisis) kills people. A false positive wastes resources. ALWAYS err toward saving lives.
2. MULTI-SIGNAL FUSION - weight evidence by quality, not just presence. A HERO reporter with photo + verified satellite > 5 anonymous text-only reports.
3. CORROBORATION IS KING - multiple independent sources reporting the same event from different channels (IVR + Telegram + App) is the strongest possible signal.
4. TEMPORAL URGENCY - reports waiting >2 hours need expedited review. Night reports deserve benefit of doubt.
5. INFRASTRUCTURE CRITICALITY - hospital/water/power damage has cascading community-wide effects. Weight higher.
6. HISTORICAL PATTERNS - recurring reports from the same area may indicate chronic vulnerability OR persistent real damage.

REPORTER CREDIBILITY WEIGHTS:
- HERO (25+ verified reports, <5% false alarm): weight testimony at 95%
- GUARDIAN (10+ reports): 85%
- HELPER (3+ reports): 70%
- NEWCOMER (<3 reports): 50% - rely more on other signals
- IVR/SMS (traceable phone): +10% trust bonus regardless of badge

SOURCE RULES:
- IVR/SMS: CANNOT send photos. NEVER penalize for missing visual evidence.
- App/Telegram/WhatsApp: CAN send photos. Missing photo on SEVERE claim = mild flag (not automatic rejection).

SCORE COMPUTATION - You MUST compute and return a breakdown:
1. text_voice_score (0-100): Specificity, local knowledge, genuine detail, distress indicators
2. visual_evidence_score (0-100): Photo quality/relevance, or 50 baseline for IVR/SMS (cannot penalize)
3. satellite_score (0-100): Truth verification score, or 50 baseline if not yet verified
4. corroboration_score (0-100): Nearby reports quality, source diversity, temporal clustering
5. credibility_bonus (-10 to +10): Reporter badge adjustment
6. criticality_bonus (0-5): Infrastructure criticality adjustment
7. penalties (-20 to 0): Batch submission, high false-alarm rate, contradictions
8. final_score: weighted average + bonuses + penalties, clamped 0-100

RESPONSE FORMAT - Return ONLY valid JSON:
{
  "priority_level": "P1_IMMEDIATE | P2_URGENT | P3_STANDARD | P4_MONITOR | P5_LIKELY_FALSE",
  "confidence_score": 0-100,
  "suggested_action": "Dispatch Rescue Team | Dispatch + Alert Neighbors | Monitor & Verify | Request More Info | Flag as Suspicious | Likely False Report",
  "lives_at_risk_estimate": "number or range string",
  "inferred_severity": "CRITICAL | SEVERE | MODERATE | MINOR",
  "inferred_crisis_type": "EARTHQUAKE | FLOOD | TSUNAMI | CYCLONE | LANDSLIDE | EXPLOSION | CHEMICAL_INCIDENT | PANDEMIC | CONFLICT | CIVIL_UNREST | OTHER",
  "inferred_damage_class": "MINIMAL | PARTIAL | COMPLETE",
  "score_breakdown": {
    "text_voice_score": 0-100,
    "visual_evidence_score": 0-100,
    "satellite_score": 0-100,
    "corroboration_score": 0-100,
    "credibility_bonus": -10 to +10,
    "criticality_bonus": 0-5,
    "penalties": -20 to 0,
    "raw_total": float,
    "final_score": 0-100
  },
  "key_factors": ["factor1", "factor2", "factor3"],
  "risk_flags": ["flag1 if any"],
  "summary": "2-3 sentence executive briefing for dispatch commander. Max 80 words.",
  "reasoning": "6-10 line cross-verification analysis explaining how each signal was weighed."
}"""

    # ── Dynamic intelligence dossier (NOT cached - unique per report) ──
    corr_details = ""
    for c in corr["details"][:3]:
        corr_details += f"\n    • {c['dist_m']}m away: {c['type']} ({c['severity']}) via {c['source']}, {'verified '+str(c['v_score'])+'/100' if c['v_score'] else 'unverified'}, {c['hours_ago']}h ago"

    dossier = f"""═══ INCIDENT INTELLIGENCE DOSSIER ═══
Report ID: {report_id[:8]} | Source: {source} {"(NO photo capability)" if is_voice_sms else "(HAS photo capability)"} | Waiting: {wait_hours}h

── SECTION 1: REPORT DATA ──
Infrastructure: {infra} (Criticality: {criticality})
Name: {report.display_building_name or (report.infrastructure_name + ' (reporter-described, unverified — not an OSM-tagged building)' if report.infrastructure_name else 'Not specified')}
Severity: {report.severity.value if report.severity else 'UNKNOWN'}
Crisis Type: {report.crisis_type or 'Not specified'}
Damage: {report.damage_classification or 'Not specified'}
Debris Clearing: {'Needed' if report.debris_clearing_needed else 'Not specified'}
Location: {loc_name} ({lat}, {lng}) ±{acc}m{loc_mismatch_note}

── SECTION 2: EVIDENCE ──
Photo: {'Yes ('+str(len(img_media))+')' if has_photo else 'No'} | Audio: {'Yes' if has_audio else 'No'} | Text: {'Yes ('+str(len(desc))+' chars)' if desc else 'No'}
Completeness: {completeness}%
Description: "{desc or '[NONE]'}"
Transcription: "{trans or '[NONE]'}"
AI Summary: "{ai_sum or '[NONE]'}"

── SECTION 3: REPORTER PROFILE ──
Badge: {cred['badge_level']} | Reports: {cred['total_reports']} | Verified: {cred['verified_reports']} | False Alarm Rate: {cred['false_alarm_rate']}%
Credibility Score: {cred['credibility_score']}/100
Identity: {caller.get('phone', 'Anonymous app user') if caller else 'Anonymous'}

── SECTION 4: SATELLITE VERIFICATION ──
{f"Score: {v.total_score}/100 - {v.verdict}" if v and v.total_score else "Not yet verified (baseline 50)"}
{f"Scene: {(v.satellite_scene_description or '')[:250]}" if v else ""}
{f"Findings: {'; '.join((v.key_findings or [])[:3])}" if v and v.key_findings else ""}
{f"Photo vs Satellite: {(v.photo_analysis or '')[:200]}" if v and v.photo_analysis else ""}

── SECTION 5: CORROBORATION ──
Nearby (5km): {corr['nearby_total']} reports ({corr['nearby_verified']} verified, {corr['nearby_same_type']} same type)
Source Diversity: {corr['source_diversity']} channels
Temporal Cluster (2h): {'YES - likely real event' if corr['temporal_cluster'] else 'No'}
Strongest Score: {corr['strongest_score']}/100{corr_details}

── SECTION 6: HISTORICAL CONTEXT ──
Past 30 days (5km): {hist['past_30d']} reports | Past 90 days: {hist['past_90d']} reports
Historical False Alarm Rate: {hist['false_alarm_rate']}%
Recurring Location: {'YES' if hist['recurring'] else 'No'}
Past Crisis Types: {', '.join(hist['past_crisis_types']) if hist['past_crisis_types'] else 'None recorded'}

── SECTION 7: SERVICE STATUS ──
Electricity: {ss.get('electricity', 'Unknown')} | Water: {ss.get('water', 'Unknown')} | Health: {ss.get('health', 'Unknown')}
Pressing Needs: {', '.join(ss.get('pressing_needs', [])) or 'Not specified'}

── SECTION 8: URGENCY SIGNALS ──
Night Report: {'YES' if is_night else 'No'} | Batch Submission: {'YES - SUSPICIOUS' if batch >= 3 else 'No'}
Response Wait: {wait_hours}h | Data Completeness: {completeness}%

Compute the score breakdown and return JSON as specified."""

    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": anthropic_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={
                    "model": "claude-sonnet-4-6",
                    # The response schema is large (score_breakdown + key_factors +
                    # risk_flags + summary + a multi-line reasoning); 1200 tokens
                    # truncated verbose replies mid-JSON, which broke parsing.
                    "max_tokens": 2000,
                    "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                    "messages": [{"role": "user", "content": dossier}],
                })
            if r.status_code == 200:
                import json as jsonlib, re as _re
                text = r.json().get("content", [{}])[0].get("text", "{}")
                # Robust extraction: Claude sometimes wraps the object in a ```json
                # fence or appends prose, and a long reply can still be cut off by
                # max_tokens. Strip fences, then try the whole text and the
                # outermost {..} slice. On failure, SALVAGE the key fields by regex
                # (confidence_score/summary/suggested_action all precede the long
                # `reasoning` field, so they survive truncation) instead of dumping
                # the raw JSON into the UI as the summary with a fake score of 0.
                def _parse_ai_json(t):
                    s = (t or "").strip()
                    if s.startswith("```"):
                        s = _re.sub(r"^```[a-zA-Z]*\s*", "", s)
                        s = _re.sub(r"\s*```$", "", s).strip()
                    cands = [s]
                    if "{" in s and "}" in s:
                        cands.append(s[s.find("{"): s.rfind("}") + 1])
                    for cand in cands:
                        try:
                            obj = jsonlib.loads(cand)
                            if isinstance(obj, dict):
                                return obj
                        except Exception:
                            pass
                    return None
                data = _parse_ai_json(text)
                if not isinstance(data, dict):
                    m_cs = _re.search(r'"confidence_score"\s*:\s*(\d+)', text)
                    m_sm = _re.search(r'"summary"\s*:\s*"([^"]{0,300})', text)
                    m_sa = _re.search(r'"suggested_action"\s*:\s*"([^"]{0,80})', text)
                    data = {
                        "summary": (m_sm.group(1) if m_sm else "AI assessment response could not be fully parsed — re-run to retry."),
                        "suggested_action": (m_sa.group(1) if m_sa else "Review Needed"),
                        "reasoning": text[:1500],
                        # None (not 0) so a parse miss reads as "not scored", never a fabricated 0.
                        "confidence_score": (int(m_cs.group(1)) if m_cs else None),
                    }

                # Phase 3.3 - stamp the assessment with metadata so
                # later cache hits can surface "computed at X". The
                # nested keys are namespaced under `_meta` to stay
                # clear of any Claude-emitted field names.
                data["_meta"] = {
                    "computed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "model": "claude-sonnet-4-6",
                    "release": os.environ.get("CRISP_BUILD_TAG", ""),
                }
                # Persist full assessment to DB
                report.ai_assessment = data

                # Update classification from AI inference
                valid_types = [e.value for e in InfraTypeEnum]
                valid_sevs = [e.value for e in SeverityEnum]
                inferred_type = data.get("inferred_type", "") or ""
                inferred_sev = data.get("inferred_severity", "") or ""
                inferred_crisis = data.get("inferred_crisis_type", "") or ""
                inferred_damage = data.get("inferred_damage_class", "") or ""

                if inferred_type in valid_types and report.infrastructure_type.value == "OTHER":
                    report.infrastructure_type = InfraTypeEnum(inferred_type)
                if inferred_sev in valid_sevs:
                    report.severity = SeverityEnum(inferred_sev)
                if inferred_crisis:
                    report.crisis_type = _normalize_crisis_type(inferred_crisis)
                if inferred_damage:
                    report.damage_classification = inferred_damage

                db.commit()
                logger.info(f"AI assessment saved: {report_id} score={data.get('confidence_score','?')} priority={data.get('priority_level','?')}")
                # Phase 3.3 - `_cached: False` so the dashboard can
                # show "fresh assessment" vs "cached".
                data["_cached"] = False
                return data
            else:
                logger.error(f"Claude API error ({r.status_code}): {r.text[:200]}")
                raise HTTPException(status_code=502, detail="AI service error")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI service timeout")


@router.patch("/{report_id}/ai-summary")
def update_ai_summary(report_id: str, data: dict, db: Session = Depends(get_db)):
    """Store AI-inferred summary and raw transcription. Used by AI extractor."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report_id).first()
    if ai:
        if data.get("ai_summary"):
            ai.ai_summary = data["ai_summary"]
        if data.get("transcription"):
            ai.transcription = data["transcription"]
    else:
        ai = AIAnalysis(
            report_id=report_id,
            transcription=data.get("transcription", ""),
            ai_summary=data.get("ai_summary", ""),
        )
        db.add(ai)
    db.commit()
    logger.info(f"Report {report_id} AI summary updated")
    return {"status": "ok", "report_id": report_id}


# ── Progressive Upload: Stage 2/3 - attach one media file ────────────────────
@router.patch("/{report_id}/media/attach", response_model=ReportResponse)
def attach_media(report_id: str, media_in: MediaAttach, db: Session = Depends(get_db)):
    """
    Attach a single media file (image or audio) to an existing report.
    Updates sync_status from PARTIAL → SYNCED when all expected media received.
    Triggers AI pipeline for each media type received.
    """
    # K.2.a (May 2026, Phase K) - row-level lock on the Report row.
    # The "find existing media → maybe insert" pattern below
    # (lines 2645-2675) is a check-then-act race: two concurrent
    # /attach calls for the same (report_id, type) can both observe
    # `existing_media=None`, both INSERT a new Media row, both
    # increment received_media. `with_for_update()` acquires a
    # row-level lock on the parent Report for the duration of this
    # txn; the second handler waits on the lock, then reads the
    # winner's committed Media row → enters the UPDATE branch.
    # The K.1.a atomic increment is preserved as belt-and-suspenders.
    report = db.query(Report).filter(Report.id == report_id).with_for_update().first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Decode and save the base64 media via the storage abstraction.
    # extension + content-type now come from
    # _detect_audio_format/the data: URL header (was hardcoded to
    # "webm" for everything non-image, which produced unplayable
    # audio when iOS recorded MP4/AAC).
    file_url = media_in.url
    # K.2.b (May 2026, Phase K) - default for non-data: URL paths (an
    # S3 URL passed directly). 'not_needed' is the right semantic for
    # audio and for paths that bypass our blur stage.
    pii_blur_outcome = 'not_needed'
    if media_in.url.startswith("data:"):
        try:
            header, encoded = media_in.url.split(",", 1)
            file_data = base64.b64decode(encoded)
            if not file_data:
                raise ValueError("Empty base64 data")

            # Phase L L.12.6 (May 2026) - server-side 5 MB cap on the
            # ORIGINAL tier. The PWA/RN/bot encoder ladders should keep
            # bytes ≤ 5 MB before reaching this endpoint; this guard is
            # defense in depth (3rd-party integrations, buggy clients,
            # or any future channel that bypasses the client ladder).
            # K.6.c counter ticks so operators can see the bypass rate.
            if (media_in.resolution_tier == ResolutionEnum.ORIGINAL
                    and len(file_data) > _ORIGINAL_MAX_BYTES):
                try:
                    from app.core.observability import media_abandon_reason_total
                    media_abandon_reason_total.labels(
                        reason="original_too_large",
                    ).inc()
                except Exception:
                    pass
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"ORIGINAL tier exceeds 5 MB cap "
                        f"(got {len(file_data):,} bytes, max "
                        f"{_ORIGINAL_MAX_BYTES:,}). Client must apply "
                        "the Phase L L.2.b compression ladder before "
                        "upload (quality-ladder → downscale-ladder)."
                    ),
                )

            if "image" in header:
                ext = "png" if "png" in header else "jpg"
                content_type = _content_type_for(f"x.{ext}")
            else:
                ext, content_type = _detect_audio_format(header, file_data)
            filename = f"{report.id}_{time.time()}.{ext}"

            # (PR 2) - single-shot attach path. PII blur runs
            # via /tmp/ tempfile (filesystem-based cv2), then we
            # storage.save() the (possibly blurred) bytes.
            final_data = file_data  # default: original bytes pass through
            # May 2026 (Batch B-A) - track PII blur outcome on the
            # Media row using the canonical 4-state vocabulary
            # (alembic 0037). Mirrors the chunked-assembly path's
            # _run_server_pii_blur outcomes at reports.py:650-740.
            #   'complete_with_redactions' - blur ran AND PII blurred
            #   'complete_clean'           - blur ran, no PII detected
            #   'failed'                   - backends unavailable OR
            #                                 exception raised; file
            #                                 kept as-is, dashboard
            #                                 flags for manual review
            #   'not_needed'               - audio media (set below at
            #                                 row creation)
            #
            # Batch B-B (May 2026) - conditional save. blur_pii now
            # returns explicit `clean=True` when the pipeline ran and
            # found nothing. We branch on that field to skip the
            # disk read-back (final_data already equals file_data) and
            # preserve the input JPEG byte-for-byte. Only the
            # redacted path needs to read the (re-encoded) bytes
            # back from disk.
            pii_blur_outcome = 'not_needed'  # default for audio
            if ext in ('jpg', 'jpeg', 'png'):
                pii_blur_outcome = 'failed'  # pessimistic default
                try:
                    from app.services.pii_blur import blur_pii
                    with _stage_bytes(filename, file_data) as tmp_path:
                        pii_result = blur_pii(tmp_path)
                        # B-B: read back ONLY when blur actually re-encoded
                        # the file (redactions case). On clean / failed /
                        # backends-unavailable paths the tmp file is bit-
                        # identical to file_data - no read needed.
                        if pii_result.get('blurred'):
                            with open(tmp_path, "rb") as _fh:
                                final_data = _fh.read()
                    if pii_result.get('ran'):
                        if pii_result.get("blurred"):
                            pii_blur_outcome = 'complete_with_redactions'
                            logger.info(
                                f"PII blurred in attached {filename}: "
                                f"faces={pii_result['faces']} text={pii_result['pii_texts']}"
                            )
                        elif pii_result.get("clean"):
                            pii_blur_outcome = 'complete_clean'
                            logger.info(
                                f"PII blur ran on attached {filename}: "
                                f"no PII detected - bytes unchanged (B-B conditional save)"
                            )
                        else:
                            # ran=True but neither blurred nor clean -
                            # shouldn't happen, defensive log.
                            pii_blur_outcome = 'complete_clean'
                            logger.warning(
                                f"PII blur ran on attached {filename} but "
                                f"neither blurred nor clean flag set - "
                                f"defaulting to complete_clean. Result: {pii_result!r}"
                            )
                    else:
                        # backends unavailable - pii_blur_outcome stays 'failed'.
                        # Pre-0037 this was 'skipped'; the new vocabulary
                        # unifies "blur didn't happen, file may have PII"
                        # under 'failed' so operators see a single red chip.
                        logger.error(
                            f"PII-BLUR FAILED (backends unavailable) for attached {filename}: "
                            f"{pii_result.get('error')} - object kept as-is, "
                            f"dashboard will flag via pii_blur_status='failed'."
                        )
                except Exception as e:
                    pii_blur_outcome = 'failed'
                    logger.warning(f"PII blur failed for attached {filename}: {e}")

            file_url = _get_media_storage().save(filename, final_data, content_type)
            logger.info(
                f"Attached {ext} ({content_type}): {filename} "
                f"({len(final_data)} bytes) → {file_url}"
            )
        except HTTPException:
            # Phase L L.12.6 - re-raise HTTPException unchanged so the
            # 5 MB cap (413) doesn't get rewrapped into a 400. Pre-L
            # this except-Exception caught HTTPException too because
            # HTTPException is-a Exception in FastAPI.
            raise
        except Exception as e:
            logger.error(f"Media attach decode error: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to decode media: {str(e)}")

    # Save or update media record (avoid duplicates on retry)
    existing_media = db.query(Media).filter(
        Media.report_id == report.id,
        Media.type == media_in.type,
        Media.assembly_status == 'complete'
    ).first()

    if existing_media:
        # Update existing - don't create duplicate
        existing_media.url = file_url
        existing_media.file_size_bytes = media_in.file_size_bytes or (len(file_data) if file_data else 0)
        # K.2.b - refresh pii_blur_status to reflect this fresher upload's
        # blur outcome. If the operator re-uploads after an earlier failure,
        # the new status takes precedence (most recent blur attempt wins).
        existing_media.pii_blur_status = pii_blur_outcome
        logger.info(f"Media updated (existing): {existing_media.id[:12]} pii_blur={pii_blur_outcome}")
    else:
        # Clean up any failed/orphaned media of same type first
        orphans = db.query(Media).filter(
            Media.report_id == report.id,
            Media.type == media_in.type,
            Media.assembly_status != 'complete'
        ).all()
        for o in orphans:
            db.delete(o)

        db_media = Media(
            report_id=report.id,
            type=media_in.type,
            resolution_tier=media_in.resolution_tier,
            url=file_url,
            file_size_bytes=media_in.file_size_bytes or (len(file_data) if file_data else 0),
            is_synced=True,
            assembly_status='complete',
            completion_pct=100.0,
            # K.2.b (May 2026, Phase K) - surface PII blur outcome so the
            # dashboard can render a chip ('PII review needed' on 'failed'
            # / 'skipped'). Audio gets 'not_needed'. Was NULL pre-fix.
            pii_blur_status=pii_blur_outcome,
        )
        db.add(db_media)
        db.flush()  # ensure the INSERT lands before the atomic UPDATE so
                    # concurrent /attach calls correctly observe the new row

        # K.6.c - operator-visible PII-blur outcome SLI. Distinct
        # from the existing `crisp_pii_blur_runs_total` (which counts
        # AI-executor run outcomes); this measures the /persisted/
        # state stamped on every Media row at ingest time.
        try:
            from app.core.observability import pii_blur_status_total
            pii_blur_status_total.labels(
                status=str(pii_blur_outcome or "unknown"),
            ).inc()
        except Exception:
            pass

        # K.1.a (May 2026, Phase K) - atomic SQL increment (was non-atomic
        # `report.received_media = (report.received_media or 0) + 1`).
        # Concurrent /attach for different tiers + parallel assembly-bg
        # threads previously could interleave reads + writes; either lost
        # increments (report stuck PARTIAL with media missing from count)
        # or double-counted (premature SYNCED). The UPDATE ... = col + 1
        # is atomic at the DB engine level.
        db.query(Report).filter(Report.id == report.id).update(
            {"received_media": (Report.received_media + 1)},
            synchronize_session="fetch",
        )
        db.flush()
        db.refresh(report)

    # Check if all expected media received → mark SYNCED
    if report.received_media >= report.expected_media:
        report.sync_status = SyncStatusEnum.SYNCED
        logger.info(f"Report {report.id} fully synced ({report.received_media}/{report.expected_media} media)")
    else:
        logger.info(f"Report {report.id} partial ({report.received_media}/{report.expected_media} media)")

    db.commit()

    # Trigger AI pipeline for this specific media. (PR 3) -
    # was previously gated on `file_url.startswith("/static/")`, which
    # silently skipped both transcription + image-vision once the
    # storage backend flipped to S3 (every new file_url is `s3://...`).
    # Switched to the storage-abstraction staging pattern: read bytes
    # via storage.read(), drop into a /tmp/ tempfile for the
    # filesystem-bound libs (faster-whisper / cv2), unlink on exit.
    # Mirrors what `_run_ai_pipeline` already does for the chunked path.
    if media_in.type == MediaTypeEnum.AUDIO and file_url:
        try:
            filename = file_url.rsplit("/", 1)[-1].split("://", 1)[-1].rsplit("/", 1)[-1]
            with _stage_from_storage(file_url, filename) as tmp_path:
                logger.info(f"Transcribing attached audio: {tmp_path} (source={file_url})")
                transcription = ai_service.transcribe_audio(tmp_path)
            if transcription:
                ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report.id).first()
                if ai:
                    ai.transcription = transcription
                else:
                    ai = AIAnalysis(report_id=report.id, transcription=transcription)
                    db.add(ai)
                db.commit()
        except Exception as e:
            # Best-effort - never block the attach response on a
            # transcription failure. The dashboard renders without
            # transcription; an analyst can retry from the admin panel.
            logger.warning(f"Audio transcription failed for {file_url}: {e}")

    db.refresh(report)
    return report


# ── Progressive Upload: Stage 2 - thumbnail (fast preview before full chunks) ─
@router.post("/{report_id}/media/thumbnail", status_code=status.HTTP_200_OK)
def attach_thumbnail(report_id: str, payload: ThumbnailPayload, db: Session = Depends(get_db)):
    """
    Accept a small thumbnail image (<20KB) before full chunked upload begins.
    Creates the Media record so the dashboard can show a preview immediately.
    Idempotent: safe to call multiple times.
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Decode + persist via the storage abstraction. (PR 3) -
    # was previously writing directly to UPLOAD_DIR + emitting
    # `/static/<file>`. Under MEDIA_BACKEND=s3 that violated the
    # zero-persistent-disk mandate (every fast-preview thumbnail
    # accumulated on the EC2 volume forever). Now uses the same
    # storage.save() path as full media + chunked uploads, so the
    # backend selection decides where the bytes physically land.
    # PII blur still runs but via _stage_bytes - cv2.imread needs a
    # real path on disk, so we stage to /tmp/ for the duration of the
    # blur call and read the (possibly mutated) bytes back. Net effect
    # for S3 backend: persistent disk untouched, /tmp/ tempfile auto-
    # deletes on context exit.
    thumbnail_url = None
    if payload.thumbnail_data.startswith("data:"):
        try:
            _, b64 = payload.thumbnail_data.split(",", 1)
            padding = (4 - len(b64) % 4) % 4
            thumb_bytes = base64.b64decode(b64 + '=' * padding)
            filename = f"{payload.media_id}_thumb.jpg"

            final_bytes = thumb_bytes
            try:
                from app.services.pii_blur import blur_pii
                with _stage_bytes(filename, thumb_bytes) as tmp_path:
                    blur_pii(tmp_path)
                    with open(tmp_path, "rb") as _fh:
                        final_bytes = _fh.read()
            except Exception as e:
                # Blur failure must not block the fast-preview write -
                # raw thumbnail still goes up, server-side blur on the
                # full chunked photo will catch the same content later.
                logger.warning(f"Thumbnail PII blur failed (non-fatal): {e}")

            thumbnail_url = _get_media_storage().save(
                filename, final_bytes, _content_type_for(filename)
            )
        except Exception as e:
            logger.warning(f"Thumbnail save failed (non-fatal): {e}")

    # Upsert Media record - create if not exists, update thumbnail if already exists
    existing = db.query(Media).filter(Media.id == payload.media_id).first()
    if existing:
        if thumbnail_url:
            existing.thumbnail_url = thumbnail_url
    else:
        db.add(Media(
            id=payload.media_id,
            report_id=report_id,
            type=MediaTypeEnum.IMAGE,
            resolution_tier=payload.resolution_tier,
            url='',
            is_synced=False,
            thumbnail_url=thumbnail_url,
            assembly_status='pending',
            completion_pct=0.0,
            chunk_count=0,
            received_chunks=0
        ))

    db.commit()
    logger.info(f"Thumbnail stored for media {payload.media_id} on report {report_id}")
    return {"status": "ok", "thumbnail_url": thumbnail_url, "media_id": payload.media_id}


# ── Progressive Upload: Stage 2/3 - one ~1KB media chunk (PRD §3.3) ──────────
@router.post("/{report_id}/media/chunk", status_code=status.HTTP_200_OK)
def attach_media_chunk(
    report_id: str,
    payload: MediaChunkPayload,
    background_tasks: BackgroundTasks,
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Receive one ~1KB packet of media data with sequence number and checksum.
    - Verifies checksum for data integrity (PRD §3.7)
    - Idempotent: duplicate packets are silently ignored
    - Assembles full file when all chunks received
    - Triggers AI pipeline in background (non-blocking - P-1 fix)
    - Returns completion_pct for client progress tracking

    P1.5 - rate limited to 180 chunks/minute per client IP (= 3/s). A healthy
    1 MB upload at 512 KB chunks is ~2 chunks; even a 10 MB upload at 1 KB
    chunks (worst-case very-slow tier) is 10,000 chunks over many minutes.
    180/min therefore comfortably covers every real scenario while blocking
    the DoS surface where a single client sprays thousands of fake chunks.
    """
    from app.main import check_rate_limit
    client_ip = request.client.host if request.client else 'unknown'
    if not check_rate_limit(f"chunk:{client_ip}", max_requests=180, window=60):
        raise HTTPException(
            status_code=429,
            detail="Too many chunk uploads from this IP; slow down and retry."
        )

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Integrity check (PRD §3.7)
    if payload.checksum:
        computed = djb2_checksum(payload.data)
        if computed != payload.checksum:
            try:
                chunk_transport_total.labels(transport='base64', outcome='rejected').inc()
            except Exception:
                pass
            raise HTTPException(
                status_code=400,
                detail=f"Checksum mismatch seq={payload.seq_num}: expected {payload.checksum}, got {computed}"
            )

    # Transport observability - emit after integrity check so checksum-mismatch
    # failures land in the `rejected` bucket above and only healthy uploads
    # hit `accepted` here.
    try:
        chunk_transport_total.labels(transport='base64', outcome='accepted').inc()
    except Exception:
        pass

    # Find or create the Media record for this upload session.
    # Guaranteed-delivery: the client tags every chunk with `resolution_tier`
    # (SMALL=LOW / MEDIUM=MEDIUM / LARGE=HIGH) and a `photo_group_id` linking
    # the three variants of one captured photo. We used to hard-code `MEDIUM`
    # here, which meant tier mismatches were silently lost. Use the values
    # from the payload; legacy clients that don't send them still work
    # because the schema defaults are `LOW` + null.
    # K.1.b (May 2026, Phase K) - race-safe Media row create. Two
    # concurrent chunk-0 submissions for a new media_id both observe
    # `media=None`, both INSERT, the second hits media.id (PK) unique
    # violation → 500. Wrap in try/except so the loser re-reads the
    # winner's row and continues.
    from sqlalchemy.exc import IntegrityError as _MediaIntegrityError

    media = db.query(Media).filter(Media.id == payload.media_id).first()
    # Chunk-cleanup guard (May 2026): once a media assembles, its chunk rows
    # are reclaimed (see _assemble_media_file). A late/duplicate chunk for an
    # already-'complete' media must NOT re-insert an orphan that re-seeds the
    # emptied table - the upload is done. Ack idempotently, touch nothing.
    if media is not None and media.assembly_status == 'complete':
        return {
            "media_id": payload.media_id,
            "seq_num": payload.seq_num,
            "received": media.received_chunks,
            "total": payload.total_chunks,
            "completion_pct": media.completion_pct,
            "assembly_status": media.assembly_status,
        }
    if not media:
        try:
            media = Media(
                id=payload.media_id,
                report_id=report_id,
                type=payload.type,
                resolution_tier=payload.resolution_tier,
                photo_group_id=payload.photo_group_id,
                url='',
                is_synced=False,
                chunk_count=payload.total_chunks,
                received_chunks=0,
                completion_pct=0.0,
                assembly_status='pending',
                # : persist the client-blur flag from the first chunk.
                # Subsequent chunks for the same media_id don't update it -
                # all chunks for one upload share the same blur status.
                client_blur_applied=bool(payload.client_blur_applied),
                # Phase C.1 - whole-asset checksum from the PWA's djb2 over the
                # full original bytes. Sent on chunk 0 only; the assembler will
                # verify after concatenation. NULL on later chunks / legacy
                # clients => check skipped (back-compat).
                full_asset_checksum=(payload.full_asset_checksum if payload.seq_num == 0 else None),
                # R2.a - first-chunk row creation seeds the epoch from the
                # client's claim. Legacy clients omit it; pydantic defaults
                # to 1 which matches the row's server_default.
                upload_generation=payload.upload_generation,
            )
            db.add(media)
            db.flush()
        except _MediaIntegrityError:
            db.rollback()
            media = db.query(Media).filter(Media.id == payload.media_id).first()
            if not media:
                # Defensive: if even after rollback we can't find it,
                # something else corrupted the txn. Surface as 500.
                raise HTTPException(
                    status_code=500,
                    detail="media row creation race could not be reconciled",
                )
    else:
        # R2.a - epoch / generation check. If the client's claimed
        # generation doesn't match the row's, reject with 409 + the
        # server's truth so the client can resync. Stale tabs /
        # zombie service-workers replaying chunks from a pre-revival
        # session lose this race harmlessly. This check runs BEFORE the
        # R1 revival logic so a stale-session chunk can't trip a
        # revival.
        if payload.upload_generation != media.upload_generation:
            logger.warning(
                f"[Chunk] generation mismatch on {payload.media_id[:8]}: "
                f"client={payload.upload_generation} server={media.upload_generation}; "
                f"rejecting as stale-session replay"
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "upload_generation_mismatch",
                    "server_generation": media.upload_generation,
                    "client_generation": payload.upload_generation,
                    "media_id": payload.media_id,
                    "message": (
                        "This upload session is stale. The server has "
                        "advanced upload_generation (typically because "
                        "the upload was abandoned and a fresh session "
                        "took over). Resync by re-reading the Media "
                        "row's current upload_generation and retrying "
                        "with that value, or allocate a fresh media_id."
                    ),
                },
            )
        # ── R1 (May 2026) - soft-abandon revival (legacy JSON endpoint) ─
        # Mirrors the chunk-bin handler's revival rule. See that handler
        # for the full design notes. Hard-abandons (checksum_mismatch /
        # original_too_large) reject with 410 Gone; soft-abandons revive
        # atomically while preserving the audit columns.
        _HARD_ABANDON_REASONS_LEGACY = frozenset({
            'checksum_mismatch', 'original_too_large',
        })
        _SOFT_ABANDON_REASONS_LEGACY = frozenset({
            'chunks_never_arrived', 'assembly_worker_lost',
            'bandwidth_tier_deferred',
        })
        if (media.abandoned_at is not None
                and media.abandon_reason in _HARD_ABANDON_REASONS_LEGACY):
            logger.warning(
                f"[Chunk] rejecting chunk for hard-abandoned media "
                f"{payload.media_id[:8]} (reason={media.abandon_reason}); "
                f"client must allocate a new media_id."
            )
            raise HTTPException(
                status_code=410,
                detail=(
                    f"media row terminally abandoned "
                    f"({media.abandon_reason}); allocate a fresh media_id"
                ),
            )
        if (media.assembly_status == 'failed'
                and media.abandoned_at is not None
                and media.recovered_at is None
                and media.abandon_reason in _SOFT_ABANDON_REASONS_LEGACY):
            update_payload = {
                'assembly_status': 'pending',
                # R2.a - bump the epoch on revival so any pre-revival
                # zombie chunk replay 409s harmlessly.
                'upload_generation': Media.upload_generation + 1,
            }
            if media.abandon_reason == 'bandwidth_tier_deferred':
                update_payload.update({
                    'chunk_count': payload.total_chunks,
                    'received_chunks': 0,
                    'completion_pct': 0.0,
                    'url': '',
                })
            revived = db.query(Media).filter(
                Media.id == payload.media_id,
                Media.assembly_status == 'failed',
                Media.abandoned_at.isnot(None),
                Media.recovered_at.is_(None),
                Media.abandon_reason.in_(list(_SOFT_ABANDON_REASONS_LEGACY)),
            ).update(update_payload, synchronize_session=False)
            if revived and media.abandon_reason == 'bandwidth_tier_deferred':
                db.query(Report).filter(Report.id == report_id).update(
                    {Report.expected_media: Report.expected_media + 1},
                    synchronize_session="fetch",
                )
            if revived:
                logger.info(
                    f"[Chunk] revived {payload.media_id[:8]} from "
                    f"abandon_reason={media.abandon_reason} "
                    f"(audit trail preserved; recovered_at stamped on assembly; "
                    f"upload_generation bumped to {media.upload_generation + 1})"
                )
                try:
                    from app.core.observability import variant_uploads_total as _vut
                    _vut.labels(
                        tier=str(media.resolution_tier.value if media.resolution_tier else 'UNKNOWN'),
                        outcome='revived',
                    ).inc()
                except Exception:
                    pass
            db.flush()
            db.refresh(media)
            # R2.a - after revival, the client's chunk MUST carry the
            # NEW generation. If we got here with the OLD generation
            # (the revival happened on the same chunk that triggered
            # it - a legitimate client coming back online), accept it:
            # we bumped on behalf of the recovering client. But if a
            # SEPARATE stale-session chunk arrives with the OLD value,
            # reject with 409 on the next request.

        if payload.client_blur_applied and not media.client_blur_applied:
            # Client sent the flag on a later chunk (e.g. resumed upload where
            # first chunk predated the client-blur release). Upgrade the media
            # row so the assembler picks it up.
            media.client_blur_applied = True
        # Phase C.1 - late-arriving whole-asset checksum (chunk 0 retried
        # after others landed first). Accept iff the row doesn't already
        # carry one; never overwrite the canonical first-write value.
        if payload.seq_num == 0 and payload.full_asset_checksum and not media.full_asset_checksum:
            media.full_asset_checksum = payload.full_asset_checksum
        # Tier upgrade: /media/thumbnail used to hard-code MEDIUM when it
        # created the row, which stranded ORIGINAL-tier rows at MEDIUM
        # whenever the thumbnail landed first. Conservative rule - only
        # upgrade SMALL/MEDIUM → ORIGINAL, never downgrade - so the
        # dashboard "Originals pending" pill (filters on
        # resolution_tier === 'ORIGINAL') sees the full-quality variant
        # once the chunks declare it.
        if (payload.resolution_tier == ResolutionEnum.ORIGINAL
                and media.resolution_tier in (ResolutionEnum.SMALL, ResolutionEnum.MEDIUM)):
            media.resolution_tier = ResolutionEnum.ORIGINAL

    # Idempotent chunk insert - check for duplicate before incrementing counter.
    # K.1.b (May 2026, Phase K) - race-safe insert. The query-then-add
    # pattern below has a check-then-act race: two concurrent calls with
    # the same (media_id, seq_num) both observe `existing_chunk=None`,
    # both attempt to INSERT, the second hits the
    # `uq_media_chunk_seq` UniqueConstraint and crashes with 500. The
    # client retries on 500 and the count goes wrong. Wrap the insert
    # in a try/except so the duplicate becomes an idempotent noop.
    from sqlalchemy.exc import IntegrityError

    existing_chunk = db.query(MediaChunk).filter(
        MediaChunk.media_id == payload.media_id,
        MediaChunk.seq_num == payload.seq_num
    ).first()

    is_new_chunk = not existing_chunk
    if is_new_chunk:
        try:
            db.add(MediaChunk(
                media_id=payload.media_id,
                seq_num=payload.seq_num,
                total_chunks=payload.total_chunks,
                data_b64=payload.data,
                checksum=payload.checksum
            ))
            db.flush()
        except IntegrityError:
            # Concurrent duplicate (uq_media_chunk_seq violation). The
            # other thread won the race; this call is a legitimate idempotent
            # retry. Roll back the partial txn and treat as the dup path.
            db.rollback()
            # Re-fetch the media row inside the rolled-back session.
            media = db.query(Media).filter(Media.id == payload.media_id).first()
            is_new_chunk = False

    if is_new_chunk:
        # P-6 fix: atomic SQL-level increment avoids race condition on concurrent retries
        #
        # Phase-2.4 invariant - `chunk_count` is updated on every
        # chunk insert to `payload.total_chunks`. The assumption this relies
        # on: **chunks within a single media_id are UNIFORM size**, so
        # `total_chunks` never changes mid-upload. Clients enforce this via
        # a `LOCKED_TOTAL_CHUNKS` (RN) / `const total = ...` (PWA) computed
        # once at upload-start. Mid-upload tier switches in the adaptive
        # layer (Phase 1.6 re-probe, Phase 2.1 packet-loss shrink) only
        # affect the chunk SIZE of the NEXT media - they do NOT re-chunk
        # in-flight data. If a future adaptive change ever re-chunks a live
        # upload, it MUST allocate a new media_id for the post-switch bytes;
        # overwriting `chunk_count` on a live media with a different-sized
        # chunk schedule would corrupt the completion-percentage calculation
        # AND the concat invariant in `_assemble_media_file`.
        db.query(Media).filter(Media.id == payload.media_id).update(
            {"received_chunks": Media.received_chunks + 1,
             "chunk_count": payload.total_chunks},
            synchronize_session="fetch"
        )
        db.flush()
        # Re-read after atomic update to get accurate count
        db.refresh(media)
        media.completion_pct = round((media.received_chunks / payload.total_chunks) * 100, 1)

    db.commit()

    # Progressive partial assembly - BUT skip it if this chunk completes the
    # upload (full assembly will produce the final file anyway, so partial is
    # redundant and just delays it). FastAPI BackgroundTasks run serially, so
    # a partial task with slow PII blur would queue up in front of the full
    # assembly and starve it.
    is_final_chunk = media.received_chunks >= payload.total_chunks
    if (is_new_chunk and not is_final_chunk and
        payload.type == MediaTypeEnum.IMAGE and
        media.received_chunks >= 3 and
        media.received_chunks % 3 == 0 and
        media.assembly_status != 'complete'):
        background_tasks.add_task(_try_partial_image_bg, payload.media_id)

    if (is_new_chunk and not is_final_chunk and
        payload.type == MediaTypeEnum.AUDIO and
        media.received_chunks >= 5 and
        media.received_chunks % 5 == 0 and
        media.assembly_status != 'complete'):
        background_tasks.add_task(_try_partial_audio_bg, payload.media_id, report_id)

    # Full assembly when all chunks received (PRD §3.6).
    # Run in background so the HTTP response returns immediately - otherwise
    # PII blur + disk I/O on the final chunk can hold the handler open long
    # enough for mobile clients to time out and leave the media stuck at
    # 'pending' despite received_chunks == total_chunks. See _try_full_assembly_bg.
    db.refresh(media)  # make sure we see the post-commit state, not stale in-memory
    logger.info(
        f"[Chunk] {payload.media_id[:8]} seq={payload.seq_num} "
        f"received={media.received_chunks}/{payload.total_chunks} "
        f"status={media.assembly_status} new={is_new_chunk}"
    )
    # P1.1 - Atomic-CAS lock before spawning. Previously two concurrent chunk
    # handlers could both see status='pending' and each spawn a thread; the
    # second thread would no-op inside _try_full_assembly_bg's own CAS but
    # spawning a wasted thread per retry is still avoidable. Here we flip
    # pending → assembling in a single UPDATE and only spawn if this row
    # changed (i.e. we won the race). Stuck 'assembling' is also escaped:
    # if the status has been 'assembling' for >5 min with no progress, we
    # assume the previous worker died (crash / uvicorn --reload) and reclaim
    # the lock. This closes the data-loss path where media was stranded
    # forever in 'assembling' after a backend restart.
    if media.received_chunks >= payload.total_chunks and media.assembly_status != 'complete':
        from datetime import datetime, timedelta, timezone as _tz
        stale_cutoff = datetime.now(_tz.utc) - timedelta(minutes=5)
        locked = db.query(Media).filter(
            Media.id == payload.media_id,
            or_(
                Media.assembly_status == 'pending',
                and_(Media.assembly_status == 'assembling', Media.updated_at < stale_cutoff),
                Media.assembly_status == 'failed',
            )
        ).update({'assembly_status': 'assembling'}, synchronize_session=False)
        db.commit()
        if locked:
            logger.info(f"[Chunk] acquired assembly lock for {payload.media_id[:8]}; enqueuing to pool")
            # P2.2 - submit to the bounded ThreadPoolExecutor instead of
            # spawning an unbounded threading.Thread. The pool caps concurrent
            # assemblies at CRISP_ASSEMBLY_WORKERS (default 4) which prevents
            # thread explosion under load. Queued jobs run as workers free up.
            _assembly_executor.submit(
                _try_full_assembly_bg,
                payload.media_id, payload.type.value, report_id
            )
        else:
            logger.info(
                f"[Chunk] {payload.media_id[:8]} already locked by another worker "
                f"(status={media.assembly_status})"
            )

    return {
        "media_id": payload.media_id,
        "seq_num": payload.seq_num,
        "received": media.received_chunks,
        "total": payload.total_chunks,
        "completion_pct": media.completion_pct,
        "assembly_status": media.assembly_status
    }


# ── Upload-bandwidth probe ──────────────────────────────────────
#
# Lightweight endpoint the PWA/RN client hits BEFORE the first chunk of
# a media upload to measure actual upload throughput. Fixes a class of
# bugs where the client's network-tier detector (`detectPWANetworkTier`)
# trusts `navigator.connection.effectiveType`, which Chrome DevTools
# throttling does NOT update at runtime - leading to the client picking
# MEDIUM tier (128 KB chunks, 30 s timeout) on a 2 Kbps throttled link,
# every chunk timing out, upload stuck forever.
#
# The client POSTs a ~8 KB payload, measures wall-clock round-trip time,
# divides → bytes-per-second → picks a tier. No persistence. No auth
# (bandwidth is a public property of the link; hiding this endpoint
# doesn't add security). Rate-limited 60/min per client IP so it can't
# be abused for DoS.
# Phase F (May 2026) - RETIRED: POST /api/v1/reports/classify-suggest
# (AI pre-fill endpoint, Claude Haiku-backed). The feature pre-filled the
# 3 classify chip rows with AI-suggested infra/crisis/damage values when
# the user captured a photo on a fast network. Operator decision: the
# feature is being removed entirely (PWA never had a stable client caller
# anyway - only a header comment in v4-flow.js referenced the endpoint).
# The service file (app/services/classify_suggest.py) + its test slice
# (backend/tests/test_classify_suggest.py) are deleted in the same
# commit. building_ai_summary.py only referenced "the existing
# classify-suggest pattern" in a comment; that reference is updated
# in-place to point at the general Claude Haiku integration, not this
# specific endpoint.


@router.post("/upload-probe", status_code=status.HTTP_200_OK)
async def upload_probe(request: Request, data: UploadFile = File(...)):
    """Echo `len(data)` for client-side bandwidth measurement.

    Client usage:
      * generate an N-byte payload (8 KB recommended - enough signal,
        fast enough at worst-case bandwidth)
      * `performance.now()` before the POST
      * `performance.now()` after the 200 response arrives
      * throughput ≈ N / elapsed_ms * 1000 bytes/sec
    """
    from app.main import check_rate_limit
    client_ip = request.client.host if request.client else 'unknown'
    if not check_rate_limit(f"probe:{client_ip}", max_requests=60, window=60):
        raise HTTPException(status_code=429, detail="probe rate limit exceeded")
    # 64 KB hard cap - stops abuse where a client POSTs 100 MB "probes".
    content = await data.read()
    if len(content) > 65_536:
        raise HTTPException(status_code=422, detail="probe payload too large (max 64 KB)")
    return {
        "received_bytes": len(content),
        "server_time_ms": int(time.time() * 1000),
    }


# ── Binary-chunk endpoint ─────────────────────────────
#
# UNDP scale work: replaces the base64-over-JSON chunk transport with a raw
# multipart/form-data binary upload. The request body carries:
#
#     media_id           - string, UUID chosen by the client
#     seq_num            - int, 0-indexed chunk sequence
#     total_chunks       - int, total chunks for this media
#     type               - "IMAGE" | "AUDIO"
#     resolution_tier    - "LOW" | "MEDIUM" | "HIGH"   (default "LOW")
#     photo_group_id     - string, UUID grouping the 3 variants of one photo
#     client_blur_applied - "true"/"false"/"1"/"0"
#     checksum           - hex djb2 over the raw bytes (optional)
#     data               - UploadFile, the raw-byte chunk payload
#
# Preserves 100 % of the legacy endpoint's business logic:
#   * rate limit 180 chunks/min per client IP (same Redis-free key)
#   * report existence check
#   * djb2 integrity verification (`djb2_bytes`) when checksum provided
#   * idempotent insert on (media_id, seq_num)
#   * atomic SQL-level `received_chunks += 1`
#   * partial assembly trigger every 3 image / 5 audio chunks
#   * full-assembly CAS lock + 5-min stale-escape
#   * client_blur_applied flag persistence + upgrade on late chunks
#
# The ONLY difference: chunks land in `MediaChunk.data_binary` (LargeBinary)
# rather than `MediaChunk.data_b64` (Text). The assembly path consults
# both columns and concatenates whichever is populated per row, so mixed
# media rows (never produced in practice) still assemble correctly.
@router.post("/{report_id}/media/chunk-bin", status_code=status.HTTP_200_OK)
async def attach_media_chunk_bin(
    report_id: str,
    request: Request,
    data: UploadFile = File(...),
    media_id: str = Form(...),
    seq_num: int = Form(...),
    total_chunks: int = Form(...),
    type: str = Form(...),
    resolution_tier: str = Form("LOW"),
    photo_group_id: Optional[str] = Form(None),
    client_blur_applied: str = Form("false"),
    checksum: Optional[str] = Form(None),
    # Phase C.1 - whole-asset djb2 checksum, sent on chunk 0 only.
    # Absent / NULL on later chunks and on legacy clients; the assembler
    # skips the integrity check when the column is NULL on the Media row.
    full_asset_checksum: Optional[str] = Form(None),
    # R2.a - upload epoch / generation. Default 1 so legacy clients
    # that don't send the field continue to match the row's default. The
    # server rejects mismatches with 409 Conflict and bumps the row's
    # value on every soft-abandon revival so any post-revival stale
    # chunk replay 409s.
    upload_generation: int = Form(1),
    db: Session = Depends(get_db),
):
    """Binary variant of `/media/chunk`. See module-level comment above."""
    from app.main import check_rate_limit

    # ── Rate limit (identical key prefix so clients sharing an IP can't
    #    bypass the legacy limit by switching transports).
    client_ip = request.client.host if request.client else 'unknown'
    if not check_rate_limit(f"chunk:{client_ip}", max_requests=180, window=60):
        raise HTTPException(
            status_code=429,
            detail="Too many chunk uploads from this IP; slow down and retry."
        )

    # ── Input validation (mirrors MediaChunkPayload pydantic guards).
    if seq_num < 0 or seq_num > 10_000:
        raise HTTPException(status_code=422, detail="seq_num out of range")
    if total_chunks < 1 or total_chunks > 10_000:
        raise HTTPException(status_code=422, detail="total_chunks out of range")
    type_upper = str(type).upper()
    if type_upper not in {"IMAGE", "AUDIO"}:
        raise HTTPException(status_code=422, detail=f"invalid type: {type!r}")
    tier_upper = str(resolution_tier).upper()
    # Phase L (May 2026) - canonical 3-value vocabulary. Pre-L
    # vocabulary was LOW/MEDIUM/HIGH/ORIGINAL; alembic 0036 dropped
    # LOW + HIGH from the Postgres enum.
    if tier_upper not in {"SMALL", "MEDIUM", "ORIGINAL"}:
        # Operator-actionable error so a 422 is debuggable from
        # uvicorn's INFO log directly without re-running with debug
        # logging enabled (caught us during Batch 2 rollout).
        logger.warning(
            "[chunk-bin] rejected non-canonical tier=%r from report=%s "
            "media=%s - client must send SMALL/MEDIUM/ORIGINAL",
            resolution_tier, report_id, media_id,
        )
        raise HTTPException(status_code=422, detail=f"invalid resolution_tier: {resolution_tier!r}")

    # Path-traversal hardening: media_id / report_id are interpolated into
    # storage filenames downstream (e.g. f"{media_id}_assembled.{ext}"), so a
    # value like "../../etc/x" would escape the upload dir. media_id is a
    # client-chosen string (not necessarily a UUID), so we don't constrain the
    # charset - we only reject the characters that enable traversal. The
    # storage layer (_within) is a second, authoritative guard.
    for _ident in (report_id, media_id):
        _s = str(_ident)
        if "/" in _s or "\\" in _s or ".." in _s or "\x00" in _s:
            raise HTTPException(status_code=422, detail="invalid id format")

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # ── Read payload bytes. 1 MB soft cap on raw bytes = 1.33 MB base64
    #    equivalent; matches the MediaChunkPayload max_length=1048576 guard.
    raw_bytes = await data.read()
    if len(raw_bytes) > 1_048_576:
        raise HTTPException(status_code=422, detail="chunk too large (max 1 MB)")
    if len(raw_bytes) == 0:
        raise HTTPException(status_code=422, detail="chunk payload is empty")

    # ── Integrity check (PRD §3.7). Identical polynomial to the legacy
    #    endpoint; only the input alphabet differs (byte range vs ASCII).
    if checksum:
        computed = djb2_bytes(raw_bytes)
        if computed != checksum:
            try:
                chunk_transport_total.labels(transport='binary', outcome='rejected').inc()
            except Exception:
                pass
            raise HTTPException(
                status_code=400,
                detail=f"Checksum mismatch seq={seq_num}: expected {checksum}, got {computed}"
            )

    # Transport observability - post-checksum-verify so rejected uploads
    # don't bloat the `accepted` bucket.
    try:
        chunk_transport_total.labels(transport='binary', outcome='accepted').inc()
    except Exception:
        pass

    # ── Coerce form-flag bools. HTTP form fields are strings.
    blur_flag = str(client_blur_applied).lower() in ("1", "true", "yes", "y")
    photo_group = str(photo_group_id).strip() if photo_group_id else None
    if photo_group == "":
        photo_group = None

    # B-C (May 2026, alembic 0038) - client-supplied normalized face
    # boxes. PWA's BlazeFace pass at capture time emits a list of
    # {x, y, w, h} in [0.0, 1.0] coords; ships them on every chunk
    # upload via the X-Client-Face-Boxes header (same value on all
    # chunks for one media row). Server-side blur worker takes the
    # union with its own MediaPipe detection - privacy ratchets
    # forward only.
    #
    # Parse defensively: malformed JSON, oversized payloads, or
    # entries with invalid coord ranges are silently dropped. Worst-
    # case the server falls back to MediaPipe-only behaviour
    # (legacy / non-PWA contract). Never raises 4xx on a bogus
    # client hint.
    client_face_boxes: Optional[list] = None
    _hdr = request.headers.get("X-Client-Face-Boxes")
    if _hdr:
        # Guard rail on header size - a malicious client shouldn't
        # be able to ship MB of JSON in this header. 8 KB is huge
        # for the realistic case (~20 boxes × ~50 bytes each).
        if len(_hdr) > 8192:
            logger.warning(
                f"[chunk-bin] X-Client-Face-Boxes header too large "
                f"({len(_hdr)} bytes) from media={media_id[:8]}; ignoring."
            )
        else:
            try:
                _parsed = json.loads(_hdr)
                if isinstance(_parsed, list):
                    # Light shape-check on each entry. We don't enforce
                    # ranges here; blur_pii_with_hints's
                    # _denormalize_boxes handles that.
                    if all(isinstance(b, dict) for b in _parsed) and len(_parsed) <= 50:
                        client_face_boxes = _parsed
            except (json.JSONDecodeError, ValueError) as _exc:
                logger.warning(
                    f"[chunk-bin] X-Client-Face-Boxes malformed JSON "
                    f"({_exc}) from media={media_id[:8]}; ignoring."
                )

    # ── Find-or-create Media row. Mirrors the legacy endpoint exactly,
    #    including K.1.b's race-safe wrapper around the create path.
    from sqlalchemy.exc import IntegrityError as _MediaBinIntegrityError

    media = db.query(Media).filter(Media.id == media_id).first()
    # Chunk-cleanup guard (May 2026): see attach_media_chunk. A late/dup
    # chunk for an already-'complete' media must not re-seed reclaimed rows.
    if media is not None and media.assembly_status == 'complete':
        return {
            "media_id": media_id,
            "seq_num": seq_num,
            "received": media.received_chunks,
            "total": total_chunks,
            "completion_pct": media.completion_pct,
            "assembly_status": media.assembly_status,
            "transport": "binary",
        }
    if not media:
        from app.models.report import MediaTypeEnum as _MTE, ResolutionEnum as _RE
        try:
            media = Media(
                id=media_id,
                report_id=report_id,
                type=_MTE(type_upper),
                resolution_tier=_RE(tier_upper),
                photo_group_id=photo_group,
                url='',
                is_synced=False,
                chunk_count=total_chunks,
                received_chunks=0,
                completion_pct=0.0,
                assembly_status='pending',
                client_blur_applied=blur_flag,
                # B-C: optional client face-box hints. May be None
                # (non-PWA / legacy); server blur worker handles both.
                client_face_boxes_normalized=client_face_boxes,
                # Phase C.1 - persist the PWA-computed whole-asset checksum on
                # creation. Only chunk 0 carries this field; later chunks pass
                # None and `seq_num != 0` short-circuits the assignment below.
                full_asset_checksum=(full_asset_checksum if seq_num == 0 else None),
                # R2.a - seed epoch from client claim.
                upload_generation=upload_generation,
            )
            db.add(media)
            db.flush()
        except _MediaBinIntegrityError:
            db.rollback()
            media = db.query(Media).filter(Media.id == media_id).first()
            if not media:
                raise HTTPException(
                    status_code=500,
                    detail="media row creation race could not be reconciled",
                )
    else:
        # R2.a - epoch / generation check (chunk-bin endpoint). See
        # legacy chunk handler for the design notes. Run BEFORE R1
        # revival so stale-session chunks can't accidentally trigger
        # a revival.
        if upload_generation != media.upload_generation:
            logger.warning(
                f"[chunk-bin] generation mismatch on {media_id[:8]}: "
                f"client={upload_generation} server={media.upload_generation}; "
                f"rejecting as stale-session replay"
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "upload_generation_mismatch",
                    "server_generation": media.upload_generation,
                    "client_generation": upload_generation,
                    "media_id": media_id,
                    "message": (
                        "This upload session is stale. The server has "
                        "advanced upload_generation (typically because "
                        "the upload was abandoned and a fresh session "
                        "took over). Resync by re-reading the Media "
                        "row's current upload_generation and retrying "
                        "with that value, or allocate a fresh media_id."
                    ),
                },
            )
        # ── R1 (May 2026) - generalised soft-abandon revival ─────────────
        # The chunk handler is the only place with positive evidence of
        # client-side recovery (actual bytes arriving). The recovery
        # sweep daemon stays conservative and never auto-revives
        # abandoned rows by timer; that's intentional. Here we revive on
        # chunk arrival.
        #
        # Soft abandons (revivable on chunk arrival):
        #   - chunks_never_arrived     - daemon Action ③, client just
        #                                 came back online
        #   - assembly_worker_lost     - daemon Action ②, worker died
        #                                 mid-assembly but chunks may
        #                                 not all be in yet; client
        #                                 resending finishes the job
        #   - bandwidth_tier_deferred  - PWA pre-emptive defer; client
        #                                 retried after bandwidth recovered
        #
        # Hard abandons (NOT revivable - reject with 410 Gone at the top
        # of the handler so we don't pile chunks against a row whose
        # disk bytes are corrupt or already-rejected):
        #   - checksum_mismatch        - assembly worker found whole-
        #                                 asset djb2 mismatch; bytes on
        #                                 disk are wrong, can't fix by
        #                                 resending more chunks
        #   - original_too_large       - 5 MB cap rejected; resending
        #                                 doesn't shrink the asset
        #
        # The revival is one atomic UPDATE with the full WHERE clause so
        # a concurrent daemon UPDATE (write-then-read race) is harmless:
        # whoever lost the race reads the post-revival state.
        #
        # IMPORTANT: abandoned_at + abandon_reason stay populated (audit
        # trail). recovered_at gets stamped by the assembly worker on
        # successful post-revival completion. Dashboard chip predicate
        # flips to `abandon_reason && !recovered_at`.
        _HARD_ABANDON_REASONS = frozenset({
            'checksum_mismatch', 'original_too_large',
        })
        _SOFT_ABANDON_REASONS = frozenset({
            'chunks_never_arrived', 'assembly_worker_lost',
            'bandwidth_tier_deferred',
        })
        if (media.abandoned_at is not None
                and media.abandon_reason in _HARD_ABANDON_REASONS):
            # Reject - the client must allocate a fresh media_id.
            logger.warning(
                f"[chunk-bin] rejecting chunk for hard-abandoned media "
                f"{media_id[:8]} (reason={media.abandon_reason}); "
                f"client must allocate a new media_id."
            )
            raise HTTPException(
                status_code=410,
                detail=(
                    f"media row terminally abandoned "
                    f"({media.abandon_reason}); allocate a fresh media_id"
                ),
            )

        if (media.assembly_status == 'failed'
                and media.abandoned_at is not None
                and media.recovered_at is None
                and media.abandon_reason in _SOFT_ABANDON_REASONS):
            # Atomic revival. Only flips when the row matches exactly
            # the state we expect - if the daemon raced us into a
            # different state, this UPDATE is a no-op and assembly
            # proceeds from whatever state actually exists.
            #
            # NOTE: abandoned_at + abandon_reason are NOT cleared. They
            # remain the audit-trail signature of the original
            # abandonment. The post-completion `recovered_at` stamp
            # tells the dashboard the row recovered.
            update_payload = {
                'assembly_status': 'pending',
                # R2.a - bump epoch so post-revival stale chunks 409.
                'upload_generation': Media.upload_generation + 1,
            }
            # bandwidth_tier_deferred had two extra side effects in
            # the pre-R1 code that we still need: reset chunk_count to
            # the new total AND re-credit expected_media on the parent
            # report (mark-deferred decremented it when it abandoned
            # the row). We preserve those for this specific reason
            # only - other soft-abandon reasons don't need them
            # (chunks_never_arrived / assembly_worker_lost left
            # chunk_count and expected_media intact at abandon time).
            if media.abandon_reason == 'bandwidth_tier_deferred':
                update_payload.update({
                    'chunk_count': total_chunks,
                    'received_chunks': 0,
                    'completion_pct': 0.0,
                    'url': '',
                })
            revived = db.query(Media).filter(
                Media.id == media_id,
                Media.assembly_status == 'failed',
                Media.abandoned_at.isnot(None),
                Media.recovered_at.is_(None),
                Media.abandon_reason.in_(list(_SOFT_ABANDON_REASONS)),
            ).update(update_payload, synchronize_session=False)
            if revived and media.abandon_reason == 'bandwidth_tier_deferred':
                db.query(Report).filter(Report.id == report_id).update(
                    {Report.expected_media: Report.expected_media + 1},
                    synchronize_session="fetch",
                )
            if revived:
                logger.info(
                    f"[chunk-bin] revived {media_id[:8]} from "
                    f"abandon_reason={media.abandon_reason} "
                    f"(audit trail preserved; recovered_at stamped on assembly)"
                )
                try:
                    from app.core.observability import variant_uploads_total as _vut
                    _vut.labels(
                        tier=str(media.resolution_tier.value if media.resolution_tier else 'UNKNOWN'),
                        outcome='revived',
                    ).inc()
                except Exception:
                    pass
            db.flush()
            db.refresh(media)

        if blur_flag and not media.client_blur_applied:
            # Late-arriving blur flag (same upgrade path as the legacy endpoint).
            media.client_blur_applied = True
        # B-C: late-arriving face-box hints. If the row was created
        # without boxes (e.g. chunk 0 carried no header) but a later
        # chunk does have them, stamp them now. Don't overwrite an
        # existing non-empty value (the first one is canonical - the
        # PWA emits the same coords on every chunk for the same
        # media_id).
        if client_face_boxes and not media.client_face_boxes_normalized:
            media.client_face_boxes_normalized = client_face_boxes
        # Phase C.1 - late-arriving full-asset checksum. If chunk 0 was lost
        # or re-sent after an intermediate chunk landed first, accept the
        # value when the row doesn't already carry one. Don't overwrite an
        # existing non-NULL value (the original is canonical).
        if seq_num == 0 and full_asset_checksum and not media.full_asset_checksum:
            media.full_asset_checksum = full_asset_checksum
        # Tier upgrade - same conservative rule as the legacy JSON endpoint.
        # See attach_media_chunk's else branch for the full why.
        # Phase L (May 2026): the canonical "promote to top tier" trigger is
        # ORIGINAL now, not HIGH. _RE2.LOW / _RE2.HIGH were removed from
        # ResolutionEnum in alembic 0036 - referencing them here would
        # AttributeError. Use SMALL / ORIGINAL.
        from app.models.report import ResolutionEnum as _RE2
        if (tier_upper == "ORIGINAL"
                and media.resolution_tier in (_RE2.SMALL, _RE2.MEDIUM)):
            media.resolution_tier = _RE2.ORIGINAL

    # ── Idempotent insert. Mirrors the legacy endpoint byte-for-byte
    #    except the column we write (data_binary instead of data_b64).
    # K.1.b (May 2026, Phase K) - race-safe insert. See the legacy
    # `attach_media_chunk` handler for the full rationale.
    from sqlalchemy.exc import IntegrityError as _IntegrityError_bin

    existing_chunk = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id,
        MediaChunk.seq_num == seq_num
    ).first()

    is_new_chunk = not existing_chunk
    if is_new_chunk:
        try:
            db.add(MediaChunk(
                media_id=media_id,
                seq_num=seq_num,
                total_chunks=total_chunks,
                data_b64=None,            # legacy column NULL - binary wins
                data_binary=raw_bytes,
                checksum=checksum,
            ))
            db.flush()
        except _IntegrityError_bin:
            db.rollback()
            media = db.query(Media).filter(Media.id == media_id).first()
            is_new_chunk = False

    if is_new_chunk:
        # Atomic SQL-level increment - same race-safe pattern as the legacy path.
        db.query(Media).filter(Media.id == media_id).update(
            {"received_chunks": Media.received_chunks + 1,
             "chunk_count": total_chunks},
            synchronize_session="fetch"
        )
        db.flush()
        db.refresh(media)
        media.completion_pct = round((media.received_chunks / total_chunks) * 100, 1)

    db.commit()

    # ── Progressive partial assembly - same trigger cadence as legacy
    #    endpoint. FastAPI BackgroundTasks requires passing the Request
    #    chain, but we only need the side-effect; use the module-level
    #    executor directly for parity with the full-assembly trigger.
    is_final_chunk = media.received_chunks >= total_chunks
    media_type_enum_value = type_upper  # "IMAGE" | "AUDIO"
    if (is_new_chunk and not is_final_chunk and
        media_type_enum_value == "IMAGE" and
        media.received_chunks >= 3 and
        media.received_chunks % 3 == 0 and
        media.assembly_status != 'complete'):
        _assembly_executor.submit(_try_partial_image_bg, media_id)

    if (is_new_chunk and not is_final_chunk and
        media_type_enum_value == "AUDIO" and
        media.received_chunks >= 5 and
        media.received_chunks % 5 == 0 and
        media.assembly_status != 'complete'):
        _assembly_executor.submit(_try_partial_audio_bg, media_id, report_id)

    # ── Full-assembly CAS lock with stale-escape. Identical to the
    #    legacy endpoint at `attach_media_chunk`.
    db.refresh(media)
    logger.info(
        f"[ChunkBin] {media_id[:8]} seq={seq_num} "
        f"received={media.received_chunks}/{total_chunks} "
        f"status={media.assembly_status} new={is_new_chunk}"
    )
    if media.received_chunks >= total_chunks and media.assembly_status != 'complete':
        from datetime import datetime, timedelta, timezone as _tz
        stale_cutoff = datetime.now(_tz.utc) - timedelta(minutes=5)
        locked = db.query(Media).filter(
            Media.id == media_id,
            or_(
                Media.assembly_status == 'pending',
                and_(Media.assembly_status == 'assembling', Media.updated_at < stale_cutoff),
                Media.assembly_status == 'failed',
            )
        ).update({'assembly_status': 'assembling'}, synchronize_session=False)
        db.commit()
        if locked:
            logger.info(f"[ChunkBin] acquired assembly lock for {media_id[:8]}; enqueuing to pool")
            _assembly_executor.submit(
                _try_full_assembly_bg,
                media_id, type_upper, report_id
            )
        else:
            logger.info(
                f"[ChunkBin] {media_id[:8]} already locked by another worker "
                f"(status={media.assembly_status})"
            )

    return {
        "media_id": media_id,
        "seq_num": seq_num,
        "received": media.received_chunks,
        "total": total_chunks,
        "completion_pct": media.completion_pct,
        "assembly_status": media.assembly_status,
        "transport": "binary",
    }


# ── F3 - operator-gated media reclaim ──────────────────────────────────────
#
# Phase F image-reliability (May 2026). Operator surface for stuck / abandoned
# media uploads - companion to the periodic recovery sweep in app.main and
# the dashboard tri-state render. Two modes:
#
#   retry_assembly  - Only valid when received_chunks >= chunk_count (all
#                     chunks ARE on disk). Resets assembly_status to
#                     'pending', clears abandon metadata, and re-submits
#                     the row to the assembly pool. Salvages a sweep-
#                     abandoned row whose chunks were always there but
#                     the worker had died.
#
#   mark_abandoned  - Operator-declared terminal failure. Flips
#                     assembly_status to 'failed', stamps abandoned_at +
#                     abandon_reason='operator_manual'. Use when the
#                     operator KNOWS the upload won't ever complete (e.g.
#                     reporter is unreachable, device wiped) and wants
#                     the dashboard chip to stop pulsing.
#
# Idempotent: retry against an already-revived row is a no-op (sweep
# CAS prevents double-submit); mark_abandoned against an already-
# abandoned row keeps the original abandoned_at + abandon_reason.

from pydantic import BaseModel as _ReclaimBaseModel  # noqa: E402


class MediaReclaimRequest(_ReclaimBaseModel):
    mode: str  # "retry_assembly" | "mark_abandoned"


# ── K.2.d - mark-deferred endpoint (Phase K, May 2026) ───────────────────────
class MarkDeferredRequest(_ReclaimBaseModel):
    """PWA soft-drain / pre-emptive defer signal:
    'I gave up on these tiers per photo group'.

    Two callers:
      1. Soft-drain reconciler at dequeue time (K.3.a) - PWA tried to upload
         MEDIUM/ORIGINAL, the server doesn't show them. Mark deferred.
      2. Pre-emptive defer on VERY_SLOW networks (May 2026 follow-up) -
         PWA decided not to attempt MEDIUM/ORIGINAL because bandwidth was
         insufficient. Mark deferred so the dashboard chip is accurate.

    `media_ids_by_group_and_tier` is OPTIONAL: when provided, the placeholder
    Media row uses the PWA's planned mediaId, so a LATER successful upload
    (network improves, retry-loop fires) reuses + revives the same row
    instead of creating a duplicate.
    """
    tiers_by_group: dict  # { "<photo_group_id>": ["MEDIUM", "ORIGINAL"] }
    reason: Optional[str] = "bandwidth_tier_deferred"
    # Optional shape: { "<photo_group_id>": { "MEDIUM": "<mediaId>", "ORIGINAL": "<mediaId>" } }
    media_ids_by_group_and_tier: Optional[dict] = None


@router.post("/{report_id}/media/mark-deferred", status_code=status.HTTP_200_OK)
def mark_media_deferred(
    report_id: str,
    payload: MarkDeferredRequest,
    db: Session = Depends(get_db),
):
    """K.2.d (May 2026, Phase K). Backend-side companion to the PWA's
    soft-drain at mobile-app/src/app.js:10170-10178.

    When the PWA's bandwidth tier detection defers MEDIUM/HIGH variants
    indefinitely (SLOW / VERY_SLOW networks), the SMALL variant lands
    but the higher tiers never do. The PWA's queue dequeues at SMALL
    completion (May 2026 'SMALL gates the photo stage' fix) but the
    backend's `expected_media` stays at the original 3-per-photo count,
    keeping `sync_status=PARTIAL` forever.

    This endpoint takes the PWA's explicit "I gave up" signal and:
      1. For each (photo_group_id, tier) marked deferred, find or
         create a placeholder Media row stamped:
           - assembly_status = 'failed'
           - abandon_reason  = 'bandwidth_tier_deferred'  (default)
           - abandoned_at    = now
      2. Decrement `report.expected_media` by the count of new
         abandon-stamps (so the SYNCED gate becomes honest).
      3. Re-evaluate the SYNCED promotion gate.

    Idempotent: calling twice with the same payload is a noop (rows
    already in `failed` state aren't re-stamped, expected_media isn't
    re-decremented).

    Dashboard K.5.a chip-row renders "📶 Original (slow network)" for
    rows with `abandon_reason='bandwidth_tier_deferred'`.
    """
    report = db.query(Report).filter(Report.id == report_id).with_for_update().first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if not isinstance(payload.tiers_by_group, dict) or not payload.tiers_by_group:
        raise HTTPException(
            status_code=422,
            detail="tiers_by_group must be a non-empty dict of {photo_group_id: [tiers]}",
        )

    reason = payload.reason or "bandwidth_tier_deferred"
    # Phase L (May 2026) - canonical vocabulary only. Legacy LOW/HIGH
    # tier names are rejected (dropped from enum in alembic 0036).
    valid_tiers = {"SMALL", "MEDIUM", "ORIGINAL"}
    valid_reasons = {
        "bandwidth_tier_deferred", "encode_failed", "orphan_no_source",
        # R6 (Jun 2026): the client EVICTED this non-SMALL tier's bytes under
        # device storage pressure AFTER its SMALL preview had already delivered,
        # so the analyst keeps a usable preview while the full-resolution upload
        # is deferred (not silently lost). Distinct from bandwidth_tier_deferred
        # so the dashboard can render "deferred - storage" vs "couldn't deliver".
        "storage_evicted",
    }
    if reason not in valid_reasons:
        raise HTTPException(
            status_code=422,
            detail=f"invalid reason {reason!r}; expected one of {sorted(valid_reasons)}",
        )

    from datetime import datetime as _dt, timezone as _tz
    now_utc = _dt.now(_tz.utc)
    newly_stamped = 0

    for photo_group_id, tiers in payload.tiers_by_group.items():
        if not photo_group_id or not isinstance(tiers, list):
            continue
        for tier_raw in tiers:
            tier = str(tier_raw).upper()
            if tier not in valid_tiers:
                continue
            try:
                tier_enum = ResolutionEnum(tier)
            except ValueError:
                continue

            # Find existing Media row for this (report, group, tier).
            existing = db.query(Media).filter(
                Media.report_id == report.id,
                Media.photo_group_id == photo_group_id,
                Media.resolution_tier == tier_enum,
            ).first()

            if existing:
                # If already in a terminal state with this reason, skip
                # (idempotent). If complete, also skip - a SMALL/MEDIUM
                # /HIGH that DID land beats the PWA's soft-drain claim.
                if existing.assembly_status == "complete":
                    continue
                if existing.assembly_status == "failed" and existing.abandoned_at is not None:
                    continue
                existing.assembly_status = "failed"
                existing.abandon_reason = reason
                existing.abandoned_at = now_utc
                newly_stamped += 1
            else:
                # Create a placeholder Media row so the dashboard's
                # photo-group renderer knows the tier was attempted +
                # gave up. URL stays empty (no asset to fetch).
                #
                # Use the PWA's planned mediaId when supplied so a later
                # successful upload (bandwidth improved, retry fired)
                # reuses + revives this same row instead of creating a
                # duplicate. The chunk-bin endpoint detects the revival
                # via the failed/bandwidth_tier_deferred state and clears
                # abandon_at + abandon_reason at chunk-0 receive.
                import uuid as _uuid
                placeholder_id: Optional[str] = None
                if isinstance(payload.media_ids_by_group_and_tier, dict):
                    group_map = payload.media_ids_by_group_and_tier.get(photo_group_id)
                    if isinstance(group_map, dict):
                        candidate = group_map.get(tier)
                        if isinstance(candidate, str) and len(candidate) == 36:
                            placeholder_id = candidate
                placeholder = Media(
                    id=placeholder_id or str(_uuid.uuid4()),
                    report_id=report.id,
                    type=MediaTypeEnum.IMAGE,  # tier deferral only applies to images
                    resolution_tier=tier_enum,
                    photo_group_id=photo_group_id,
                    url="",
                    is_synced=False,
                    chunk_count=0,
                    received_chunks=0,
                    completion_pct=0.0,
                    assembly_status="failed",
                    abandon_reason=reason,
                    abandoned_at=now_utc,
                )
                db.add(placeholder)
                newly_stamped += 1

    if newly_stamped > 0:
        # Decrement expected_media by the count of new abandon-stamps so
        # the SYNCED gate becomes honest. Floor at received_media (can't
        # go below what's already landed).
        new_expected = max(
            report.received_media or 0,
            (report.expected_media or 0) - newly_stamped,
        )
        if new_expected != report.expected_media:
            report.expected_media = new_expected
        # Re-evaluate SYNCED gate.
        if (report.expected_media > 0
                and (report.received_media or 0) >= report.expected_media
                and report.sync_status != SyncStatusEnum.SYNCED):
            report.sync_status = SyncStatusEnum.SYNCED
            logger.info(
                f"[MarkDeferred] report {report_id[:8]} promoted to SYNCED "
                f"(expected={report.expected_media}, received={report.received_media})"
            )

    db.commit()
    db.refresh(report)

    # K.6.c - bandwidth_tier_deferred SLI. Only count rows we
    # actually flipped (idempotent re-call returns 0 here so we
    # don't double-count an operator's retry).
    if newly_stamped > 0:
        try:
            from app.core.observability import media_abandon_reason_total
            media_abandon_reason_total.labels(
                reason="bandwidth_tier_deferred",
            ).inc(newly_stamped)
        except Exception:
            pass

    return {
        "report_id": report.id,
        "newly_stamped": newly_stamped,
        "expected_media": report.expected_media,
        "received_media": report.received_media,
        "sync_status": report.sync_status.value if hasattr(report.sync_status, "value") else report.sync_status,
    }


@router.post("/media/{media_id}/reclaim", status_code=status.HTTP_200_OK)
def reclaim_media(
    media_id: str,
    payload: MediaReclaimRequest,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
):
    """Operator-driven reclaim for a stuck or abandoned media upload.

    See module-level F3 comment above for the two modes. Emits an
    `AuthAuditLog` row keyed on the report_id so the dashboard's
    admin-action ribbon shows the reclaim in the timeline.
    """
    from datetime import datetime as _dt, timezone as _tz

    media = db.query(Media).filter(Media.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")

    mode = (payload.mode or "").strip()

    if mode == "retry_assembly":
        # Hard guard: can't retry assembly when the chunks aren't actually
        # there. Operator should pick `mark_abandoned` instead.
        if media.chunk_count == 0 or media.received_chunks < media.chunk_count:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot retry assembly: received_chunks="
                    f"{media.received_chunks}, chunk_count={media.chunk_count}. "
                    f"Use mode=mark_abandoned for incomplete uploads."
                ),
            )

        media.assembly_status = "pending"
        media.abandoned_at = None
        media.abandon_reason = None
        _audit_report_action(
            db, user, "MEDIA_RECLAIM_RETRY", media.report_id,
            details=f"media_id={media_id}",
        )
        db.commit()
        db.refresh(media)

        # Resubmit to the assembly pool - _try_full_assembly_bg's own CAS
        # handles double-submits safely.
        try:
            _assembly_executor.submit(
                _try_full_assembly_bg,
                media.id,
                media.type.value,
                media.report_id,
            )
        except Exception as e:
            logger.warning(f"[Reclaim] failed to enqueue {media_id[:8]}: {e}")

        return {
            "media_id": media.id,
            "mode": "retry_assembly",
            "assembly_status": media.assembly_status,
            "abandoned_at": media.abandoned_at,
            "abandon_reason": media.abandon_reason,
        }

    if mode == "mark_abandoned":
        # Operator-declared terminal failure. If already abandoned, keep
        # the original timestamp + reason for audit fidelity; only stamp
        # if the row hadn't been abandoned yet.
        if media.abandoned_at is None:
            media.abandoned_at = _dt.now(_tz.utc)
            media.abandon_reason = "operator_manual"
        media.assembly_status = "failed"
        _audit_report_action(
            db, user, "MEDIA_RECLAIM_ABANDON", media.report_id,
            details=f"media_id={media_id}",
        )
        db.commit()
        db.refresh(media)

        return {
            "media_id": media.id,
            "mode": "mark_abandoned",
            "assembly_status": media.assembly_status,
            "abandoned_at": media.abandoned_at,
            "abandon_reason": media.abandon_reason,
        }

    raise HTTPException(
        status_code=400,
        detail=f"Unknown mode '{mode}'. Use 'retry_assembly' or 'mark_abandoned'.",
    )


@router.post("/", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report(report_in: ReportCreate, request: Request, db: Session = Depends(get_db)):
    """
    Ingest a new multi-modal incident report locally.
    This endpoint supports rich JSON graphs combining GPS telemetry,
    offline user classification, and associated base64 media blocks.
    """
    # Rate limit: 30 reports/min per device
    from app.main import check_rate_limit
    if not check_rate_limit(f"report:{report_in.device_hash}", 30, 60):
        raise HTTPException(status_code=429, detail="Rate limit exceeded - try again later")
    
    # 0. Idempotency + collision detection (P1.6 - same guard as /meta).
    if report_in.client_report_id:
        existing = db.query(Report).filter(
            Report.client_report_id == report_in.client_report_id
        ).first()
        if existing:
            existing_owner_hash = None
            if existing.device_id:
                _dev = db.query(Device).filter(Device.id == existing.device_id).first()
                existing_owner_hash = _dev.device_hash if _dev else None
            if existing_owner_hash and existing_owner_hash == report_in.device_hash:
                logger.info(f"Idempotent hit: client_report_id={report_in.client_report_id}")
                return existing
            logger.warning(
                f"client_report_id collision at /reports: {report_in.client_report_id} "
                f"(existing {existing_owner_hash}, new {report_in.device_hash})"
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "client_report_id_conflict",
                    "message": "client_report_id already used by a different device - regenerate and retry",
                    "existing_report_id": existing.id,
                }
            )

    # 1. Device Resolution
    # Look up or auto-register the offline device hash
    device = db.query(Device).filter(Device.device_hash == report_in.device_hash).first()
    if not device:
        device = Device(device_hash=report_in.device_hash)
        db.add(device)
        db.commit()
        db.refresh(device)

    # 2. Report Creation
    # Dump Pydantic model excluding nested objects for manual handling
    report_dict = report_in.model_dump(exclude={"location", "media", "device_hash"})
    # UNDP must-have #6 - pre-create the parent `buildings` row for any
    # PWA-supplied OSM footprint so the FK on the subsequent report INSERT
    # is satisfied. Same rationale as in /reports/meta: without this, a
    # tap on an OSM footprint not yet mirrored into `buildings` trips
    # `fk_reports_building_id` and 500s the submission. The FK forces dropping
    # building_id on upsert failure, but we KEEP infrastructure_name_from_osm=true
    # (the reporter tapped a real OSM footprint) so the name still surfaces once a
    # proximity building is linked — same rationale as /reports/meta above.
    if report_dict.get("building_id"):
        resolved_bid = _ensure_building_for_pwa_pick(
            db,
            report_dict["building_id"],
            osm_name=(
                report_dict.get("infrastructure_name")
                if report_dict.get("infrastructure_name_from_osm")
                else None
            ),
        )
        if resolved_bid is None:
            report_dict["building_id"] = None   # FK-forced; keep the from_osm provenance
    db_report = Report(**report_dict, device_id=device.id)
    db.add(db_report)
    db.commit()
    db.refresh(db_report)

    # 3. Geo-Telemetry Attachment
    if report_in.location:
        loc_data = report_in.location.model_dump()

        # HC55 - server-side forward-geocoding for offline-typed names
        # now routes through _resolve_user_location_name() so the
        # cascade enjoys Mapbox primary + rate-limited Nominatim
        # fallback + cache.
        if (loc_data.get('user_location_name')
                and loc_data.get('latitude', 0) == 0
                and loc_data.get('longitude', 0) == 0):
            _resolve_user_location_name(loc_data)

        db_loc = Location(**loc_data, report_id=db_report.id)
        db.add(db_loc)
    
    # 4. Media Block Harvesting
    # The payload can contain base64 encoded strings mapped to their types (IMAGE/AUDIO)
    # We serialize them to local disk for the local AI pipeline to access
    saved_media_entities = []
    if report_in.media:
        for m in report_in.media:
            # Handle Base64 Local Materialization
            file_url = m.url
            if m.url.startswith("data:"):
                try:
                    header, encoded = m.url.split(",", 1)

                    # Decode base64
                    try:
                        file_data = base64.b64decode(encoded)
                    except Exception as decode_err:
                        logger.error(f"Base64 decode error: {decode_err}")
                        file_data = b""

                    if not file_data:
                        logger.warning("Empty file data after base64 decode")
                        raise ValueError("Base64 decoding produced empty data")

                    # magic-byte detection (see _detect_audio_format
                    # comment block). Was hardcoded to .webm for all audio,
                    # which broke iOS captures (MP4 bytes in a .webm wrapper
                    # → browser decode failure).
                    if "image" in header:
                        ext = "png" if "png" in header else "jpg"
                        content_type = _content_type_for(f"x.{ext}")
                    else:
                        ext, content_type = _detect_audio_format(header, file_data)
                    filename = f"{db_report.id}_{time.time()}.{ext}"

                    # (PR 2) - write through the storage
                    # backend (S3 in prod). No persistent EC2 disk usage.
                    file_url = _get_media_storage().save(filename, file_data, content_type)
                    logger.info(
                        f"Saved {ext} ({content_type}) file: {filename} "
                        f"({len(file_data)} bytes) → {file_url}"
                    )

                except Exception as e:
                    logger.error(f"Error handling base64 extract for {m.type}: {type(e).__name__}: {e}")
                    import traceback
                    logger.error(traceback.format_exc())
                
            db_media = Media(
                report_id=db_report.id,
                type=m.type,
                resolution_tier=m.resolution_tier,
                url=file_url,
                file_size_bytes=m.file_size_bytes
            )
            db.add(db_media)
            saved_media_entities.append(db_media)

    # K.2.g (May 2026, Phase K) - count the media we just persisted +
    # promote sync_status if everything expected has landed. Pre-fix
    # this endpoint added Media rows but never incremented
    # `received_media` or evaluated the SYNCED gate, so 3rd-party
    # integrations hitting the one-shot path got reports stuck at
    # PARTIAL forever. PWA / Telegram / messaging-bot all use
    # /meta + /chunk-bin so they avoided the bug - but the endpoint
    # is still public and we shouldn't leave a foot-gun.
    if saved_media_entities:
        db_report.received_media = len(saved_media_entities)
        if (db_report.expected_media is None) or (db_report.expected_media == 0):
            # Caller didn't declare expected; infer it from what
            # actually landed. Conservative - we know at least these
            # arrived; if more were intended the dashboard's
            # Action ④ idle-promote will still catch up.
            db_report.expected_media = len(saved_media_entities)
        if (db_report.expected_media > 0
                and db_report.received_media >= db_report.expected_media):
            db_report.sync_status = SyncStatusEnum.SYNCED

    db.commit()

    # Building-centric Incident-Feed redesign Phase 2B - the legacy one-shot path
    # also gets building + incident assignment (parity with create_report_meta).
    # It carries media at create time, so the incident scorer has full signal
    # (pHash + description) and a true duplicate can auto-join here. Best-effort.
    _auto_assign_building_id(db_report, db)
    _assign_incident(db_report, db)
    db.commit()

    # 5. Pipeline Trigger: Local AI NLP processing
    # If the user included voice notes, transcribe them synchronously for the
    # MVP to provide immediate tactical insight. Image media carries no
    # automated analysis here - the analyst-facing AI credibility dossier
    # comes from POST /{id}/ai-assess, not this ingest path.
    transcription_result = None

    audio_files = [m.url for m in saved_media_entities if m.type == MediaTypeEnum.AUDIO]
    logger.info(f"Found {len(audio_files)} audio files for transcription")
    if audio_files:
        # Pass the first local audio to Whisper for offline NLP
        url = audio_files[0]
        logger.info(f"Processing audio file: {url}")
        path = url.replace("/static/", "")
        disk_path = os.path.join(UPLOAD_DIR, path)
        logger.info(f"Full disk path: {disk_path}")
        logger.info(f"File exists: {os.path.exists(disk_path)}")
        if os.path.exists(disk_path):
            logger.info(f"File size: {os.path.getsize(disk_path)} bytes")
            logger.info("Starting transcription...")
            transcription_result = ai_service.transcribe_audio(disk_path)
            logger.info(f"Transcription result: {transcription_result[:100] if transcription_result else 'EMPTY'}")
        else:
            logger.error(f"Audio file not found at: {disk_path}")

    # Hydrate AI analysis table
    if transcription_result:
        db_ai = AIAnalysis(
            report_id=db_report.id,
            transcription=transcription_result,
        )
        db.add(db_ai)
        db.commit()

    db.refresh(db_report)
    return db_report


@router.get("/markers")
def list_report_markers(
    db: Session = Depends(get_db),
    _user=Depends(require_viewer),
    limit: int = Query(5000, ge=1, le=20000),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
    since: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="comma-separated"),
    crisis_event_id: Optional[str] = Query(None, description="scope to one operation"),
    include_duplicates: bool = False,
):
    """Lightweight map markers - id + coords + severity/status/type ONLY (a
    column tuple query joined to Location; NO media/AI/verification eager loads).

    The dashboard map used GET /reports/?limit=200 (heavy rows, capped at 500),
    so at 100k/500k it plotted a non-representative newest-200 slice. This ships
    up to 20k lean points (a few KB each → no N+1, no serializer walk) so the
    global Common Operating Picture is honest at scale. Optional bbox lets a
    zoomed map fetch only its view. Ordered newest-first within the cap."""
    safe_limit = max(1, min(limit, 20000))

    def _ev(v):
        return getattr(v, "value", v)

    q = (
        db.query(
            Report.id, Location.latitude, Location.longitude,
            Report.severity, Report.status, Report.crisis_type,
            Report.infrastructure_type, Report.server_created_at,
            Report.crisis_event_id,   # ROUTE-04: lets a map/recent click open in the right op context
        )
        .join(Location, Location.report_id == Report.id)
        .filter(
            Report.deletion_requested_at.is_(None),
            Location.latitude.isnot(None), Location.longitude.isnot(None),
        )
    )
    if crisis_event_id:
        q = q.filter(Report.crisis_event_id == crisis_event_id)
    # Duplicate collapse: one marker per incident. Hide merged-away duplicates so
    # the map shows the primary only (with a "N reports" badge), never overlapping
    # pins for confirmed duplicates. Same resolver as the feed → they agree.
    dup_hidden, dup_primary_count = _resolve_duplicate_groups(db)
    if dup_hidden and not include_duplicates:
        q = q.filter(Report.id.notin_(dup_hidden))
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        q = q.filter(Report.status.in_(statuses)) if len(statuses) > 1 \
            else q.filter(Report.status == statuses[0])
    if since:
        try:
            q = q.filter(Report.server_created_at >= datetime.fromisoformat(since.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail=f"Invalid 'since' timestamp: {since!r}")
    if bbox:
        try:
            min_lng, min_lat, max_lng, max_lat = [float(x) for x in bbox.split(",")]
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail=f"Invalid bbox (want 'minLng,minLat,maxLng,maxLat'): {bbox!r}")
        q = q.filter(
            Location.longitude >= min_lng, Location.longitude <= max_lng,
            Location.latitude >= min_lat, Location.latitude <= max_lat,
        )
    rows = q.order_by(Report.server_created_at.desc()).limit(safe_limit).all()
    return [
        {
            "id": r.id, "lat": r.latitude, "lng": r.longitude,
            "severity": _ev(r.severity), "status": _ev(r.status),
            "crisis_type": r.crisis_type, "infrastructure_type": _ev(r.infrastructure_type),
            "server_created_at": r.server_created_at.isoformat() if r.server_created_at else None,
            "crisis_event_id": r.crisis_event_id,   # ROUTE-04: open in the incident's operation context
            "duplicate_count": dup_primary_count.get(r.id, 0),   # merged-away dups under this primary (map "N reports" badge)
        }
        for r in rows
    ]


# ── Duplicate review surfaces (static paths MUST precede GET /{report_id}) ─────
# Defined here so they don't collide with the catch-all `/{report_id}` route
# below; the _rdd_* helpers they call live further down + resolve at call time.
@router.get("/duplicate-summary")
def duplicate_summary(crisis_event_id: Optional[str] = Query(None, description="scope to one operation"),
                      building_id: Optional[str] = Query(None, description="scope to one building"),
                      db: Session = Depends(get_db), user=Depends(require_viewer)):
    """Counts of UNCONFIRMED probable-duplicate pairs by confidence - backs the review
    panels (Operations Home "Potential Duplicates: N", the Incidents page breakdown, and
    the per-building 'Potential Duplicates' section on the Building Details page)."""
    high = med = low = 0
    for _a, _b, level in _rdd_candidate_pairs(db, crisis_event_id, building_id):
        if level == "HIGH":
            high += 1
        elif level == "MEDIUM":
            med += 1
        else:
            low += 1
    return {"high": high, "medium": med, "low": low, "total": high + med + low}


@router.get("/buildings-needing-review")
def buildings_needing_review(crisis_event_id: Optional[str] = Query(None, description="scope to one operation"),
                             db: Session = Depends(get_db), user=Depends(require_viewer)):
    """Building-centric redesign — AWARENESS feed. Lists the buildings that have
    UNSETTLED duplicate-candidate pairs an analyst should review, so the global
    'Potential Duplicates' merge panel can be removed WITHOUT losing cross-building
    visibility (merge itself happens only inside a building/operation workspace).
    Reuses `_rdd_candidate_pairs` (building-scoped dedup) so this agrees with the
    per-building 'Potential Duplicates' counts. Returns worst-first. Same cost class
    as /duplicate-summary; the dashboard caches it."""
    agg: dict = {}
    for a, b, level in _rdd_candidate_pairs(db, crisis_event_id=crisis_event_id):
        bid = a.building_id  # pairs only form within a building (cluster), so this is set
        if not bid:
            continue
        e = agg.setdefault(bid, {"pairs": 0, "report_ids": set(), "high": 0, "medium": 0, "low": 0})
        e["pairs"] += 1
        e["report_ids"].add(a.id)
        e["report_ids"].add(b.id)
        e[level.lower()] += 1
    name_map: dict = {}
    if agg:
        from app.models.report import Building
        for bid, osm_name in db.query(Building.id, Building.osm_name).filter(Building.id.in_(list(agg.keys()))).all():
            name_map[bid] = osm_name
    out = [{
        "building_id": bid,
        "building_name": name_map.get(bid) or "Building",
        "candidate_pairs": v["pairs"],
        "report_count": len(v["report_ids"]),
        "high": v["high"], "medium": v["medium"], "low": v["low"],
    } for bid, v in agg.items()]
    out.sort(key=lambda x: (-x["high"], -x["candidate_pairs"]))
    return {"buildings": out, "total_buildings": len(out),
            "total_pairs": sum(x["candidate_pairs"] for x in out)}


class DuplicateMergeRequest(_ReclaimBaseModel):
    confidence: str                                # HIGH | MEDIUM | LOW | ALL
    crisis_event_id: Optional[str] = None          # scope to one operation
    building_id: Optional[str] = None              # scope to one building (Building Details)


@router.post("/duplicate-merge")
def duplicate_merge(req: DuplicateMergeRequest, db: Session = Depends(get_db),
                    user=Depends(require_analyst)):
    """Bulk-confirm duplicates in ONE action - backs the "Merge all" + "Merge All
    High / Medium / Low" buttons. confidence=ALL collapses every level at once so the
    operator clicks once, not per-level and not pair-by-pair.

    GROUP-AWARE: a union-find over the candidate pairs (plus any existing confirmed
    groupings) means a whole cluster/chain collapses under ONE primary in a single
    pass - never leaving stragglers that need another click. The surviving PRIMARY is
    the report that LANDED FIRST (the original), ties broken toward the MOST-COMPLETE
    report (_rdd_info_score); an existing primary in the cluster is reused so we
    extend its star rather than spawning a parallel one. Analyst-controlled, never
    auto. Fully reversible (each is an undoable CONFIRMED_DUP); nothing is deleted."""
    import uuid
    from datetime import datetime, timezone as _tz
    level = (req.confidence or "").strip().upper()
    if level not in ("HIGH", "MEDIUM", "LOW", "ALL"):
        raise HTTPException(status_code=400, detail="confidence must be HIGH|MEDIUM|LOW|ALL")
    wanted = {"HIGH", "MEDIUM", "LOW"} if level == "ALL" else {level}
    now = datetime.now(_tz.utc)
    actor = getattr(user, "id", None)

    # 1. Unsettled candidate pairs at the wanted level(s); keep the Report objects.
    reps_by_id: dict = {}
    edges = []
    for a, b, lv in _rdd_candidate_pairs(db, req.crisis_event_id, req.building_id):
        if lv not in wanted:
            continue
        reps_by_id[a.id] = a
        reps_by_id[b.id] = b
        edges.append((a.id, b.id))
    if not edges:
        return {"merged": 0, "confidence": level}

    # 2. Fold EXISTING confirmed stars into the graph so a new pair touching an
    #    already-merged cluster EXTENDS it (reuses its primary) instead of forking.
    confirmed = (db.query(ReportDuplicateDecision)
                 .filter(ReportDuplicateDecision.undone_at.is_(None),
                         ReportDuplicateDecision.decision == "CONFIRMED_DUP",
                         ReportDuplicateDecision.related_report_id.isnot(None)).all())
    already_related = set()
    existing_primary_ids = set()
    for d in confirmed:
        already_related.add(d.related_report_id)
        existing_primary_ids.add(d.primary_report_id)
        edges.append((d.primary_report_id, d.related_report_id))

    # 3. Union-find -> connected components (the cluster collapses as one).
    parent: dict = {}

    def _find(x):
        parent.setdefault(x, x)
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for x, y in edges:
        parent[_find(x)] = _find(y)
    groups: dict = {}
    for node in list(parent.keys()):
        groups.setdefault(_find(node), set()).add(node)

    merged = 0
    for _root, member_ids in groups.items():
        # NEW (unsettled) reports we can still collapse in this cluster.
        new_members = [reps_by_id[m] for m in member_ids
                       if m in reps_by_id and m not in already_related]
        if not new_members:
            continue
        # PRIMARY: reuse the cluster's existing primary if any; else the richest NEW
        # member, earliest-wins-ties.
        prim_id = next((m for m in member_ids
                        if m in existing_primary_ids and m not in already_related), None)
        if prim_id and prim_id in reps_by_id:
            primary = reps_by_id[prim_id]
        elif prim_id:
            primary = db.query(Report).filter(Report.id == prim_id).first()
        else:
            # PRIMARY = the report that LANDED FIRST (the original); ties broken
            # toward the MOST-COMPLETE report (_rdd_info_score). Flip the key order
            # to make richest-wins the dominant rule instead.
            primary = max(new_members, key=lambda r: (
                -((r.server_created_at or now).timestamp()), _rdd_info_score(r)))
        if primary is None:
            continue
        ckey = _rdd_cluster_key(primary)
        for r in new_members:
            if r.id == primary.id:
                continue
            db.add(ReportDuplicateDecision(
                id=str(uuid.uuid4()), cluster_key=ckey,
                primary_report_id=primary.id, related_report_id=r.id,
                decision="CONFIRMED_DUP", actor_user_id=actor))
            # Bump updated_at so the dashboard delta poll re-collapses these reports.
            primary.updated_at = now
            r.updated_at = now
            already_related.add(r.id)
            merged += 1
    if merged:
        db.commit()
    return {"merged": merged, "confidence": level}


@router.get("/", response_model=List[ReportResponse])
def get_reports(
    request: Request,
    response: Response,
    skip: int = 0,
    limit: int = 100,
    include_deleted: bool = False,
    pending_deletion: bool = False,   # M15: list ONLY pending-deletion reports (for the deletions badge/panel)
    include_duplicates: bool = False,  # when true, also return reports confirmed as duplicates (detail/admin); default collapses them
    since: Optional[datetime] = Query(
        None,
        description=(
            "ISO 8601 timestamp (e.g. 2026-05-09T18:30:00Z). When set, returns "
            "ONLY reports whose own row, or any of their media rows, has been "
            "updated since this time. Dashboard reads X-Server-Time on each "
            "response and echoes it back as `since` on the next poll for "
            "incremental delta sync - typical poll body drops from ~440 KB to "
            "<2 KB on idle dashboards. Omit `since` for the initial full load."
        ),
    ),
    crisis_event_id: Optional[str] = Query(
        None,
        description=(
            "Scope the listing to a single operation (CrisisEvent id). When set, "
            "only reports stamped with this crisis_event_id are returned and "
            "X-Total-Count reflects the scoped total. Omit for the global feed."
        ),
    ),
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
):
    """
    Retrieve aggregated tactical reports for the dashboard sync client.
    By default, excludes reports pending deletion (24h grace period).
    Pass ?include_deleted=true to see them (admin use).

    P2.1 - the serializer walks every Report's media + ai_analysis + location
    + verification. Without eager loading this is an N+1: a 1000-row dashboard
    fetch fires 4001+ queries. `joinedload` pulls all relationships in one
    wide SELECT per relationship, taking the query count to ~5 regardless of N.

    P2.11 - also returns X-Total-Count header and caps `limit` at 500 so a
    misbehaving client can't pull the whole table in one shot. The dashboard
    reads the header to drive its pagination / infinite-scroll.

    Phase 3 (May 2026, HAR-driven) - `since` parameter enables incremental
    delta polling. The dashboard's per-poll body shrank from ~440 KB to ~1-2 KB
    when no reports changed in the last 4 s. We capture `cursor` BEFORE
    running the query and emit it via X-Server-Time so any reports landing
    DURING query execution still surface on the next poll (avoids the gap-
    interval missed-update class of bugs).
    """
    # Safety caps: dashboard may ask for more than the DB can comfortably ship.
    safe_limit = max(1, min(limit, 500))
    safe_skip = max(0, skip)

    # Phase 3: capture the server clock BEFORE running the query so any
    # report mutated in parallel still falls within the next poll's window.
    cursor = datetime.now(timezone.utc)

    q = db.query(Report)
    if pending_deletion:
        # M15 (Phase-4): the deletions badge/panel needs ONLY the reports pending
        # deletion, with an accurate total. Filtering server-side (+ X-Total-Count)
        # replaces the old client-side filter over the newest-500 listing slice,
        # which silently undercounted pending deletions beyond row 500 at scale.
        q = q.filter(Report.deletion_requested_at.isnot(None))
    elif not include_deleted:
        q = q.filter(Report.deletion_requested_at == None)

    # Operations Phase 2: scope the feed to one operation. Applied BEFORE the
    # total-count scalar below so X-Total-Count reports the scoped total (the
    # dashboard truncation banner would otherwise show the global count).
    if crisis_event_id:
        q = q.filter(Report.crisis_event_id == crisis_event_id)

    # Duplicate collapse: a report confirmed as a duplicate of another collapses
    # UNDER its PRIMARY (the operational incident shown in the feed). Hide the
    # merged-away members from the default feed - they stay in the DB and remain
    # reachable by id + via ?include_duplicates=true. Resolved once here so the
    # per-primary badge count attached below agrees with the listing. The
    # X-Total-Count scalar runs AFTER this filter, so the visible total stays honest.
    dup_hidden, dup_primary_count = _resolve_duplicate_groups(db)
    if dup_hidden and not include_duplicates and not pending_deletion:
        q = q.filter(Report.id.notin_(dup_hidden))

    # Phase 3: delta filter. Match reports whose own row OR any of their
    # media rows has updated since `since`. Media is included because the
    # chunked-upload pipeline only bumps `report.updated_at` at assembly-
    # complete (via received_media++); per-chunk progress lives on
    # Media.updated_at, and partial-upload progress visualisation in the
    # dashboard would stop animating without the EXISTS clause.
    if since is not None:
        # Strip tzinfo for the comparison if the column is tz-naive - but
        # our columns are tz-aware (DateTime(timezone=True)) so a tz-aware
        # comparand is correct. Normalise to UTC just in case the client
        # sends an offset-bearing value.
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        else:
            since = since.astimezone(timezone.utc)
        q = q.filter(or_(
            Report.updated_at > since,
            Report.media.any(Media.updated_at > since),
        ))

    # Total count for pagination (cheap indexed count, no relationships).
    total = q.with_entities(sa_func.count(Report.id)).scalar() or 0

    q = q.options(
        joinedload(Report.media),
        joinedload(Report.location),
        joinedload(Report.ai_analysis),
        joinedload(Report.verification),
        joinedload(Report.device),
    )
    reports = (
        q.order_by(Report.server_created_at.desc())
         .offset(safe_skip)
         .limit(safe_limit)
         .all()
    )

    # Phase 1.6 (May 2026) - Dashboard V4 field parity. The
    # ReportResponse schema carries `reporter_tier` for the masked
    # reporter badge. Bulk-fetch tier mappings for every device_hash
    # in this page in ONE query (no N+1), then stash on each Report
    # as a transient attribute. The model_validator on
    # `_compute_identity_badge` picks it up - keeps the join logic in
    # the endpoint where the session is live, and the projection
    # logic in the schema where the rest of the derived fields live.
    _attach_reporter_tier(db, reports)
    _attach_operation_name(db, reports)
    # Roll the merged-away duplicate count onto each primary so the feed card can
    # render "N duplicate reports merged" (transient read-time attr, like the
    # operation-name + reporter-tier attaches above; default 0 for non-primaries).
    for _r in reports:
        _r.duplicate_count = dup_primary_count.get(_r.id, 0)

    # ETag / If-None-Match.
    # Cheap fingerprint: include each report's id+updated_at AND each
    # media row's id+updated_at+completion_pct. Catches changes in the
    # parent report AND in chunked-upload progress (which doesn't always
    # bump the parent's updated_at). Already-loaded SQLAlchemy objects
    # - zero extra DB hits.
    #
    # When the dashboard's If-None-Match header matches our ETag, we
    # return 304 Not Modified with no body. That skips the joinedload
    # schema validation + JSON dump cost (significant for 100 reports
    # with verification + AI + media nested inside). Combined with
    # Phase 3 delta polling, idle dashboards drop to ~50-byte poll
    # responses (304 status line + headers, no body).
    import hashlib as _hashlib
    fp_parts = []
    for r in reports:
        fp_parts.append(f"{r.id}:{r.updated_at}")
        for m in (r.media or []):
            fp_parts.append(f"m{m.id}:{m.updated_at}:{m.completion_pct}")
    fingerprint = "|".join(fp_parts)
    etag_value = '"' + _hashlib.md5(fingerprint.encode("utf-8")).hexdigest() + '"'

    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Limit"] = str(safe_limit)
    response.headers["X-Offset"] = str(safe_skip)
    # Phase 3: ISO 8601 with `Z` suffix - same shape as our datetime
    # serialization elsewhere. Dashboard reads this and echoes it back
    # as `?since=<value>` on the next poll.
    response.headers["X-Server-Time"] = cursor.isoformat().replace("+00:00", "Z")
    response.headers["ETag"] = etag_value
    # `Cache-Control: no-cache` - browsers MUST revalidate (send
    # If-None-Match) on every poll. Without this, a stale cached body
    # would short-circuit the conditional check.
    response.headers["Cache-Control"] = "no-cache"
    # CORS: without this the dashboard's fetch() can't actually read the header.
    response.headers["Access-Control-Expose-Headers"] = (
        "X-Total-Count, X-Limit, X-Offset, X-Server-Time, ETag"
    )

    # If the dashboard echoed our previous ETag back, short-circuit with
    # 304 - saves the schema-validation + JSON-encoding cost on the
    # backend AND the body-transfer bandwidth on the wire.
    client_etag = request.headers.get("if-none-match", "")
    if client_etag and client_etag == etag_value:
        # 304 responses carry headers but no body. We have to construct
        # the Response manually because FastAPI's response_model would
        # otherwise insist on a body.
        from fastapi import Response as _Response
        return _Response(
            status_code=304,
            headers={
                "X-Total-Count":              str(total),
                "X-Limit":                    str(safe_limit),
                "X-Offset":                   str(safe_skip),
                "X-Server-Time":              cursor.isoformat().replace("+00:00", "Z"),
                "ETag":                       etag_value,
                "Cache-Control":              "no-cache",
                "Access-Control-Expose-Headers":
                    "X-Total-Count, X-Limit, X-Offset, X-Server-Time, ETag",
            },
        )

    return reports


# ── "Verified Reports Nearby" - Public intel summary ─────────────────────────
#
# Public endpoint (no auth) - the response is heavily privacy-projected
# via ReportNearbyResponse + the aggregator service. No device_id,
# no user_id, no description, no individual report id, no precise
# per-report coords. Same trust model as the existing share-token +
# stable media URL endpoints.
#
# Drives the home-stage "Verified Reports Nearby" module on the PWA +
# RN companion. Reporters get ambient awareness ("12 reports nearby
# at Green Valley Apartments") without compromising any reporter's
# anonymity. The module is INVISIBLE when offline / GPS denied - see
# the offline-behavior matrix in the design plan.
#
# UNDP alignment:
#   • must-have #6 (building footprints) - primary group key
#   • must-have #7 (PII protection)      - strict allow-list projection
#   • must-have #9 (anonymity)           - zero reporter identification
#   • must-have #12 (scale)              - bbox pre-filter + top-N + cache

_NEARBY_CACHE: dict = {}
_NEARBY_CACHE_TTL_SECONDS = 90

# Phase 5.1 (docs/NEARBY_REPORTS_PIPELINE.md §9.3) - runtime detection of
# the locations.geom PostGIS column added by migration 0023. When the
# column exists AND has populated rows, the /nearby query uses
# ST_DWithin(geom, ST_MakePoint(lng, lat)::geography, radius_m) - exact
# metric filtering with the GiST index doing the heavy lifting, and the
# Python haversine post-filter pass becomes redundant.
#
# Cached process-wide because the schema doesn't change at runtime. The
# tri-state (None = not yet checked, True / False = cached) avoids
# re-running the check on every request.
#
# In dev / CI without PostGIS the cached value stays False and the
# existing bbox + haversine path runs - Phase 5's graceful-degradation
# contract preserved.
_POSTGIS_GEOM_AVAILABLE: Optional[bool] = None


def _has_populated_geom_column(db: Session) -> bool:
    """Return True iff `locations.geom` exists AND at least one row is
    populated. Cached per-process; safe to call on the hot path.

    Two checks so a half-applied migration (column created but no rows
    yet populated by the trigger / backfill) doesn't break the query:
    we only flip to ST_DWithin when the column is genuinely usable."""
    global _POSTGIS_GEOM_AVAILABLE
    if _POSTGIS_GEOM_AVAILABLE is not None:
        return _POSTGIS_GEOM_AVAILABLE
    try:
        col = db.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'locations' AND column_name = 'geom'"
        )).first()
        if col is None:
            _POSTGIS_GEOM_AVAILABLE = False
            return False
        # Column exists; check at least one row is populated.
        row = db.execute(text(
            "SELECT 1 FROM locations WHERE geom IS NOT NULL LIMIT 1"
        )).first()
        _POSTGIS_GEOM_AVAILABLE = row is not None
    except Exception:
        # ANY query failure → fall back to bbox path. Don't punish the
        # user because of a transient catalog hiccup.
        _POSTGIS_GEOM_AVAILABLE = False
    return _POSTGIS_GEOM_AVAILABLE


def _reset_geom_cache_for_tests() -> None:
    """Test-only hook so the suite can force a re-detect after schema
    changes. NOT exported by the API; called only from test fixtures."""
    global _POSTGIS_GEOM_AVAILABLE
    _POSTGIS_GEOM_AVAILABLE = None

def _nearby_cache_key(lat3: float, lng3: float, radius_km: float,
                     since_iso: str, group_by: str,
                     limit: int, max_age_hours: int,
                     caller_device_hash: Optional[str] = None) -> str:
    # caller_device_hash is part of the key when provided so different
    # callers don't share each other's filtered cache rows. The hash
    # itself is short (~40 chars) and never logged elsewhere - see the
    # privacy comment in get_nearby_reports.
    suffix = f"|caller={caller_device_hash}" if caller_device_hash else ""
    return f"{lat3:.3f}|{lng3:.3f}|{radius_km:.1f}|{since_iso}|{group_by}|{limit}|{max_age_hours}{suffix}"


@router.get("/nearby", response_model=ReportNearbyResponse)
def get_nearby_reports(
    request: Request,
    response: Response,
    lat: float = Query(..., ge=-90, le=90,
                       description="Latitude of the user's location. Client SHOULD round to 3dp (~110m) before sending."),
    lng: float = Query(..., ge=-180, le=180,
                       description="Longitude of the user's location. Client SHOULD round to 3dp (~110m) before sending."),
    radius_km: float = Query(5.0, ge=0.1, le=100.0,
                             description="Search radius in kilometres. Default 5, max 100. "
                                         "HC81 (May 2026) - bucket-ring UI uses thresholds "
                                         "1/5/10/20/100 km, so the outer bucket needs the "
                                         "validator to accept up to 100. Previously capped at 25."),
    since: Optional[datetime] = Query(None,
                                      description="ISO 8601 timestamp; delta-sync filter (same shape as /reports/)."),
    group_by: str = Query("building", pattern="^(building|crisis_type)$",
                          description="Bucket strategy. 'building' (default) groups by building_id with grid-cell fallback; 'crisis_type' groups by crisis type only."),
    limit: int = Query(20, ge=1, le=50,
                       description="Max groups returned. Default 20, max 50."),
    max_age_hours: int = Query(72, ge=1, le=720,
                               description="Drop reports older than N hours. Default 72."),
    db: Session = Depends(get_db),
):
    """Aggregate verified + pending reports within `radius_km` of (lat, lng).

    Returns groups (one per building or crisis cluster) with privacy-
    projected fields only. Suppresses groups with < 3 reports
    (k-anonymity).

    Performance: bbox pre-filter on the (latitude, longitude) index
    narrows the candidate set BEFORE the haversine pass. 90-second
    in-process cache keyed by rounded coords + filter params.

    Privacy guarantees:
      ✓ No reporter identification (device_id / user_id) in response
      ✓ No individual report id exposed (groups only)
      ✓ No free-text description
      ✓ No precise per-report lat/lng (only group centroid)
      ✓ Timestamps minute-truncated
      ✓ Same-device contributions capped at 1 per group (anti-spam)
      ✓ Status REJECTED / DUPLICATE / FALSE_ALARM excluded

    Self-report exclusion (May 21, 2026 - audit Item 2):
      The PWA's nearby feed was showing the caller's own submissions
      back to them, which broke the "community awareness" intent.
      The client now opts into server-side filtering via the
      `X-Caller-Device-Hash` HEADER (not a query param - uvicorn
      access logs capture query strings but not custom headers, so
      the hash never enters log files). If the caller's resolved
      device_id is in the candidate set, those rows are dropped
      BEFORE the aggregator runs. Privacy posture: the hash is used
      to compute the device_id lookup + the cache key, then dropped.
      It is NEVER logged - every log line below uses rounded coords
      only.
    """
    # Resolve caller's device_id (if a hash was provided in the
    # `X-Caller-Device-Hash` header) before building the cache key.
    # The lookup itself is a fast indexed read on Device.device_hash.
    # We log only "filter active" / "filter off", never the hash value
    # itself - see privacy posture above. Using a header instead of a
    # query param keeps the value out of uvicorn's request-line access
    # log; cookies/headers don't appear in the default Apache-combined
    # format uvicorn uses.
    caller_device_hash = request.headers.get("x-caller-device-hash") if request else None
    caller_device_id: Optional[str] = None
    if caller_device_hash:
        # Defensive: trim whitespace, cap length to avoid log-noise abuse.
        _h = caller_device_hash.strip()[:128] if caller_device_hash else ""
        if _h:
            _cd = db.query(Device).filter(Device.device_hash == _h).first()
            if _cd:
                caller_device_id = _cd.id
            # Note: we don't log the hash itself nor whether it matched
            # a known device. A bad/typoed hash silently no-ops to "no
            # filter" rather than 4xx, since the public /nearby endpoint
            # shouldn't leak whether an arbitrary device_hash exists.

    # Cache key uses caller's rounded coords + filter params. 3-decimal
    # rounding (~110m) clusters nearby callers onto the same cache row.
    lat_r = round(lat, 3)
    lng_r = round(lng, 3)
    since_iso = since.isoformat() if since else ""
    # caller_device_hash is part of the cache key when present so two
    # callers from the same 110m cell don't share each other's filtered
    # results. Empty string when not provided keeps the original cache
    # contract intact.
    cache_key = _nearby_cache_key(
        lat_r, lng_r, radius_km, since_iso, group_by, limit, max_age_hours,
        caller_device_hash=caller_device_hash if caller_device_id else None,
    )

    now_ts = datetime.now(timezone.utc).timestamp()
    cached = _NEARBY_CACHE.get(cache_key)
    if cached and (now_ts - cached["ts"] < _NEARBY_CACHE_TTL_SECONDS):
        # Cache hit - replay headers + serve cached payload.
        cached_payload = cached["payload"]
        response.headers["Cache-Control"] = "private, max-age=60"
        response.headers["X-Cache"] = "HIT"
        return cached_payload

    # Phase 5.1 (docs §9.5) - hot-region snapshot lookup BEFORE the
    # live aggregator. When CRISP_NEARBY_HOT_REGIONS=1 + caller is
    # inside a configured + fresh region, return the precomputed
    # payload directly. Stale or missing snapshots fall through to
    # the live aggregator below; the next refresh writes a fresh row.
    from app.services import hot_regions as _hot
    snapshot = _hot.lookup_fresh_snapshot(lat, lng, db)
    if snapshot is not None:
        response.headers["Cache-Control"] = "private, max-age=60"
        response.headers["X-Cache"] = "HOT-REGION"
        return snapshot

    # ── DB query ──────────────────────────────────────────────────────
    # Three possible query paths, in priority order:
    #   1. H3 cell-set       (docs §9.4) - when CRISP_NEARBY_H3_MODE=1
    #      AND the python h3 wheel is installed. Uses
    #      WHERE locations.h3_idx IN (centre + k-ring). Backfilled NULLs
    #      remain on the slower paths via the OR'd predicate below.
    #   2. PostGIS ST_DWithin (docs §9.3) - when `locations.geom` is
    #      populated. Exact metric distance with the GiST index.
    #   3. bbox + Python haversine - the original Phase 0 fallback.
    from app.services import h3_helper as _h3h
    use_h3 = _h3h.is_h3_mode_enabled()
    use_postgis = (not use_h3) and _has_populated_geom_column(db)

    # Bbox pre-filter on indexed lat/lng columns. cos(lat) handles
    # meridian convergence; we widen at high latitudes but the
    # haversine post-filter still nails the actual radius.
    # (Computed unconditionally - cheap, used by the fallback path.)
    lat_min, lat_max, lng_min, lng_max = bbox_for_radius(lat, lng, radius_km)

    # Cut-off for `max_age_hours`. server_created_at index narrows the
    # scan further.
    age_cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

    # Phase 1 (May 2026, docs §3.6) - status whitelist EXPANDED:
    #   • VERIFIED, PENDING  - active reports needing attention (kept)
    #   • RESPONDING         - responders active; gives citizens
    #                          transparency that help is en route
    #   • RESOLVED           - KEPT only if within RESOLVED_RECENT
    #                          retention window (additional SQL clause
    #                          below); aggregator re-tags these as
    #                          kind='resolved_recent' and the endpoint
    #                          surfaces them in a SEPARATE
    #                          `recently_resolved_groups` list so the
    #                          UI shows "Recently Resolved: N" as a
    #                          subtotal (does NOT inflate active count).
    # Explicitly EXCLUDED: REJECTED, DUPLICATE, FALSE_ALARM
    # (spam / mis-reports - privacy + abuse-suppression invariant).
    resolved_cutoff = datetime.now(timezone.utc) - timedelta(
        hours=RESOLVED_RECENT_RETENTION_HOURS
    )
    q = (
        db.query(Report)
          .join(Location, Location.report_id == Report.id)
    )
    if use_h3:
        # H3 cell-set filter (docs §9.4). The caller's centre cell + a
        # k-ring covering the requested radius is the candidate set.
        # Backfilled-NULL h3_idx rows would otherwise vanish - guard
        # with `OR h3_idx IS NULL AND <bbox>` so partial backfills
        # don't regress recall. Once backfill completes the NULL branch
        # is dead and the planner skips it.
        cells = _h3h.cells_within_radius(lat, lng, radius_km)
        if cells:
            q = q.filter(
                or_(
                    Location.h3_idx.in_(cells),
                    and_(
                        Location.h3_idx == None,    # noqa: E711
                        Location.latitude.between(lat_min, lat_max),
                        Location.longitude.between(lng_min, lng_max),
                    ),
                )
            )
        else:
            # Empty cell set (radius too large OR h3 hiccup) → fall
            # back to bbox so we never starve the response.
            q = (
                q.filter(Location.latitude.between(lat_min, lat_max))
                 .filter(Location.longitude.between(lng_min, lng_max))
            )
    elif use_postgis:
        # Exact metric radius via PostGIS. ST_DWithin on a geography
        # type does the distance math in metres on the WGS84 ellipsoid
        # and uses the GiST index `ix_locations_geom_gist` (migration
        # 0023). No Python haversine post-filter needed.
        q = q.filter(text(
            "ST_DWithin("
            "  locations.geom, "
            "  ST_SetSRID(ST_MakePoint(:nearby_lng, :nearby_lat), 4326)::geography, "
            "  :nearby_radius_m"
            ")"
        ).bindparams(
            nearby_lng=lng,
            nearby_lat=lat,
            nearby_radius_m=radius_km * 1000.0,
        ))
    else:
        # Fallback bbox pre-filter - used when PostGIS extension is
        # unavailable or the geom column hasn't been populated yet.
        q = (
            q.filter(Location.latitude.between(lat_min, lat_max))
             .filter(Location.longitude.between(lng_min, lng_max))
        )
    q = (
        q.filter(
              # ACTIVE statuses or RESOLVED within retention only.
              # Without the explicit RESOLVED age clamp, very-old
              # RESOLVED reports (months old) would still enter the
              # aggregator and surface under their default `kind`
              # (building / crisis_cluster) instead of being dropped.
              or_(
                  Report.status.in_([
                      ReportStatusEnum.VERIFIED,
                      ReportStatusEnum.PENDING,
                      ReportStatusEnum.RESPONDING,
                  ]),
                  and_(
                      Report.status == ReportStatusEnum.RESOLVED,
                      Report.server_created_at >= resolved_cutoff,
                  ),
              )
          )
          .filter(Report.deletion_requested_at == None)
          .filter(Report.server_created_at >= age_cutoff)
          .options(joinedload(Report.location))
    )

    # Self-report exclusion (May 21, 2026 - audit Item 2). If the
    # caller's device hash resolved to a known device_id, drop their
    # own reports from the candidate set BEFORE the aggregator runs.
    # The aggregator's per-device cap-at-1 anti-spam pass would
    # under-count (or under-show) their reports without filtering them
    # out entirely. This filter does the right thing for both groups
    # and resolved-recent buckets.
    if caller_device_id:
        q = q.filter(Report.device_id != caller_device_id)

    if since is not None:
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        else:
            since = since.astimezone(timezone.utc)
        q = q.filter(Report.updated_at > since)

    # Execute the candidate query. The PostGIS path (ST_DWithin on the
    # geom geography) can fail at the DB layer independently of the query
    # LOGIC - a corrupted PostGIS catalog (e.g. spatial_ref_sys missing
    # SRID 4326), a dropped extension, or a geom-index planner error.
    # None of that should 500 the nearby feature for every caller: fall
    # back to the plain lat/lng bbox filter (no PostGIS, no SRID lookup)
    # and force the Python haversine post-filter below so the exact-radius
    # contract still holds. Non-PostGIS SQL errors re-raise unchanged
    # (the bbox rebuild shares every other filter, so we don't mask them).
    from sqlalchemy.exc import SQLAlchemyError as _SQLAlchemyError
    nearby_postgis_fell_back = False
    try:
        candidates = q.all()
    except _SQLAlchemyError as _nearby_db_exc:
        if not (use_postgis and not use_h3):
            raise
        logger.warning(
            "nearby: PostGIS query failed (%s) - falling back to bbox filter",
            _nearby_db_exc.__class__.__name__,
        )
        db.rollback()  # the failed statement aborted the transaction
        q = (
            db.query(Report)
              .join(Location, Location.report_id == Report.id)
              .filter(Location.latitude.between(lat_min, lat_max))
              .filter(Location.longitude.between(lng_min, lng_max))
              .filter(
                  or_(
                      Report.status.in_([
                          ReportStatusEnum.VERIFIED,
                          ReportStatusEnum.PENDING,
                          ReportStatusEnum.RESPONDING,
                      ]),
                      and_(
                          Report.status == ReportStatusEnum.RESOLVED,
                          Report.server_created_at >= resolved_cutoff,
                      ),
                  )
              )
              .filter(Report.deletion_requested_at == None)
              .filter(Report.server_created_at >= age_cutoff)
              .options(joinedload(Report.location))
        )
        if caller_device_id:
            q = q.filter(Report.device_id != caller_device_id)
        if since is not None:
            q = q.filter(Report.updated_at > since)
        candidates = q.all()
        nearby_postgis_fell_back = True

    # Phase 3 (May 2026, docs §6.1) - pre-fetch trust info for every
    # candidate device in ONE query so we don't N+1 inside the loop.
    candidate_device_ids = {r.device_id for r in candidates if r.device_id}
    devices_by_id: dict = {}
    if candidate_device_ids:
        device_rows = (
            db.query(Device)
              .filter(Device.id.in_(candidate_device_ids))
              .all()
        )
        devices_by_id = {d.id: d for d in device_rows}

    # Exact haversine post-filter - drops bbox false-positives.
    # Phase 5.1 (docs §9.3 + §9.4): when ST_DWithin OR H3 did the
    # radius filtering at the SQL layer, the post-filter is redundant
    # but cheap. Keep the location-presence guard since SQLAlchemy may
    # still produce a candidate row with a NULL Location join target
    # if the DB has drift.
    sql_filtered = (use_postgis or use_h3) and not nearby_postgis_fell_back
    inputs: List[NearbyReportInput] = []
    for r in candidates:
        if not r.location:
            continue
        if not sql_filtered:
            d_km = haversine_km(lat, lng, r.location.latitude, r.location.longitude)
            if d_km > radius_km:
                continue
        elif use_h3:
            # H3 k-ring is an over-approximation of the circle (hex
            # cells aren't aligned to the radius edge). Re-filter
            # candidates against the exact radius with haversine so
            # the response stays radius-accurate.
            d_km = haversine_km(lat, lng, r.location.latitude, r.location.longitude)
            if d_km > radius_km:
                continue
        # Phase 3 trust resolution: device-level weight first, then
        # bump by user-role (verified responder = 3.0; account-linked
        # civilian = 1.5). The aggregator drops suspicious (0.0)
        # contributions entirely; non-suspicious all contribute to
        # the public count floor (k-anonymity invariant).
        dev_obj = devices_by_id.get(r.device_id)
        weight = _device_trust_weight(dev_obj)
        if weight > 0.0 and getattr(r, "user_id", None):
            # Account-linked civilian; admin role-bump would land
            # here in a future commit (Phase 5).
            weight = max(weight, 1.5)
        inputs.append(NearbyReportInput(
            report_id=r.id,
            device_id=r.device_id,
            status=r.status.value if hasattr(r.status, "value") else str(r.status),
            severity=r.severity.value if hasattr(r.severity, "value") else (str(r.severity) if r.severity else None),
            crisis_type=r.crisis_type,
            damage_class=r.damage_classification,
            building_id=r.building_id,
            infrastructure_name=r.infrastructure_name,
            infrastructure_name_from_osm=r.infrastructure_name_from_osm,
            latitude=r.location.latitude,
            longitude=r.location.longitude,
            server_created_at=r.server_created_at or datetime.now(timezone.utc),
            # Phase 2 (docs §3.5 + §8.1) - account-linked reports
            # used as the initial trust proxy for HIGH/LOW acute
            # grading.
            user_id=getattr(r, "user_id", None),
            # Phase 3 (docs §6.1) - pre-resolved device trust weight.
            trust_weight=weight,
            # Phase F.8.c - honest latest_at for offline-drained
            # submissions. The aggregator falls back to server time
            # when this is NULL, so legacy rows stay correct.
            client_created_at=getattr(r, "client_created_at", None),
        ))

    # Aggregate → groups (k-anonymity + relevance sort applied inside).
    #
    # Defensive guard: the aggregators sanitize their own inputs (drop
    # unusable coords, normalize naive/aware timestamps), but /nearby is a
    # PUBLIC batch endpoint - it must NEVER return 500 to every caller
    # because of one malformed report in range. On any unforeseen
    # aggregation error we log the full traceback + the candidate report
    # ids (so the offending row is identifiable from the logs) and degrade
    # to an EMPTY nearby result; the PWA already renders empty gracefully.
    try:
        groups = aggregate_nearby(
            reports=inputs,
            user_lat=lat,
            user_lng=lng,
            radius_km=radius_km,
            group_by=group_by,
            max_groups=limit,
        )

        # Phase 4 (May 2026, docs §3.8) - disaster-mode promotion. If the
        # initial cascade returned > CRISP_DISASTER_MODE_GROUPS groups OR
        # > CRISP_DISASTER_MODE_REPORTS raw reports inside the radius,
        # re-aggregate into area-level mega-zones for the heat-map render.
        # Set the X-Crisp-Density-Mode response header so the dashboard
        # knows to switch its map render mode without parsing every
        # group.
        disaster_mode = is_disaster_density(
            group_count=len(groups), report_count=len(inputs),
            groups_threshold=settings.CRISP_DISASTER_MODE_GROUPS,
            reports_threshold=settings.CRISP_DISASTER_MODE_REPORTS,
        )
        if disaster_mode:
            groups = aggregate_disaster_zones(
                reports=inputs,
                user_lat=lat,
                user_lng=lng,
                # HC83 - plumb the caller's actual radius through so the
                # relevance-sort proximity normalizer matches the query
                # window. Pre-HC83 this was implicitly hardcoded to 25 km
                # inside the aggregator, which silently flattened proximity
                # ranking for groups in the 25–100 km tail once HC82 raised
                # the validator cap to 100.
                radius_km=radius_km,
                max_zones=min(limit, 20),
            )
            response.headers["X-Crisp-Density-Mode"] = "disaster"
        else:
            response.headers["X-Crisp-Density-Mode"] = "normal"
    except Exception:
        logger.exception(
            "[nearby] aggregation failed - degrading to empty result "
            "(lat=%.4f lng=%.4f radius=%.1f candidates=%d ids=%s)",
            lat, lng, radius_km, len(inputs),
            [getattr(i, "report_id", None) for i in inputs[:50]],
        )
        groups = []
        disaster_mode = False
        response.headers["X-Crisp-Density-Mode"] = "normal"
        response.headers["X-Crisp-Nearby-Degraded"] = "aggregation_error"

    # Phase 1 (May 2026, docs §3.2 + §3.6 + §14) - split aggregator
    # output into ACTIVE vs RECENTLY-RESOLVED, and gate T1 (weak)
    # groups behind the deployment flag for anonymous (citizen)
    # callers. Admins always see T1.
    #
    # Authentication detection: any caller carrying a valid JWT is
    # treated as a non-citizen for visibility purposes. This is
    # intentionally permissive - any authenticated user gets richer
    # data; the deployment-flag suppression only protects the
    # anonymous / first-time citizen path.
    is_anonymous_caller = "authorization" not in {
        k.lower() for k in request.headers.keys()
    }
    suppress_t1 = (
        is_anonymous_caller
        and not settings.CRISP_CITIZEN_T1_VISIBILITY
    )

    def _to_schema(g) -> ReportNearbyGroup:
        return ReportNearbyGroup(
            id=g.id, kind=g.kind, label=g.label, summary=g.summary,
            summary_key=g.summary_key, count=g.count,
            verified_count=g.verified_count, pending_count=g.pending_count,
            responding_count=g.responding_count, resolved_count=g.resolved_count,
            approx_distance_km=g.approx_distance_km,
            centroid_lat=g.centroid_lat, centroid_lng=g.centroid_lng,
            latest_at=g.latest_at, earliest_at=g.earliest_at,
            crisis_types=g.crisis_types, damage_classes=g.damage_classes,
            severity_max=g.severity_max,
            tier=g.tier,
            is_burst=g.is_burst,
            is_acute=g.is_acute,
            acute_grade=g.acute_grade,
            crisis_ttl_hours=g.crisis_ttl_hours,
            coarse_crisis_category=g.coarse_crisis_category,
        )

    active_groups = []
    resolved_recent_groups = []
    for g in groups:
        if suppress_t1 and g.tier == 'weak':
            continue
        if g.kind == 'resolved_recent':
            resolved_recent_groups.append(_to_schema(g))
        else:
            active_groups.append(_to_schema(g))

    payload = ReportNearbyResponse(
        user_location={"lat": lat_r, "lng": lng_r},
        radius_km=radius_km,
        as_of=datetime.now(timezone.utc),
        groups=active_groups,
        recently_resolved_groups=resolved_recent_groups,
        total_groups=len(active_groups),
        total_resolved_recent=len(resolved_recent_groups),
        total_reports=len(inputs),
        citizen_t1_visibility=settings.CRISP_CITIZEN_T1_VISIBILITY,
        density_mode=("disaster" if disaster_mode else "normal"),
    )

    # Phase 2 (May 2026, docs §3.7) - lifecycle transition detection.
    # Diff the fresh aggregation against the prior cached aggregation
    # for this cache_key and emit one nearby_group_events row per
    # transition (promote / downgrade / acute_on / fading / created /
    # removed / resolved). Best-effort; errors logged, swallowed -
    # a DB write can NEVER poison the user-facing response.
    prior_entry = _NEARBY_CACHE.get(cache_key)
    prior_groups = prior_entry.get("raw_groups", []) if prior_entry else []
    if prior_groups:
        try:
            _nearby_detect_and_persist(
                db, prior_groups=prior_groups, current_groups=groups,
            )
        except Exception:                          # pragma: no cover
            # Belt-and-suspenders - the service already swallows DB
            # errors, but a missing module / import bug should never
            # take down /nearby. Endpoint stays the priority.
            pass

    # Cache for 90 s. Capped at 1000 entries to bound memory; LRU-ish
    # eviction at insertion time.
    # Cache stores BOTH the serialized payload (for fast re-serve)
    # AND the raw aggregator groups (for next poll's lifecycle diff).
    if len(_NEARBY_CACHE) >= 1000:
        # Drop the 100 oldest entries
        oldest = sorted(_NEARBY_CACHE.items(), key=lambda kv: kv[1]["ts"])[:100]
        for k, _ in oldest:
            _NEARBY_CACHE.pop(k, None)
    _NEARBY_CACHE[cache_key] = {
        "ts": now_ts,
        "payload": payload,
        "raw_groups": groups,
    }

    response.headers["Cache-Control"] = "private, max-age=60"
    response.headers["X-Cache"] = "MISS"
    response.headers["X-Total-Groups"] = str(payload.total_groups)
    response.headers["X-Total-Reports"] = str(payload.total_reports)
    return payload


# Phase 5.1 (docs §9.5) - entry point used by the hot-region refresh
# admin endpoint. Calls the live /nearby endpoint function with a
# synthetic Request/Response so all the same logic runs (DB query,
# aggregation, lifecycle persist, cache write) and returns the result
# as a JSON-serializable dict for storage in nearby_hot_regions.
# Late-binds to avoid the bidirectional-import cycle with
# api/endpoints/hot_regions.py.
def _aggregate_nearby_for_region(
    db: Session, *, lat: float, lng: float, radius_km: float,
) -> dict:
    from starlette.requests import Request as _Request
    from starlette.responses import Response as _Response
    # Minimal ASGI scope - get_nearby_reports only touches
    # request.headers, so an empty headers list satisfies the contract
    # AND keeps the caller in the anonymous-citizen branch (so the
    # snapshot is what citizens would see, which is the intent).
    scope = {"type": "http", "headers": [], "method": "GET", "path": "/api/v1/reports/nearby"}
    fake_request = _Request(scope=scope)
    fake_response = _Response()
    payload = get_nearby_reports(
        request=fake_request,
        response=fake_response,
        lat=lat, lng=lng, radius_km=radius_km,
        since=None, group_by="building", limit=20, max_age_hours=72,
        db=db,
    )
    # Pydantic v2: model_dump(mode="json") yields a dict whose values
    # are all JSON-native (datetimes → ISO strings, etc.), which is
    # exactly what nearby_hot_regions.snapshot_json wants.
    return payload.model_dump(mode="json")


@router.get("/{report_id}", response_model=ReportResponse)
def get_report(report_id: str, user=Depends(require_viewer), db: Session = Depends(get_db)):
    """Single report by id - the dashboard's lazy by-id fetch (C1-d Phase-0).

    At scale the dashboard holds only the newest-N working set, but the map
    (GET /reports/markers, up to 20k points) and deep-links can target an OLDER
    report outside that window. This returns the full report so the detail panel
    can open it. Same read auth as the listing (require_viewer); ReportResponse
    never embeds reporter PII (email/phone). Declared AFTER the single-segment
    GETs (/markers, /nearby) so the catch-all path param can't shadow them.

    404 if not found or soft-deleted (a pending-deletion report is not openable
    from the operational view)."""
    r = (db.query(Report)
         .options(joinedload(Report.media), joinedload(Report.location),
                  joinedload(Report.ai_analysis), joinedload(Report.verification),
                  joinedload(Report.device))
         .filter(Report.id == report_id, Report.deletion_requested_at.is_(None))
         .first())
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    _attach_reporter_tier(db, [r])
    _attach_operation_name(db, [r])
    return r


# ── Satellite Truth Verification ─────────────────────────────────────────────

@router.get("/{report_id}/verification", response_model=VerificationResponse)
def get_verification(report_id: str, db: Session = Depends(get_db)):
    """Return cached satellite verification result for a report."""
    v = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()
    if not v:
        raise HTTPException(status_code=404, detail="No verification result yet")
    return v


@router.post("/{report_id}/verify", response_model=VerificationResponse)
async def verify_report(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """
    Run satellite truth verification on a report:
      1. Fetch the most recent Sentinel-2 (or Mapbox) image at the report's GPS.
      2. Pass both images + full report context to Claude claude-sonnet-4-6.
      3. Store and return the structured truth score.

    Re-running overwrites the previous result.
    Typical latency: 10–25 s (Sentinel fetch + Claude multi-modal call).
    """
    # ── Load report ──────────────────────────────────────────────────────────
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    loc = report.location
    if not loc or not loc.latitude or not loc.longitude:
        raise HTTPException(
            status_code=422,
            detail="Report has no GPS coordinates - cannot fetch satellite image"
        )

    ai = report.ai_analysis

    # ── Fetch satellite image ─────────────────────────────────────────────────
    sat_data = await satellite_fetcher.fetch(
        lat=loc.latitude,
        lon=loc.longitude,
        report_dt=report.server_created_at,
    )
    if not sat_data:
        raise HTTPException(
            status_code=503,
            detail="Could not fetch satellite imagery - check SENTINEL_HUB_CLIENT_ID/SECRET and MAPBOX_TOKEN in .env"
        )

    # Save satellite image to the configured storage backend.
    sat_image_url: Optional[str] = None
    try:
        sat_bytes = base64.b64decode(sat_data["image_b64"])
        ext       = "png" if "png" in sat_data.get("image_media_type", "image/png") else "jpg"
        sat_fname = f"sat_{report_id}.{ext}"
        sat_image_url = _get_media_storage().save(
            sat_fname, sat_bytes, _content_type_for(sat_fname)
        )
        logger.info(f"Satellite image saved: {sat_fname} ({len(sat_bytes):,} bytes) → {sat_image_url}")
    except Exception as exc:
        logger.warning(f"Could not save satellite image: {exc}")

    # multi-provider fan-out: save EVERY successful provider's
    # image to the storage backend so the dashboard can render a 2×2
    # grid. The primary is duplicated as `images[0]` for consistency -
    # we save with the suffixed filename so the response can list every
    # image with the same naming pattern.
    sat_images_list: list[dict] = []
    storage = _get_media_storage()
    for idx, img in enumerate(sat_data.get("images", []) or []):
        try:
            img_bytes = base64.b64decode(img["image_b64"])
            img_ext = "png" if "png" in img.get("image_media_type", "image/jpeg") else "jpg"
            img_fname = f"sat_{report_id}_{idx}.{img_ext}"
            img_url = storage.save(img_fname, img_bytes, _content_type_for(img_fname))
            sat_images_list.append({
                "url": img_url,
                "source": img.get("source"),
                "acquisition_date": img.get("acquisition_date"),
                "cloud_cover_pct": img.get("cloud_cover_pct"),
                "resolution_m": img.get("resolution_m"),
            })
        except Exception as exc:
            logger.warning(f"Could not save satellite image {idx}: {exc}")

    # ── Load user photo via the storage abstraction ──────────────────────────
    #
    # Bug history: the previous implementation hard-coded
    # `os.path.join(UPLOAD_DIR, img_media.url.replace("/static/", ""))`,
    # which works for `/static/abc.jpg` (LocalStorage) but FAILS for
    # `s3://abc.jpg` (S3Storage) - `os.path.join` produces a nonsensical
    # path that doesn't exist on disk, so `user_image_path` stayed None
    # and Claude scored the satellite + text only, with NO ground-truth
    # photo corroboration. Damage scores were silently unreliable on
    # any deployment with MEDIA_BACKEND=s3.
    #
    # Fix: route through `_get_media_storage().read()` which abstracts
    # both backends. truth_scorer.score() reads via file path (line ~175
    # in truth_scorer.py) so we materialise the bytes to a temp file and
    # delete it after scoring completes.
    user_image_path: Optional[str] = None
    user_image_tmp: Optional[str] = None
    img_media = next(
        (m for m in report.media if m.type == MediaTypeEnum.IMAGE and m.url), None
    )
    if img_media:
        try:
            img_bytes = _get_media_storage().read(img_media.url)
            # Suffix matters for Anthropic's media-type detection downstream.
            url_lc = (img_media.url or "").lower()
            if url_lc.endswith((".jpg", ".jpeg")):
                suffix = ".jpg"
            elif url_lc.endswith(".png"):
                suffix = ".png"
            elif url_lc.endswith(".webp"):
                suffix = ".webp"
            else:
                suffix = ".jpg"  # safe default - Claude infers from bytes anyway
            tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            try:
                tmp.write(img_bytes)
            finally:
                tmp.close()
            user_image_path = tmp.name
            user_image_tmp = tmp.name
        except Exception as exc:
            # Don't block verification if the photo can't be loaded -
            # Claude still scores satellite + text, with the data_quality
            # score reflecting the missing photo via its `has_photo` input.
            logger.warning(
                f"Could not load user image for verification (report={report_id}): {exc}"
            )

    # ── Run AI scoring ───────────────────────────────────────────────────────
    has_audio = any(m.type == MediaTypeEnum.AUDIO for m in report.media)
    try:
        result = await truth_scorer.score(
            report_id         = report_id,
            infrastructure_type = report.infrastructure_type.value,
            severity          = report.severity.value,
            description       = report.description,
            transcription     = ai.transcription if ai else None,
            report_dt         = report.server_created_at,
            user_image_path   = user_image_path,
            satellite_data    = sat_data,
            has_audio         = has_audio,
            has_gps           = True,
            # B4 - feed the geo-gated crisis-pack context into the credibility
            # chain. NULL for default-flow reports → byte-identical scoring.
            form_data         = report.form_data,
            crisis_type       = report.crisis_type,  # String(30) column, not an enum
            form_pack_id      = report.form_pack_id,
            form_pack_version = report.form_pack_version,
        )
    finally:
        # Clean up the temp file - both on success and on Claude API failure.
        # Best-effort: a leaked temp file is cheaper than a 500.
        if user_image_tmp:
            try:
                os.remove(user_image_tmp)
            except Exception:
                pass

    # ── Persist result ────────────────────────────────────────────────────────
    scores     = result.get("scores", {})
    sat_meta   = result.get("satellite_data", {})

    existing = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()

    if existing:
        v = existing
    else:
        v = SatelliteVerification(report_id=report_id)
        db.add(v)

    v.total_score                  = scores.get("total", 0)
    v.verdict                      = result.get("verdict")
    v.scores                       = scores
    v.reasoning                    = result.get("reasoning")
    v.key_findings                 = result.get("key_findings", [])
    v.caveats                      = result.get("caveats", [])
    v.satellite_scene_description  = result.get("satellite_scene_description")
    v.photo_analysis               = result.get("photo_analysis")
    v.satellite_source             = sat_meta.get("source")
    v.satellite_acquisition_date   = sat_meta.get("acquisition_date")
    v.satellite_cloud_cover_pct    = sat_meta.get("cloud_cover_pct")
    v.satellite_resolution_m       = sat_data.get("resolution_m")
    v.satellite_days_gap           = sat_meta.get("days_gap")
    v.satellite_image_url          = sat_image_url
    v.error                        = result.get("error")
    # .2 - stamp the time the
    # Claude scoring run completed so the dashboard can render
    # "Last verified Xm ago" + analysts know whether to re-verify.
    # The column already exists on SatelliteVerification; the schema
    # already exposes it (`VerificationResponse.scored_at`). Without
    # this assignment, scored_at stays NULL and the dashboard falls
    # back to a generic "Verified" label.
    v.scored_at                    = datetime.now(timezone.utc)

    # Save alternate satellite source (e.g. Mapbox when Sentinel is primary)
    alt = sat_data.get("alt")
    if alt:
        try:
            alt_bytes = base64.b64decode(alt["image_b64"])
            alt_ext   = "png" if "png" in alt.get("image_media_type", "image/jpeg") else "jpg"
            alt_fname = f"sat_alt_{report_id}.{alt_ext}"
            v.satellite_image_url_alt      = _get_media_storage().save(
                alt_fname, alt_bytes, _content_type_for(alt_fname)
            )
            v.satellite_source_alt         = alt.get("source")
            v.satellite_acquisition_date_alt = alt.get("acquisition_date")
            v.satellite_resolution_m_alt   = alt.get("resolution_m")
            logger.info(f"Alt satellite image saved: {alt_fname} → {v.satellite_image_url_alt}")
        except Exception as exc:
            logger.warning(f"Could not save alt satellite image: {exc}")

    # persist the full multi-provider list so /verification
    # GET reads back the same set on subsequent loads (otherwise refresh
    # would only show the primary).
    if sat_images_list:
        import json as _json
        v.satellite_images_json = _json.dumps(sat_images_list)
        logger.info(f"Persisted {len(sat_images_list)} multi-source satellite images")

    # P1-3: record the verification act in the per-incident audit ribbon.
    # REPORT_VERIFY was in the vocab + ribbon label maps but no handler ever
    # emitted it - satellite verification left no trace at the incident level.
    _audit_report_action(db, user, "REPORT_VERIFY", report_id,
                         details={"verdict": getattr(v, "verdict", None),
                                  "score": getattr(v, "total_score", None)})
    db.commit()
    db.refresh(v)

    # Decorate the SQLAlchemy instance with the list so Pydantic's
    # from_attributes serialiser surfaces it on this POST response
    # without a round-trip through the DB.
    v.satellite_images = sat_images_list  # type: ignore[attr-defined]
    return v


# ═══════════════════════════════════════════════════════════════════════════════
# GAMIFICATION: Reporter profiles with badge progression
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/profile/{device_hash}")
def get_reporter_profile(device_hash: str, db: Session = Depends(get_db)):
    """Get reporter's gamification profile (4-tier ladder + impact + progress).

    Apr 2026 PR 2 - defense-in-depth against stored-counter drift. The
    stored `ReporterProfile.report_count` is only decremented in
    `_purge_expired_deletions`. If the purge job hasn't run yet (or
    failed), the stored counter can be higher than the actual live
    rows. We report the MIN of stored vs live so the UI never shows a
    number that's greater than the reports the user can actually see.
    Same for `verified_count`.

    May 2026 second-pass - extended response shape for the 4-tier
    reward ladder (SCOUT / SIGNAL / CHANGEMAKER / LIFEKEEPER):

      * ``responded_count`` - live count of reports in
        {RESPONDING, RESOLVED} (drives the T3 promotion).
      * ``lives_saved_total`` - sum of ``lives_impacted`` across the
        device's reports (drives the T4 promotion + the home/My-Reports
        Lives Saved aggregate).
      * ``badge_level`` - one of T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER
        / T4_LIFEKEEPER. Recomputed on the fly here so a stale stored
        value (e.g. from before the v2 migration) corrects itself on
        the next read.
      * ``badge_legacy`` - same tier mapped to the old 3-tier names
        (NEWCOMER / CONTRIBUTOR / TRUSTED) for pre-v145 PWA shells
        that haven't picked up the new BADGE_LEVELS map yet. Removed
        in a post-submission cleanup once SW cache invalidation has
        propagated.
      * ``tier`` object - current tier id, next tier id, and a
        machine-readable ``progress`` block telling the PWA exactly
        what action moves the user up. The PWA renders this verbatim
        in the badge-chip sub-line so backend stays the single source
        of truth for the progression copy.
    """
    from app.models.report import ReporterProfile
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        # Race-safe auto-create (May 21, 2026 - fix discovered during
        # cellular smoke 5 backend-log audit). The PWA home-screen polls
        # this endpoint every ~5 s. On the first poll for a brand-new
        # device, two concurrent requests can both observe profile=None
        # then both attempt INSERT. The loser hits the unique constraint
        # `ix_reporter_profiles_device_hash` and 500s. Same family as
        # K.1.b's IntegrityError-catch pattern on duplicate chunks.
        from sqlalchemy.exc import IntegrityError as _IntegrityError_profile
        try:
            profile = ReporterProfile(
                device_hash=device_hash,
                report_count=0,
                badge_level="T1_SCOUT",
                impact_score=0,
            )
            db.add(profile)
            db.commit()
            db.refresh(profile)
        except _IntegrityError_profile:
            # Concurrent request won the race - re-SELECT the winning row
            # and proceed. Idempotent: the response is the same regardless
            # of who created the row.
            db.rollback()
            profile = db.query(ReporterProfile).filter(
                ReporterProfile.device_hash == device_hash
            ).first()
            if not profile:
                # Extremely unlikely (the dup-key fired, so a row exists)
                # but defensively guard against a SELECT race.
                raise HTTPException(
                    status_code=500,
                    detail="reporter profile race could not be reconciled",
                )

    # Live count of un-deleted rows for this device. If the device row
    # doesn't exist (rare - only for fresh profiles), fall back to 0.
    live_count = 0
    live_verified = 0
    live_responded = 0
    live_lives_total = 0
    device = db.query(Device).filter(Device.device_hash == device_hash).first()
    if device:
        base_q = db.query(Report).filter(
            Report.device_id == device.id,
            Report.deletion_requested_at.is_(None),
        )
        live_count = base_q.count()
        # Verified = status transitioned out of PENDING via AI or responder.
        live_verified = base_q.filter(
            Report.status.in_([
                ReportStatusEnum.VERIFIED,
                ReportStatusEnum.RESPONDING,
                ReportStatusEnum.RESOLVED,
            ])
        ).count()
        # Responded = analyst dispatched / resolved (the T3 trigger).
        live_responded = base_q.filter(
            Report.status.in_([
                ReportStatusEnum.RESPONDING,
                ReportStatusEnum.RESOLVED,
            ])
        ).count()
        # Lives saved aggregate (the T4 trigger + the home stat).
        live_lives_total = (
            base_q.with_entities(sa_func.coalesce(sa_func.sum(Report.lives_impacted), 0)).scalar() or 0
        )

    # Recompute tier on every read so a stale stored value (e.g. from
    # before the v1→v2 migration, or if a recompute call site was
    # missed during the rollout) self-corrects without a job.
    _recompute_tier(profile, db)
    db.commit()
    db.refresh(profile)

    # ── Tier progress block ────────────────────────────────────────
    # Tells the PWA what the user needs to do to level up next. The
    # backend owns this copy so the PWA doesn't drift on tier
    # thresholds. ``label_key`` is an i18n key the PWA resolves
    # locally; ``needs`` / ``needed`` / ``have`` are machine-readable
    # so a future "you're 1 verified away from CHANGEMAKER" progress
    # bar can read the numbers directly.
    _TIER_ORDER = ["T1_SCOUT", "T2_SIGNAL", "T3_CHANGEMAKER", "T4_LIFEKEEPER"]
    _LEGACY_MAP = {
        "T1_SCOUT":       "NEWCOMER",
        "T2_SIGNAL":      "NEWCOMER",
        "T3_CHANGEMAKER": "CONTRIBUTOR",
        "T4_LIFEKEEPER":  "TRUSTED",
    }
    current = profile.badge_level or "T1_SCOUT"
    cur_idx = _TIER_ORDER.index(current) if current in _TIER_ORDER else 0
    next_tier = _TIER_ORDER[cur_idx + 1] if cur_idx + 1 < len(_TIER_ORDER) else None
    if current == "T1_SCOUT":
        progress = {"needs": "submitted", "needed": 1, "have": live_count, "label_key": "tier_progress_first_report"}
    elif current == "T2_SIGNAL":
        progress = {"needs": "responded", "needed": 1, "have": live_responded, "label_key": "tier_progress_verified_1"}
    elif current == "T3_CHANGEMAKER":
        progress = {"needs": "lives_saved", "needed": 1, "have": live_lives_total, "label_key": "tier_progress_lives_1"}
    else:  # T4 - top tier
        progress = {"needs": None, "needed": 0, "have": live_lives_total, "label_key": "tier_progress_top_share"}

    return {
        "device_hash": profile.device_hash,
        "report_count": min(profile.report_count or 0, live_count),
        "verified_count": min(profile.verified_count or 0, live_verified),
        "responded_count": live_responded,
        "lives_saved_total": live_lives_total,
        "badge_level": current,
        "badge_legacy": _LEGACY_MAP.get(current, "NEWCOMER"),
        "tier": {
            "current": current,
            "next": next_tier,
            "progress": progress,
        },
        "impact_score": live_lives_total,  # alias retained for back-compat with the dashboard credibility readout
    }


def _update_reporter_profile(device_hash: str, db: Session):
    """Increment reporter's profile on report submission.

    UNDP April 2026 incentive realignment (see docs/INCENTIVES.md).
    The Problem Statement (§Appendix ‘Engagement Incentives’) is
    explicit: the rewarding system must NOT encourage users to repeat
    reports or over-report for a reward. The previous badge ladder
    (NEWCOMER → HELPER → GUARDIAN → HERO) was keyed off raw
    ``report_count`` - i.e. it rewarded exactly the behaviour UNDP
    warned against.

    May 2026 second-pass - extended to a 4-tier identity-forward
    ladder (SCOUT → SIGNAL → CHANGEMAKER → LIFEKEEPER). Promotion
    triggers are concrete impact events, never raw volume:
      * T2 SIGNAL       - ≥1 report submitted (this function)
      * T3 CHANGEMAKER  - ≥1 report dispatched (RESPONDING/RESOLVED
                          - see ``_mark_report_verified_for_credibility``)
      * T4 LIFEKEEPER   - analyst set ``lives_impacted ≥ 1`` on any
                          report owned by the device (see the
                          ``set_lives_impacted`` PATCH handler at
                          ~line 1410, which now calls
                          ``_recompute_tier`` after committing).

    The legacy ``report_count`` field is retained as an internal-only
    counter used by the dashboard to spot abusive floods, but it
    NEVER drives badges.
    """
    from app.models.report import ReporterProfile
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        profile = ReporterProfile(device_hash=device_hash)
        db.add(profile)
    # Increment raw count (internal signal for dashboard fraud detection).
    profile.report_count = (profile.report_count or 0) + 1
    # Recompute tier (T2 SIGNAL promotion may fire on first submit).
    _recompute_tier(profile, db)


def _recompute_tier(profile, db: Session) -> None:
    """4-tier reward ladder - May 2026 second-pass redesign.

    Replaces ``_recompute_badge_from_verified`` (3-tier, verified-count
    only). The new ladder is quality-driven across THREE signals:
    submission, dispatch (help sent), and lives impacted. Every
    promotion requires either an analyst action or a real downstream
    impact event - never raw volume alone.

    Tier criteria:
      * T4 LIFEKEEPER   - sum(lives_impacted across device's reports) ≥ 1
                          (requires analyst to call ``/impact``)
      * T3 CHANGEMAKER  - ≥1 report in {RESPONDING, RESOLVED}
                          (requires analyst to call ``/dispatch`` or
                          ``/resolve``)
      * T2 SIGNAL       - ≥1 report submitted (any status)
      * T1 SCOUT        - default

    INCENTIVES.md compliance note (re-verified May 2026 audit):
    T2_SIGNAL fires on the FIRST submission as a one-time
    participation acknowledgement. This is INTENTIONAL and DOES
    honor the "no volume-based repeat reward" rule:
      · 1 submission  → T2 (one-time bump)
      · 50 submissions → still T2 (no further reward from raw volume)
      · 1 verified    → T3 (analyst action required)
      · 1 life saved  → T4 (downstream impact required)
    The fraud-prevention guarantee - that flooding reports does NOT
    advance the tier beyond T2 - is upheld. The home-stage HERO STAT
    visible to the reporter is ``verified_count``, not submitted
    count, so volume is not surfaced as a goal-shaped number.

    Backwards compat: the ``profile.badge_level`` column still carries
    the chosen tier as a string; the new identifiers are
    ``T1_SCOUT``/``T2_SIGNAL``/``T3_CHANGEMAKER``/``T4_LIFEKEEPER``.
    The /profile endpoint emits both the new ``badge_level`` AND a
    ``badge_legacy`` field (mapped to the old 3-tier names) so
    pre-v145 PWA shells don't crash on the new string.
    """
    from app.models.report import Report, Device, ReporterProfile
    if not profile or not profile.device_hash:
        return
    device = db.query(Device).filter(Device.device_hash == profile.device_hash).first()
    if not device:
        profile.badge_level = "T1_SCOUT"
        return

    # Soft-deleted rows are excluded - they were either restored within
    # the grace window or genuinely retracted; either way they should
    # not keep contributing to a tier promotion.
    base_q = db.query(Report).filter(
        Report.device_id == device.id,
        Report.deletion_requested_at.is_(None),
    )

    lives_total = (
        base_q.with_entities(sa_func.coalesce(sa_func.sum(Report.lives_impacted), 0)).scalar() or 0
    )
    responded = base_q.filter(
        Report.status.in_([
            ReportStatusEnum.RESPONDING,
            ReportStatusEnum.RESOLVED,
        ])
    ).count()
    submitted = base_q.count()

    if lives_total >= 1:
        profile.badge_level = "T4_LIFEKEEPER"
    elif responded >= 1:
        profile.badge_level = "T3_CHANGEMAKER"
    elif submitted >= 1:
        profile.badge_level = "T2_SIGNAL"
    else:
        profile.badge_level = "T1_SCOUT"


# Backwards-compat alias for any external caller still importing the old
# 3-tier name. Both call sites in this file have been updated to
# ``_recompute_tier``; the alias remains for one release cycle.
def _recompute_badge_from_verified(profile) -> None:  # pragma: no cover
    """DEPRECATED - kept as a shim so any external import doesn't crash
    during the v1 → v2 transition. The new function ``_recompute_tier``
    requires the db session; callers should migrate."""
    vc = profile.verified_count or 0
    if vc >= 10:
        profile.badge_level = "T4_LIFEKEEPER"
    elif vc >= 3:
        profile.badge_level = "T3_CHANGEMAKER"
    elif vc >= 1:
        profile.badge_level = "T2_SIGNAL"
    else:
        profile.badge_level = "T1_SCOUT"


def _mark_report_verified_for_credibility(report, db: Session) -> None:
    """Called when a report transitions to VERIFIED / RESPONDING / RESOLVED.

    Idempotent on TWO levels (May 2026 gamification audit fix):

    1. ``report.first_verified_at`` short-circuit - once this column
       is non-NULL, this function returns immediately. The endpoint-
       level ``was_pending`` guard catches the common case (status
       transition), but is NOT safe under parallel dispatch + resolve
       requests where both transactions see ``status == PENDING``
       before either commits.
    2. ``SELECT … FOR UPDATE`` row lock on the report - serializes
       concurrent calls inside Postgres. The second transaction
       blocks until the first commits, then sees
       ``first_verified_at`` already set and bails.

    Net effect: ``verified_count`` is bumped at most ONCE per report,
    even when called twice from racing parallel endpoints. The audit
    finding C-2 (CRITICAL - `verified_count` non-idempotent under
    race) is resolved by this gate.

    May 2026 - also calls ``_recompute_tier`` so T3 CHANGEMAKER promotion
    fires immediately on first dispatch / resolve (without waiting for
    the next submit).
    """
    from app.models.report import Report, Device, ReporterProfile
    if not report or not report.device_id:
        return

    # ── Idempotency gate (audit C-2 fix) ────────────────────────────
    # Re-load the report under a row lock and re-check the stamp.
    # If another transaction already credited this report, bail.
    locked = (
        db.query(Report)
          .filter(Report.id == report.id)
          .with_for_update()
          .first()
    )
    if locked is None or locked.first_verified_at is not None:
        return
    locked.first_verified_at = datetime.now(timezone.utc)
    # Mirror onto the in-memory instance the caller holds so any
    # downstream serialization sees the freshly-set timestamp without
    # needing a session.refresh().
    report.first_verified_at = locked.first_verified_at

    device = db.query(Device).filter(Device.id == report.device_id).first()
    if not device or not device.device_hash:
        return
    profile = db.query(ReporterProfile).filter(
        ReporterProfile.device_hash == device.device_hash
    ).first()
    if not profile:
        profile = ReporterProfile(device_hash=device.device_hash)
        db.add(profile)
    profile.verified_count = (profile.verified_count or 0) + 1
    _recompute_tier(profile, db)


def _mark_report_lives_impacted_for_tier(report, db: Session) -> None:
    """Called when an analyst PATCHes ``lives_impacted`` on a report.

    The report row itself is already updated by the caller; we just
    look up the device's profile and recompute the tier so T4
    LIFEKEEPER promotion is visible on the next /profile read (the
    PWA also celebrates this via the tier-up delta-detection block
    on My Reports open).

    Idempotent: re-PATCHing the same value triggers a no-op recompute
    that lands on the same tier.
    """
    from app.models.report import Device, ReporterProfile
    if not report or not report.device_id:
        return
    device = db.query(Device).filter(Device.id == report.device_id).first()
    if not device or not device.device_hash:
        return
    profile = db.query(ReporterProfile).filter(
        ReporterProfile.device_hash == device.device_hash
    ).first()
    if not profile:
        profile = ReporterProfile(device_hash=device.device_hash)
        db.add(profile)
    _recompute_tier(profile, db)


# ═══════════════════════════════════════════════════════════════════════════════
# BUILDING VERSIONING: Group multiple reports about the same structure
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/building/{building_id}")
def get_building_history(building_id: str, db: Session = Depends(get_db)):
    """Versioned history of all reports tied to one building.

    UNDP brief (Apr 2026): "multiple damage report submissions about the
    same building, with different levels of damage - the system should
    support 'versioning' of damage levels, to show the latest, most up-to-
    date information about the damage status. This most likely would be
    achieved through biasing towards the most recent, complete damage
    report submission for a particular location."

    Response shape (Apr 2026 UI v2.1 W4):
        {
          "building_id": "osm:way:...",
          "total": 3,
          "latest_id":  "<report-id of the freshest complete report>",
          "reports": [ ...ReportResponse, latest-first... ]
        }

    Each `ReportResponse` element is augmented in-place with two read-
    only fields the dashboard renders as a ribbon on the detail panel:

        `building_version_ordinal` - 1-based index within this building's
            history (1 = latest). Human-rendered as "V 2 of 3".
        `building_is_latest`       - true for ordinal 1, false otherwise.

    "Latest complete" bias: if a newer report exists but is still in
    PARTIAL sync status (chunks incomplete), we still consider it the
    latest. Operators value freshness over "complete" flag. A future
    tightening would check Media.assembly_status instead - noted in
    docs/UNDP-ALIGNMENT-CHANGELOG.md for the followup sprint.
    """
    reports = db.query(Report).filter(
        Report.building_id == building_id,
        Report.deletion_requested_at.is_(None)
    ).order_by(Report.server_created_at.desc()).all()

    # Phase F.5.c (May 2026) - building_version_ordinal +
    # building_is_latest are now canonical columns on the Report
    # row (alembic 0027 + the _apply_building_versioning hook in
    # app/models/report.py). Convention: ordinal 1 = OLDEST, max =
    # LATEST (chronological ascending). is_latest = true exactly on
    # the row with the maximum ordinal in the partition.
    #
    # Previous implementation OVERWROTE these from the in-flight
    # sort order (newest-first → ordinal 1). That conflicted with
    # the canonical DB state. The endpoint now respects whatever
    # the DB says - Pydantic serialisation picks up the columns
    # directly from the row. The response is still sorted newest-
    # first for dashboard display convenience, but the ordinal
    # values flow from the source of truth.
    serialised = [ReportResponse.model_validate(r).model_dump(mode="json") for r in reports]
    total = len(serialised)
    # latest_id is the row WHERE building_is_latest = true (canonical).
    # Fallback to the first (newest-first sorted) row if no row carries
    # the flag - happens when the row that originally carried the flag
    # was soft-deleted (the hook flipped its sibling to false at insert
    # time, but it doesn't re-stamp on delete). Surface the fallback
    # honestly: also FLIP the response's first-row is_latest to true
    # so dashboards reading either `latest_id` OR `reports[0].is_latest`
    # see a consistent answer.
    has_canonical_latest = any(row.get("building_is_latest") for row in serialised)
    if has_canonical_latest:
        latest_id = next(row["id"] for row in serialised if row.get("building_is_latest"))
    elif serialised:
        latest_id = serialised[0]["id"]
        # Honest fallback: the newest undeleted row is the de-facto
        # latest. Mark it as such in the response without mutating
        # the canonical DB column.
        serialised[0]["building_is_latest"] = True
    else:
        latest_id = None
    return {
        "building_id": building_id,
        "total": total,
        "latest_id": latest_id,
        "reports": serialised,
    }


# ── Stable media URLs ────────────────────────────────────────────
#
# Background - the dashboard's HAR analysis showed every ~4 s API poll
# generated a FRESH presigned S3 URL for every media row, because
# MediaResponse._resolve_url called storage.public_url() on each
# serialization. Same image bytes → 49 different X-Amz-Signature
# values → browser cache miss every poll → 98× refetch of identical
# bytes (~2.5 MB wasted per dashboard tab per 6 minutes). Same story
# for thumbnails on partial uploads.
#
# Fix - MediaResponse now emits a STABLE backend-routed URL of the form
# `/api/v1/reports/media/<media_id>/<file|thumb>`. The browser caches
# under that URL key and reuses bytes across polls. The endpoint below
# is what those URLs resolve to: a 302 redirect to a freshly-presigned
# S3 URL, with a 1-hour Cache-Control on the redirect itself so even
# cold caches hit the backend at most once per hour per image.
#
# Auth model - intentionally NO auth on this endpoint. The previous
# behaviour embedded presigned S3 URLs directly in the API response,
# making media accessible to anyone who held a presigned URL (no auth
# header needed). The new behaviour matches that exactly: anyone with
# the media_id (a UUID, unguessable) can fetch. Listing media_ids
# still requires Bearer auth via /api/v1/reports/.

def _redirect_cache_control(storage, target: str) -> str:
    """Cache-Control header value for a media/satellite 302 redirect.

    `target` on S3 is a presigned URL whose signature expires after
    ``storage.PRESIGN_TTL_SEC``. If the browser caches THIS redirect longer
    than that signature lives, the cached redirect outlives its target: the
    image renders, then 403s ("expired signature") the moment the presign
    dies and stays broken until the redirect cache clears (the PROD symptom -
    media render for ~15 min after a report finishes, then every image
    breaks). Cap the cache safely BELOW the presign TTL (120 s margin for
    clock skew + the browser→cache write delay). Non-expiring local
    ``/static/`` URLs (no presign) keep the full 1 h cache.
    """
    ttl = getattr(storage, "PRESIGN_TTL_SEC", None)
    if (target.startswith("http://") or target.startswith("https://")) and ttl:
        return f"public, max-age={max(60, int(ttl) - 120)}"
    return "public, max-age=3600"


@router.get("/media/{media_id}/file")
@router.get("/media/{media_id}/thumb")
def get_media_redirect(
    request: Request,
    media_id: str,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to fresh presigned S3 URL (or local /static/ for dev).

    The dashboard receives this URL in MediaResponse instead of a churning
    presigned S3 URL. Every poll renders the same `<img src>`, so the
    browser HTTP cache reuses the bytes - eliminating the per-poll
    refetch storm documented in HAR analysis.

    `/file` → media.url (full image / audio / video)
    `/thumb` → media.thumbnail_url (small placeholder, may be partial-
              assembly bytes during chunked upload)

    Cache-Control: the redirect is cached, but never longer than the
    presigned target's signature TTL (see `_redirect_cache_control`) - else
    a cached redirect would outlive its presign and 403. Non-expiring local
    /static/ URLs keep the full hour. The S3 object cache TTL is bucket-side.

    URL gating (May 2026, Batch B-A): when an IMAGE row is in
    `pii_blur_status='pending'`, the route returns 425 Too Early.
    This closes the 5-30 s window where the storage object held the
    assembled-but-unblurred bytes and a /file request would otherwise
    redirect to them. The 425 lifts the moment `_run_server_pii_blur`
    writes the terminal status (complete_clean /
    complete_with_redactions / failed). Thumbnails are NOT gated -
    they're explicitly partial-assembly previews and operators expect
    them to lead the full file.
    """
    media = db.query(Media).filter(Media.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")

    # Path-suffix sniff is more reliable than parsing routing params here
    # (FastAPI doesn't expose which alternative `@router.get` matched).
    is_thumb = request.url.path.rstrip("/").endswith("/thumb")

    # B-A URL gating: only applies to the /file route on IMAGE rows.
    # Thumbnails + audio bypass.
    if not is_thumb and getattr(media, 'type', None) == 'IMAGE':
        blur_status = getattr(media, 'pii_blur_status', None)
        if blur_status == 'pending':
            # 425 Too Early - RFC 8470. Tells caching layers (CDN,
            # browsers) that this is a transient state, not a 404 to
            # cache. Retry-After advises a polite poll cadence.
            raise HTTPException(
                status_code=425,
                detail="PII blur in progress - retry shortly",
                headers={"Retry-After": "2"},
            )

    db_url = media.thumbnail_url if (is_thumb and media.thumbnail_url) else media.url
    if not db_url:
        raise HTTPException(status_code=404, detail="No URL available for this media")

    storage = _get_media_storage()
    target = storage.public_url(db_url)

    # Defensive: if storage backend can't produce a real URL (e.g. local
    # backend asked to resolve an `s3://` row from a previously-S3 deploy),
    # surface 503 instead of redirecting the browser to garbage.
    if not (target.startswith("http://") or target.startswith("https://") or target.startswith("/")):
        raise HTTPException(
            status_code=503,
            detail="Storage backend cannot resolve URL for this media",
        )

    return RedirectResponse(
        url=target,
        status_code=302,
        headers={"Cache-Control": _redirect_cache_control(storage, target)},
    )


# ── Tier-status reconciliation ───────────────────────────────────
#
# The PWA caches its in-flight upload state (`item.photoVariants`,
# `item.extraPhotosVariants`) in IndexedDB and decides locally when a
# report is "fully delivered" before deleting its queue row. This
# endpoint lets the PWA reconcile that local view against the
# authoritative server state before dequeueing: "does the backend
# actually have every Media row I think I sent, and is every row
# assembled?" If a tier is missing or stuck partial, the PWA keeps
# the queue item and retries on the next sync pass.
#
# No Bearer auth - same anonymity contract as the chunk endpoints
# (UNDP must-have #9: submission must work without login). The
# report_id is a UUID and only the original submitter knows the
# media_ids associated with it.
@router.get("/{report_id}/tier-status")
def get_report_tier_status(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Return the server-side assembly status of every Media row for a report.

    Used by the PWA's pre-dequeue reconciliation step. The PWA matches
    each row's `id` against its local `photoVariants[tier].mediaId` /
    `extraPhotosVariants[i][tier].mediaId` to confirm every expected
    tier was assembled before deleting the IndexedDB queue row.

    Response shape:
        {
          "report_id": "...",
          "media": [
            {
              "id": "<media UUID>",
              "photo_group_id": "<group UUID or null>",
              "type": "IMAGE" | "AUDIO",
              "resolution_tier": "LOW" | "MEDIUM" | "HIGH" | "ORIGINAL",
              "assembly_status": "complete" | "assembling" | "pending" | "failed",
              "completion_pct": 0-100,
              "received_chunks": int,
              "chunk_count": int
            },
            ...
          ]
        }
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    media_rows = db.query(Media).filter(Media.id.in_(
        db.query(Media.id).filter(Media.report_id == report_id)
    )).all() if False else db.query(Media).filter(Media.report_id == report_id).all()

    return {
        "report_id": report_id,
        "media": [
            {
                "id": m.id,
                "photo_group_id": getattr(m, "photo_group_id", None),
                "type": (m.type.value if hasattr(m.type, "value") else str(m.type)) if m.type else None,
                "resolution_tier": (
                    m.resolution_tier.value
                    if hasattr(m.resolution_tier, "value") else str(m.resolution_tier)
                ) if m.resolution_tier else None,
                "assembly_status": m.assembly_status or "pending",
                "completion_pct": float(m.completion_pct or 0),
                "received_chunks": int(m.received_chunks or 0),
                "chunk_count": int(m.chunk_count or 0),
            }
            for m in media_rows
        ],
    }


# ── Stable satellite URLs ────────────────────────────────────────
#
# Background - the satellite verification feature stores 1 primary image,
# 0-1 alternate images, and a 4-cell multi-provider grid (AWS Sentinel-2 +
# Microsoft Planetary Computer + ESA Copernicus + Mapbox). Before this
# refactor, VerificationResponse._resolve_sat_url called
# storage.public_url() directly, regenerating a fresh X-Amz-Signature on
# every dashboard poll. Worse, the dashboard hard-coded
# `${BACKEND_HOST}${v.satellite_image_url}` at 11 render sites - when
# MEDIA_BACKEND=s3 and the serializer returned a signed
# `https://s3.../...` URL, the dashboard prepended BACKEND_HOST and
# produced `https://undp/.../https://s3.../...` → 404.
#
# Fix - VerificationResponse now emits a STABLE backend-routed URL of the
# form `/api/v1/reports/{report_id}/satellite/<primary|alt|grid/<idx>>`.
# This endpoint resolves to a fresh presigned target on demand and tags
# the redirect via `_redirect_cache_control` (cache capped below the
# presign TTL). Same browser-cache-friendly pattern as the media redirect.
#
# Auth model - intentionally NO auth (matches `get_media_redirect` and the
# previous behaviour where presigned URLs were embedded in API responses).
# The report_id is a UUID, unguessable - listing report_ids still requires
# Bearer auth via /api/v1/reports/.

def _satellite_redirect(
    db: Session,
    report_id: str,
    which: str,
    grid_idx: Optional[int] = None,
):
    """Resolve the satellite image source on a SatelliteVerification row,
    then 302-redirect to a fresh presigned URL (or local /static/ path).

    `which` is one of "primary", "alt", "grid". For "grid", `grid_idx`
    selects the entry from the multi-provider list.

    Same `_redirect_cache_control` as `get_media_redirect` - the redirect is
    cached, but never longer than the presigned URL's signature TTL.
    """
    v = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()
    if not v:
        raise HTTPException(status_code=404, detail="No verification result for this report")

    db_url: Optional[str] = None
    if which == "primary":
        db_url = v.satellite_image_url
    elif which == "alt":
        db_url = v.satellite_image_url_alt
    elif which == "grid":
        # Decode the JSON column. Forgiving - malformed JSON yields no URL
        # rather than a 500.
        if grid_idx is None or grid_idx < 0:
            raise HTTPException(status_code=404, detail="Invalid grid index")
        try:
            import json as _json
            entries = _json.loads(v.satellite_images_json or "[]")
        except Exception:
            entries = []
        if grid_idx >= len(entries):
            raise HTTPException(status_code=404, detail="Grid index out of range")
        entry = entries[grid_idx]
        if isinstance(entry, dict):
            db_url = entry.get("url")

    if not db_url:
        raise HTTPException(status_code=404, detail="No URL available for this satellite slot")

    storage = _get_media_storage()
    target = storage.public_url(db_url)

    # Defensive: if storage backend cannot produce a real URL (e.g. a
    # cross-backend mismatch), surface 503 rather than redirect to garbage.
    if not (target.startswith("http://") or target.startswith("https://") or target.startswith("/")):
        raise HTTPException(
            status_code=503,
            detail="Storage backend cannot resolve URL for this satellite image",
        )

    return RedirectResponse(
        url=target,
        status_code=302,
        headers={"Cache-Control": _redirect_cache_control(storage, target)},
    )


@router.get("/{report_id}/satellite/primary")
def get_satellite_primary(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to the primary satellite image.

    Maps to `SatelliteVerification.satellite_image_url`. The "primary"
    is whichever provider the chain picked first (typically Sentinel-2
    via AWS, Microsoft, or ESA - Mapbox only when all Sentinel-2
    sources fail or are heavily clouded)."""
    return _satellite_redirect(db, report_id, "primary")


@router.get("/{report_id}/satellite/alt")
def get_satellite_alt(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to the alternate satellite image.

    Maps to `SatelliteVerification.satellite_image_url_alt` - typically
    the higher-resolution Mapbox/Maxar fallback fetched alongside the
    primary Sentinel-2 result."""
    return _satellite_redirect(db, report_id, "alt")


@router.get("/{report_id}/satellite/grid/{idx}")
def get_satellite_grid_cell(
    report_id: str,
    idx: int,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to the Nth cell of the multi-provider 2×2 grid.

    Maps to entry `idx` in `SatelliteVerification.satellite_images_json`
    (the Apr 2026 multi-provider fan-out - AWS / Microsoft / ESA /
    Mapbox). Order matches what the chain returned."""
    return _satellite_redirect(db, report_id, "grid", grid_idx=idx)


# ── Public evidence endpoint ─────────────────────────────────────
#
# .2 of the UNDP-grade satellite-verification rebuild.
#
# The dashboard's verification panel now offers a "Share evidence" button
# that copies a public URL of the form:
#   https://undp.crisplabs.tech/web-dashboard/src/evidence.html?id=<report_id>
#
# That static page (web-dashboard/src/evidence.html) fetches the JSON
# below - no Bearer auth, no login flow. Trust model matches the
# existing presigned-URL pattern: anyone with the report_id (a UUID,
# unguessable) can view. Listing report_ids still requires auth via
# /api/v1/reports/.
#
# Returned shape is intentionally compact and stable - designed for a
# UNDP submission demo where judges click a link and instantly see a
# clean evidence page. NO chunked-upload metadata, NO operator-only
# flags. Just the headline truth-score + sat imagery + reasoning.

@router.get("/{report_id}/evidence")
def get_public_evidence(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Public, auth-free read of a report's verification evidence.

    Returns photo URL (stable `/api/v1/reports/media/<id>/file`),
    satellite URLs (stable `/api/v1/reports/<rid>/satellite/...`),
    verdict, total score, sub-scores, key findings, caveats, AI
    reasoning, plus the headline incident metadata (severity, infra
    type, location name, time of report).

    Returns 404 if the report doesn't exist or has been soft-deleted.
    Returns 200 with `verification: null` if no verification has run
    yet - the evidence page renders an "awaiting verification" state.
    """
    r = db.query(Report).options(
        joinedload(Report.media),
        joinedload(Report.location),
        joinedload(Report.verification),
    ).filter(
        Report.id == report_id,
        Report.deletion_requested_at.is_(None),
    ).first()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")

    loc = r.location
    v = r.verification

    # Pick the highest-tier complete IMAGE the citizen submitted. Stable
    # /api/v1/reports/media/<id>/file URL - no auth, browser-cacheable.
    photo_url = None
    img = next(
        (m for m in r.media or [] if m.type == MediaTypeEnum.IMAGE
         and getattr(m, "assembly_status", "") == "complete" and m.url),
        None,
    )
    if img:
        # Match what MediaResponse._resolve_url emits for s3:// rows.
        # For local backend (`/static/...`) we pass through so judges
        # hitting the page in dev still see the file.
        if img.url.startswith("s3://"):
            photo_url = f"/api/v1/reports/media/{img.id}/file"
        else:
            photo_url = img.url  # `/static/...` or http(s)://

    # Verification block (compact, demo-friendly shape).
    verification_block = None
    if v:
        # Multi-provider grid URLs - same stable URLs the dashboard uses.
        sat_grid: List[dict] = []
        try:
            import json as _json
            entries = _json.loads(v.satellite_images_json or "[]") if v.satellite_images_json else []
        except Exception:
            entries = []
        for idx, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            u = entry.get("url")
            if u and u.startswith("s3://"):
                ref = f"/api/v1/reports/{report_id}/satellite/grid/{idx}"
            else:
                ref = u
            sat_grid.append({
                "url": ref,
                "source": entry.get("source"),
                "acquisition_date": entry.get("acquisition_date"),
                "cloud_cover_pct": entry.get("cloud_cover_pct"),
                "resolution_m": entry.get("resolution_m"),
            })

        # Primary URL (legacy single-image path; still emitted for
        # verifications that ran before the multi-provider chain shipped).
        primary_url = None
        if v.satellite_image_url:
            if v.satellite_image_url.startswith("s3://"):
                primary_url = f"/api/v1/reports/{report_id}/satellite/primary"
            else:
                primary_url = v.satellite_image_url

        verification_block = {
            "verdict": v.verdict,
            "total_score": v.total_score,
            "scores": v.scores or {},
            "reasoning": v.reasoning,
            "key_findings": v.key_findings or [],
            "caveats": v.caveats or [],
            "satellite_scene_description": v.satellite_scene_description,
            "photo_analysis": v.photo_analysis,
            "satellite_source": v.satellite_source,
            "satellite_acquisition_date": v.satellite_acquisition_date,
            "satellite_cloud_cover_pct": v.satellite_cloud_cover_pct,
            "satellite_days_gap": v.satellite_days_gap,
            "primary_url": primary_url,
            "satellite_images": sat_grid,
            "scored_at": (
                v.scored_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if v.scored_at else None
            ),
        }

    return {
        "report_id": r.id,
        "infrastructure_type": r.infrastructure_type.value if r.infrastructure_type else None,
        "infrastructure_name": r.infrastructure_name,
        "severity": r.severity.value if r.severity else None,
        "crisis_type": r.crisis_type,
        "damage_classification": r.damage_classification,
        "description": r.description,
        "server_created_at": (
            r.server_created_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if r.server_created_at else None
        ),
        "location": {
            "latitude": loc.latitude if loc else None,
            "longitude": loc.longitude if loc else None,
            "name": (loc.user_location_name or loc.device_location_name) if loc else None,
        } if loc else None,
        "photo_url": photo_url,
        "verification": verification_block,
    }


@router.get("/media/{media_id}/duplicates")
def get_media_duplicates(
    media_id: str,
    threshold: int = 10,
    window_hours: int = 24,
    db: Session = Depends(get_db),
):
    """List media rows that are perceptually similar to `media_id`.

    UNDP nice-to-have #3 (redundancy detection): the dashboard hits this
    endpoint when an operator clicks "Possible duplicate" on a photo.
    Returns candidates whose pHash Hamming distance ≤ `threshold` (default
    10 / 64), scoped to the last `window_hours` (default 24 h) so we don't
    drag in unrelated historical matches. Same-report media is filtered
    out - a photo is not its own duplicate.

    Scope intentionally time-windowed + hash-filtered - NOT an O(N²) join.
    The typical working set is a few hundred candidates per crisis cell,
    which Python-side Hamming filtering dispatches in milliseconds.
    """
    from datetime import datetime, timedelta, timezone as _tz
    from app.services.phash import hamming_distance

    source = db.query(Media).filter(Media.id == media_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Media not found")
    if not source.photo_phash:
        # The row hasn't been scanned yet - no false "unique" claim.
        return {
            "media_id": media_id, "phash": None,
            "candidates": [],
            "message": "photo_phash not yet computed (legacy or pre-assembly)",
        }

    cutoff = datetime.now(_tz.utc) - timedelta(hours=max(1, window_hours))
    recent = db.query(Media).filter(
        Media.id != media_id,
        Media.photo_phash.isnot(None),
        Media.created_at >= cutoff,
    ).limit(2000).all()   # hard safety cap for absurd query windows

    hits = []
    for m in recent:
        d = hamming_distance(source.photo_phash, m.photo_phash)
        if d <= max(0, min(64, threshold)):
            hits.append({
                "media_id": m.id,
                "report_id": m.report_id,
                "phash": m.photo_phash,
                "hamming_distance": d,
                "url": m.url or None,
                "created_at": _utc_iso(m.created_at),
            })
    hits.sort(key=lambda x: x["hamming_distance"])
    return {
        "media_id": media_id,
        "phash": source.photo_phash,
        "threshold": threshold,
        "window_hours": window_hours,
        "candidates": hits,
    }


# ── Incident Intelligence P3 - within-cluster duplicate surfacing + decisions ──
def _rdd_desc_similarity(a: Optional[str], b: Optional[str]) -> float:
    a = (a or "").strip().lower(); b = (b or "").strip().lower()
    if not a or not b:
        return 0.0
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def _rdd_phash_match(media_a, media_b, threshold: int = 10) -> bool:
    from app.services.phash import hamming_distance
    pa = [m.photo_phash for m in (media_a or []) if getattr(m, "photo_phash", None)]
    pb = [m.photo_phash for m in (media_b or []) if getattr(m, "photo_phash", None)]
    for x in pa:
        for y in pb:
            if hamming_distance(x, y) <= threshold:
                return True
    return False


def _rdd_human_delta(seconds: float) -> str:
    """Human-readable time gap for the duplicate "reason" chips, e.g. "12 min apart"."""
    m = int(round(seconds / 60.0))
    if m < 60:
        return f"{m} min apart"
    h = m / 60.0
    if h < 24:
        return f"{h:.1f} h apart"
    return f"{int(round(h / 24.0))} d apart"


def _rdd_reporter_label(r: "Report") -> str:
    """Masked, non-PII reporter label for the duplicate review panel (mirrors the
    feed's "User abc1234" treatment - never exposes email/phone)."""
    uid = getattr(r, "user_id", None)
    if uid:
        return "User " + str(uid)[:7]
    dev = getattr(r, "device_id", None)
    if dev:
        return "Device " + str(dev)[:7]
    return "Anonymous"


def _rdd_score_pair(a: "Report", b: "Report"):
    """Score how likely two SAME-CLUSTER reports describe the same incident.
    Lean, deterministic, signals already on the row. White-box: alongside the
    numeric score it returns the per-factor `reasons` so analysts see WHY two
    reports were flagged (no black-box). Returns (score, level, sim, reasons)."""
    reasons = []  # every matched factor + its weight, in scoring order
    score = 20  # same building/cluster base (they already share a location)
    reasons.append({"factor": "same_building", "matched": True, "weight": 20,
                    "label": "Same building"})
    if a.crisis_type and a.crisis_type == b.crisis_type:
        score += 18
        reasons.append({"factor": "same_crisis_type", "matched": True, "weight": 18,
                        "label": "Same crisis type", "detail": a.crisis_type})
    if ((a.infrastructure_type and a.infrastructure_type == b.infrastructure_type)
            or (a.infrastructure_sub_type and a.infrastructure_sub_type == b.infrastructure_sub_type)):
        score += 12
        reasons.append({"factor": "same_infrastructure", "matched": True, "weight": 12,
                        "label": "Same infrastructure"})
    try:
        dt = abs((a.server_created_at - b.server_created_at).total_seconds())
        if dt <= 3600:
            score += 25
            reasons.append({"factor": "within_1h", "matched": True, "weight": 25,
                            "label": "Within 1 hour", "detail": _rdd_human_delta(dt)})
        elif dt <= 6 * 3600:
            score += 12
            reasons.append({"factor": "within_6h", "matched": True, "weight": 12,
                            "label": "Within 6 hours", "detail": _rdd_human_delta(dt)})
        elif dt <= 24 * 3600:
            score += 5
            reasons.append({"factor": "within_24h", "matched": True, "weight": 5,
                            "label": "Within 24 hours", "detail": _rdd_human_delta(dt)})
    except Exception:
        pass
    if _rdd_phash_match(getattr(a, "media", None), getattr(b, "media", None)):
        score += 28
        reasons.append({"factor": "similar_image", "matched": True, "weight": 28,
                        "label": "Similar image"})
    sim = _rdd_desc_similarity(a.description, b.description)
    if sim >= 0.6:
        score += 18
        reasons.append({"factor": "similar_description", "matched": True, "weight": 18,
                        "label": "Similar description", "detail": f"{int(round(sim * 100))}% match"})
    elif sim >= 0.4:
        score += 7
        reasons.append({"factor": "similar_description", "matched": True, "weight": 7,
                        "label": "Similar description", "detail": f"{int(round(sim * 100))}% match"})
    if a.device_id and a.device_id == b.device_id:
        score += 8
        reasons.append({"factor": "same_reporter", "matched": True, "weight": 8,
                        "label": "Same reporter device"})
    score = min(100, score)
    level = ("HIGH" if score >= 88 else "MEDIUM" if score >= 68
             else "LOW" if score >= 50 else None)
    return score, level, round(sim, 2), reasons


def _rdd_cluster_key(r: "Report") -> str:
    if r.building_id:
        return r.building_id
    h = getattr(getattr(r, "location", None), "h3_idx", None)
    if h:
        return "h3:" + h
    return r.id   # singleton - no within-cluster peers


def _resolve_duplicate_groups(db: Session):
    """Derive the duplicate-grouping view from active analyst decisions.

    Duplicates are a RELATIONSHIP (report -> report), NOT a new entity. From the
    active CONFIRMED_DUP / SET_PRIMARY rows we compute, per within-building group:
      * the group's PRIMARY report (the active SET_PRIMARY target if any, else the
        report the duplicates were confirmed against),
      * the HIDDEN members - every OTHER report in the group, which collapse out of
        the default feed + map (they remain in the DB + reachable by id), and
      * how many duplicates roll up under each primary (the feed/marker badge count).

    This is the single source of truth for "what is hidden" so the feed, markers,
    analytics + the badge can never disagree. One cheap query over the small
    report_duplicate_decisions table; nothing here is a cluster object.
    Returns (hidden_ids: set[str], primary_count: dict[str, int]).
    """
    rows = (
        db.query(ReportDuplicateDecision)
        .filter(
            ReportDuplicateDecision.undone_at.is_(None),
            ReportDuplicateDecision.decision.in_(("CONFIRMED_DUP", "SET_PRIMARY")),
        )
        .all()
    )
    by_key: dict = {}
    for d in rows:
        by_key.setdefault(d.cluster_key, []).append(d)

    hidden: set = set()
    primary_count: dict = {}
    for decs in by_key.values():
        confirmed = [d for d in decs if d.decision == "CONFIRMED_DUP" and d.related_report_id]
        if not confirmed:
            continue   # a lone SET_PRIMARY with no confirmed dups hides nothing
        members: set = set()
        for d in confirmed:
            members.add(d.primary_report_id)
            members.add(d.related_report_id)
        set_primary = next((d.primary_report_id for d in decs if d.decision == "SET_PRIMARY"), None)
        if set_primary and set_primary in members:
            primary = set_primary
        else:
            # the report that is a confirmed primary but never itself a related
            relateds = {d.related_report_id for d in confirmed}
            prims = [d.primary_report_id for d in confirmed if d.primary_report_id not in relateds]
            primary = prims[0] if prims else confirmed[0].primary_report_id
        group_hidden = members - {primary}
        if group_hidden:
            hidden |= group_hidden
            primary_count[primary] = primary_count.get(primary, 0) + len(group_hidden)
    return hidden, primary_count


@router.get("/{report_id}/duplicates")
def get_report_duplicates(report_id: str, db: Session = Depends(get_db), user=Depends(require_viewer)):
    """Probable duplicates of {report_id} WITHIN its building cluster, with a
    confidence level (HIGH/MEDIUM/LOW). Honors analyst decisions: NOT_DUP pairs
    are suppressed, CONFIRMED_DUP pairs pinned HIGH. Singletons (no building) +
    h3-only clusters return no peers (the building is the auto-grouped HIGH cluster)."""
    src = db.query(Report).options(joinedload(Report.media)).filter(Report.id == report_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Report not found")
    cluster_key = _rdd_cluster_key(src)
    if not src.building_id:
        return {"report_id": report_id, "cluster_key": cluster_key, "primary_report_id": None, "candidates": []}

    others = (db.query(Report).options(joinedload(Report.media))
              .filter(Report.building_id == src.building_id,
                      Report.id != report_id,
                      Report.deletion_requested_at.is_(None))
              .limit(200).all())

    decisions = (db.query(ReportDuplicateDecision)
                 .filter(ReportDuplicateDecision.cluster_key == cluster_key,
                         ReportDuplicateDecision.undone_at.is_(None)).all())
    not_dup, confirmed = set(), set()
    primary_id = None
    for d in decisions:
        if d.decision == "SET_PRIMARY":
            primary_id = d.primary_report_id
        elif d.related_report_id:
            pair = frozenset((d.primary_report_id, d.related_report_id))
            if d.decision == "NOT_DUP":
                not_dup.add(pair)
            elif d.decision == "CONFIRMED_DUP":
                confirmed.add(pair)

    candidates = []
    for o in others:
        pair = frozenset((report_id, o.id))
        if pair in not_dup:
            continue   # analyst ruled NOT a duplicate → never re-surface
        score, level, sim, reasons = _rdd_score_pair(src, o)
        is_conf = pair in confirmed
        if is_conf:
            level, score = "HIGH", max(score, 90)
        if not level:
            continue
        loc = getattr(o, "location", None)
        candidates.append({
            "report_id": o.id, "confidence": level, "score": score,
            "confirmed": is_conf, "description_similarity": sim,
            "reasons": reasons,   # white-box: per-factor breakdown of WHY (no black-box scoring)
            "reporter": _rdd_reporter_label(o),   # masked reporter for the review panel
            "severity": getattr(getattr(o, "severity", None), "value", None),
            "status": getattr(getattr(o, "status", None), "value", None),
            "crisis_type": o.crisis_type, "infrastructure_type": getattr(getattr(o, "infrastructure_type", None), "value", None),
            "server_created_at": _utc_iso(o.server_created_at),
            "location_name": (loc and (loc.user_location_name or loc.device_location_name)) or None,
        })
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return {"report_id": report_id, "cluster_key": cluster_key,
            "primary_report_id": primary_id, "candidates": candidates}


class DuplicateDecisionRequest(_ReclaimBaseModel):
    decision: str                                  # CONFIRMED_DUP | NOT_DUP | SET_PRIMARY | UNDO
    related_report_id: Optional[str] = None        # the other report in the pair (not for SET_PRIMARY)


@router.post("/{report_id}/duplicate-decision")
def record_duplicate_decision(report_id: str, req: DuplicateDecisionRequest,
                              db: Session = Depends(get_db), user=Depends(require_analyst)):
    """Record (or undo) an analyst duplicate decision. Reversible: a new decision
    supersedes the prior active one for the same pair/primary (older row's
    undone_at stamped); UNDO stamps the active one. The scorer reads only active
    (undone_at IS NULL) rows, so decisions persist + drive future surfacing."""
    import uuid
    from datetime import datetime, timezone as _tz
    src = db.query(Report).options(joinedload(Report.location)).filter(Report.id == report_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Report not found")
    dec = (req.decision or "").strip().upper()
    cluster_key = _rdd_cluster_key(src)
    now = datetime.now(_tz.utc)
    actor = getattr(user, "id", None)

    def _pair_filter(q):
        rid = req.related_report_id
        return q.filter(or_(
            and_(ReportDuplicateDecision.primary_report_id == report_id,
                 ReportDuplicateDecision.related_report_id == rid),
            and_(ReportDuplicateDecision.primary_report_id == rid,
                 ReportDuplicateDecision.related_report_id == report_id),
        ))

    if dec == "UNDO":
        q = db.query(ReportDuplicateDecision).filter(
            ReportDuplicateDecision.cluster_key == cluster_key,
            ReportDuplicateDecision.undone_at.is_(None))
        q = (_pair_filter(q) if req.related_report_id
             else q.filter(ReportDuplicateDecision.primary_report_id == report_id,
                           ReportDuplicateDecision.related_report_id.is_(None),
                           ReportDuplicateDecision.decision == "SET_PRIMARY"))
        n = 0
        for d in q.all():
            d.undone_at = now; n += 1
        # Bump the involved reports' updated_at so the dashboard's delta poll
        # re-sends the primary with its refreshed "N duplicates merged" badge and
        # the un-hidden report reappears (and the listing ETag shifts) on undo.
        src.updated_at = now
        if req.related_report_id:
            _rel = db.query(Report).filter(Report.id == req.related_report_id).first()
            if _rel is not None:
                _rel.updated_at = now
        db.commit()
        return {"undone": n, "cluster_key": cluster_key}

    if dec not in ("CONFIRMED_DUP", "NOT_DUP", "SET_PRIMARY"):
        raise HTTPException(status_code=400, detail="Invalid decision")
    if dec in ("CONFIRMED_DUP", "NOT_DUP") and not req.related_report_id:
        raise HTTPException(status_code=400, detail="related_report_id required for this decision")

    # Supersede any prior ACTIVE decision for the same pair (or the cluster's
    # SET_PRIMARY) so there is exactly one active decision per pair/primary.
    base = db.query(ReportDuplicateDecision).filter(
        ReportDuplicateDecision.cluster_key == cluster_key,
        ReportDuplicateDecision.undone_at.is_(None))
    if dec == "SET_PRIMARY":
        base = base.filter(ReportDuplicateDecision.decision == "SET_PRIMARY")
    else:
        base = _pair_filter(base)
    for d in base.all():
        d.undone_at = now

    row = ReportDuplicateDecision(
        id=str(uuid.uuid4()), cluster_key=cluster_key, primary_report_id=report_id,
        related_report_id=(None if dec == "SET_PRIMARY" else req.related_report_id),
        decision=dec, actor_user_id=actor)
    db.add(row)
    # Bump the involved reports' updated_at so the dashboard's delta poll re-sends
    # the primary with its refreshed "N duplicates merged" badge (and the ETag
    # shifts) the moment a duplicate is confirmed / the primary changes.
    src.updated_at = now
    if req.related_report_id:
        _rel = db.query(Report).filter(Report.id == req.related_report_id).first()
        if _rel is not None:
            _rel.updated_at = now
    db.commit()
    return {"id": row.id, "decision": dec, "cluster_key": cluster_key}


def _rdd_info_score(r: "Report") -> float:
    """Information richness of a report. Used to break ties when choosing the
    canonical PRIMARY of a duplicate cluster: the primary is the report that landed
    FIRST, and among reports that arrived at the same instant this picks the
    most-complete one. Transparent + bounded; defensive getattr so an unusual row
    shape never 500s a bulk merge."""
    s = 0.0
    try:
        s += 3.0 * len(getattr(r, "media", None) or [])
    except Exception:
        pass
    desc = (getattr(r, "description", None) or "").strip()
    if desc:
        s += min(len(desc), 280) / 40.0          # up to 7
    try:
        from app.models.report import ReviewerVerdictEnum as _RV
        if getattr(r, "reviewer_verdict", None) == _RV.ACCEPTED.value:
            s += 5.0                              # human-verified = authoritative
    except Exception:
        pass
    if getattr(r, "building_id", None):
        s += 2.0
    if getattr(r, "crisis_type", None):
        s += 1.0
    if getattr(r, "damage_classification", None):
        s += 1.0
    it = getattr(r, "infrastructure_type", None)
    if it and str(getattr(it, "value", it)).upper() != "OTHER":
        s += 1.0
    if getattr(r, "service_status", None):
        s += 1.0
    try:
        loc = getattr(r, "location", None)
        if loc is not None and (getattr(loc, "user_location_name", None)
                                or getattr(loc, "device_location_name", None)):
            s += 1.0
    except Exception:
        pass
    return s


def _rdd_candidate_pairs(db: Session, crisis_event_id: Optional[str] = None,
                         building_id: Optional[str] = None,
                         max_buildings: int = 3000, max_per_building: int = 60):
    """Yield (report_a, report_b, level) for every UNCONFIRMED, not-NOT_DUP probable-
    duplicate pair within multi-report buildings (the only place a pair can exist).
    Bounded for the 500k scale target: only buildings with >=2 reports are scanned,
    capped at max_buildings + max_per_building. Shared by the duplicate summary + the
    bulk merge so the two surfaces agree on what's mergeable. Pass building_id to scope
    to a single building (the Building Details 'Potential Duplicates' surface)."""
    scope = [Report.crisis_event_id == crisis_event_id] if crisis_event_id else []
    if building_id:
        # Single-building scope: skip the multi-building scan entirely.
        building_ids = [building_id]
    else:
        brows = (db.query(Report.building_id)
                 .filter(Report.building_id.isnot(None), Report.deletion_requested_at.is_(None), *scope)
                 .group_by(Report.building_id)
                 .having(sa_func.count(Report.id) >= 2)
                 .limit(max_buildings).all())
        building_ids = [r[0] for r in brows]
    if not building_ids:
        return
    decs = (db.query(ReportDuplicateDecision)
            .filter(ReportDuplicateDecision.undone_at.is_(None),
                    ReportDuplicateDecision.decision.in_(("CONFIRMED_DUP", "NOT_DUP"))).all())
    settled = set()
    already_collapsed = set()
    for d in decs:
        if d.related_report_id:
            settled.add(frozenset((d.primary_report_id, d.related_report_id)))
        if d.decision == "CONFIRMED_DUP" and d.related_report_id:
            already_collapsed.add(d.related_report_id)   # already merged under a primary
    for bid in building_ids:
        q = (db.query(Report).options(joinedload(Report.media))
             .filter(Report.building_id == bid, Report.deletion_requested_at.is_(None)))
        if already_collapsed:
            # A report already collapsed under a primary is hidden from the feed -
            # NEVER re-offer it as a "potential duplicate" (this is what made the
            # summary count phantom pairs the operator could never actually merge,
            # so "Merge all" appeared to do nothing). Its primary (not collapsed) is
            # kept, so brand-new reports can still merge under the existing star.
            q = q.filter(Report.id.notin_(already_collapsed))
        reps = q.order_by(Report.server_created_at.asc()).limit(max_per_building).all()
        for i in range(len(reps)):
            for j in range(i + 1, len(reps)):
                if frozenset((reps[i].id, reps[j].id)) in settled:
                    continue   # already decided (confirmed or ruled-not)
                _s, level, _sim, _r = _rdd_score_pair(reps[i], reps[j])
                if level:
                    yield reps[i], reps[j], level


def _ensure_building_for_pwa_pick(
    db: Session,
    building_id: Optional[str],
    osm_name: Optional[str] = None,
) -> Optional[str]:
    """Pre-create the parent `buildings` row for a PWA-supplied
    `building_id` so the FK on the subsequent reports INSERT is
    satisfied.

    Background: `_apply_building_link` (after_insert hook) is responsible
    for maintaining the buildings cache, but it fires AFTER the report
    INSERT - too late for the FK check. The `_auto_assign_building_id`
    path below handles the proximity-cluster case, but early-returns
    when the PWA has already supplied a `building_id`. The result on a
    fresh DB: a PWA tap on an OSM footprint that hasn't been mirrored
    into `buildings` yet 500s the entire submission with
    `psycopg2.errors.ForeignKeyViolation` on `fk_reports_building_id` -
    UNDP must-have #6 regression.

    Returns the same `building_id` on success. On a DB error, returns
    None so the caller can fall through to `building_id=NULL +
    infrastructure_name_from_osm=False` (the "needs mapping" bucket
    per the project invariants UNDP must-have #6) rather than 500ing the submission.
    """
    if not building_id:
        return building_id
    try:
        from app.models.report import _ensure_building_exists
        _ensure_building_exists(db, building_id, osm_name=osm_name)
        db.flush()
        return building_id
    except Exception as e:
        logger.warning(
            "Failed to pre-create buildings row for "
            f"building_id={building_id!r}: {type(e).__name__}: {e}. "
            "Report will land with building_id=NULL "
            "(dashboard 'needs mapping' bucket)."
        )
        try:
            db.rollback()
        except Exception:
            pass
        return None


def _auto_assign_building_id(report: Report, db: Session):
    """Auto-link reports within 30m of each other to the same building_id.

    Phase H.1 (May 2026) added `fk_reports_building_id` from
    `reports.building_id` → `buildings.id`. The `_apply_building_link`
    `after_insert` hook in app/models/report.py inserts the parent
    `buildings` row, but that hook fires AFTER the report INSERT - the
    FK is checked during the INSERT itself, so it fails when a freshly
    generated building_id has no matching parent row.

    Fix: when this function generates a NEW building_id (the proximity-
    cluster path), pre-insert the minimal `buildings` row so the FK
    is satisfied at insert time. Idempotent via ON CONFLICT.
    """
    if not report.location or report.building_id:
        return
    lat, lng = report.location.latitude, report.location.longitude
    if lat == 0 and lng == 0:
        return
    from math import radians, cos, sin, sqrt, atan2
    def haversine(lat1, lon1, lat2, lon2):
        R = 6371000
        dlat = radians(lat2 - lat1)
        dlon = radians(lon2 - lon1)
        a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
        return R * 2 * atan2(sqrt(a), sqrt(1-a))

    nearby = db.query(Report).join(Location).filter(
        Report.id != report.id,
        Report.deletion_requested_at.is_(None),
        Location.latitude.between(lat - 0.0003, lat + 0.0003),
        Location.longitude.between(lng - 0.0003, lng + 0.0003),
    ).all()

    for n in nearby:
        if n.location and haversine(lat, lng, n.location.latitude, n.location.longitude) <= 30:
            if n.building_id:
                # Nearby already has a building_id; reuse it. The parent
                # `buildings` row was already created when the nearby
                # report was inserted.
                report.building_id = n.building_id
                return
            else:
                import uuid
                from sqlalchemy import text as _text
                bid = str(uuid.uuid4())
                # Pre-create the parent `buildings` row so the FK on the
                # subsequent reports INSERT is satisfied. Use raw SQL
                # bound through the session's connection so we play
                # nicely with autoflush + the existing transaction.
                db.execute(_text("""
                    INSERT INTO buildings (id, id_source, state)
                    VALUES (:bid, 'PROXIMITY', 'ACTIVE')
                    ON CONFLICT (id) DO NOTHING
                """), {"bid": bid})
                db.flush()
                report.building_id = bid
                n.building_id = bid
                return


# ══════════════════════════════════════════════════════════════════════
# Building-centric Incident-Feed redesign Phase 2B - intake incident assignment
# ══════════════════════════════════════════════════════════════════════
# An Incident is the first-class operational EVENT (Building → Incident → Report).
# This runs in the SHARED create path (create_report_meta, right after building
# assignment; also the legacy one-shot POST /), so every report - from ALL six
# channels - lands on an incident (must-have #1 parity). A report JOINS the best
# same-building incident ONLY on HIGH duplicate confidence (>=88, reusing the
# documented _rdd_score_pair against that incident's member reports); otherwise it
# SEEDS its own incident. Conservative BY DESIGN: MEDIUM/LOW matches are never
# auto-joined (so distinct same-building events - Floor 1/7/10 - stay separate
# incidents); they surface as analyst "possible same incident?" suggestions via
# the existing duplicate engine + the merge ops. Defensive: wrapped in a SAVEPOINT
# so a failure can NEVER corrupt or block the report write (must-have #1/#3).
_INCIDENT_HIGH = 88            # mirrors _rdd_score_pair's HIGH threshold
_INCIDENT_MAX_CANDIDATES = 80  # bound the intake scoring scan at 500k scale (#12)
_SEVERITY_RANK = {"UNKNOWN": 0, "MINOR": 1, "MODERATE": 2, "SEVERE": 3, "CRITICAL": 4}


def _severity_rank(sev) -> int:
    return _SEVERITY_RANK.get((sev or "UNKNOWN"), 0)


def _incident_title(report: "Report") -> str:
    """Human label for a freshly-seeded incident: crisis type + place/building."""
    ct = (report.crisis_type or "Incident").replace("_", " ").title()
    place = None
    loc = getattr(report, "location", None)
    if loc:
        place = getattr(loc, "user_location_name", None) or getattr(loc, "device_location_name", None)
    tail = getattr(report, "infrastructure_name", None) or place
    return (f"{ct} - {tail}" if tail else ct)[:200]


def _new_incident_from_report(report: "Report", db: Session, actor_user_id: Optional[str] = None) -> "Incident":
    """Seed + flush a fresh single-member incident from `report` (the lead).
    Shared by intake (_assign_incident) and the analyst split op."""
    inc = Incident(
        building_id=report.building_id,
        crisis_event_id=report.crisis_event_id,
        incident_type=report.crisis_type,
        severity=(report.severity or SeverityEnum.UNKNOWN.value),
        status=IncidentStatusEnum.OPEN.value,
        title=_incident_title(report),
        lead_report_id=report.id,
        report_count=1,
        created_by=actor_user_id,
    )
    db.add(inc)
    db.flush()
    return inc


def _recompute_incident_rollup(incident: "Incident", db: Session) -> None:
    """Rebuild an incident's cached roll-ups from its live member reports.
    severity = max member severity UNLESS analyst-overridden; lead = earliest
    (richest on tie via _rdd_info_score); report_count = live member count;
    incident_type backfilled from the first typed member if still blank."""
    members = db.query(Report).filter(
        Report.incident_id == incident.id,
        Report.deletion_requested_at.is_(None),
    ).all()
    incident.report_count = len(members)
    if not members:
        return
    if not incident.severity_overridden:
        incident.severity = max((m.severity or "UNKNOWN" for m in members), key=_severity_rank)
    lead = min(members, key=lambda m: (m.server_created_at, -_rdd_info_score(m)))
    incident.lead_report_id = lead.id
    if not incident.incident_type:
        incident.incident_type = next((m.crisis_type for m in members if m.crisis_type), None)


def _assign_incident(report: "Report", db: Session, actor_user_id: Optional[str] = None) -> None:
    """Assign `report` to an incident at intake: JOIN the best same-building
    incident on HIGH confidence (>=88), else SEED a new incident. Idempotent
    (no-op if already assigned). Never raises into the caller's transaction."""
    if getattr(report, "incident_id", None):
        return
    try:
        with db.begin_nested():   # SAVEPOINT - isolates any failure from the report write
            bid = report.building_id
            best_inc_id, best_score = None, 0
            if bid:
                members = (
                    db.query(Report)
                    .options(joinedload(Report.media))
                    .filter(
                        Report.building_id == bid,
                        Report.incident_id.isnot(None),
                        Report.id != report.id,
                        Report.deletion_requested_at.is_(None),
                    )
                    .order_by(Report.server_created_at.desc())
                    .limit(_INCIDENT_MAX_CANDIDATES)
                    .all()
                )
                groups: dict = {}
                for m in members:
                    groups.setdefault(m.incident_id, []).append(m)
                for inc_id, group in groups.items():
                    s = max(_rdd_score_pair(report, m)[0] for m in group)
                    if s > best_score:
                        best_score, best_inc_id = s, inc_id

            if best_inc_id and best_score >= _INCIDENT_HIGH:
                report.incident_id = best_inc_id
                # Flush the new membership so the roll-up COUNT sees it even when
                # the session runs autoflush=False (e.g. the test session).
                db.flush()
                inc = db.get(Incident, best_inc_id)
                if inc is not None:
                    _recompute_incident_rollup(inc, db)
            else:
                inc = _new_incident_from_report(report, db, actor_user_id)
                report.incident_id = inc.id
    except Exception:
        # Best-effort: leave the report unassigned (backfill/re-eval can fix it
        # later) rather than fail a legitimate submission. Reset the in-memory
        # link in case it was set before the savepoint rolled back, so the outer
        # commit can't write an FK to a now-nonexistent incident.
        logger.exception("incident assignment failed for report %s (non-fatal)", getattr(report, "id", "?"))
        try:
            report.incident_id = None
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════
# Phase F.2.b (May 2026) - Per-report admin-action ribbon
# ══════════════════════════════════════════════════════════════════════
@router.get("/{report_id}/audit")
def get_report_audit_trail(
    report_id: str,
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
    user=Depends(require_analyst),
):
    """Return the last N AuthAuditLog entries for this report.

    Filtered to the bounded REPORT_* action vocabulary written by
    `_audit_report_action`. Newest-first; capped at `limit` (default 8
    so the dashboard ribbon stays compact).

    The response shape is intentionally thin - id / action / user
    email / timestamp / details. The dashboard joins user_id back
    against the report's reviewer profile when needed.
    """
    from app.models.auth import AuthAuditLog

    REPORT_ACTIONS = (
        "REPORT_DISPATCH",
        "REPORT_RESOLVE",
        "REPORT_FALSE_ALARM",
        "REPORT_ACCEPT",
        "REPORT_REJECT",
        "REPORT_DELETE",
        "REPORT_VERIFY",
    )
    rows = (
        db.query(AuthAuditLog)
        .filter(
            AuthAuditLog.resource_type == "report",
            AuthAuditLog.resource_id == report_id,
            AuthAuditLog.action.in_(REPORT_ACTIONS),
        )
        .order_by(AuthAuditLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "items": [
            {
                "id": r.id,
                "action": r.action,
                "user_id": r.user_id,
                "user_email": r.user_email,
                "details": r.details or {},
                "created_at": _utc_iso(r.created_at),
            }
            for r in rows
        ],
        "total": len(rows),
    }


# ══════════════════════════════════════════════════════════════════════
# Phase G.5 (May 2026) - Bulk multi-select operations
# ══════════════════════════════════════════════════════════════════════
# The single-report verify endpoint above is heavy (10-25 s per call:
# satellite fetch + Claude vision). Operators reviewing 10+ pending
# reports at once want to fire all the verifications + watch progress
# without spawning 10 parallel browser fetches that would either
# saturate Anthropic's rate limit or hang on a slow Sentinel response.
#
# This endpoint fans out the existing `verify_report` handler with a
# small concurrency cap and streams progress events back to the
# dashboard as Server-Sent Events. Idempotent per report-id -
# `verify_report` already handles re-runs gracefully (overwrites the
# previous SatelliteVerification row).
#
# Auth: require_analyst (same gate as the single-report verifier).
# Concurrency cap: 3 in-flight. Larger fan-out is bandwidth-limited
# by Anthropic and provides no operator-perceived benefit.

from pydantic import BaseModel as _BatchBaseModel  # noqa: E402


class BatchVerifyRequest(_BatchBaseModel):
    report_ids: List[str]


@router.post("/batch-verify")
async def batch_verify(
    body: BatchVerifyRequest,
    user=Depends(require_analyst),
    db: Session = Depends(get_db),
):
    """Fan out verify_report over up to 100 report ids, streaming
    progress as Server-Sent Events.

    Wire format (one event per line, SSE-standard):
      event: progress
      data: {"done": 3, "total": 10, "report_id": "...", "status": "ok"}

      event: done
      data: {"summary": {...}, "failures": [...]}

    The dashboard subscribes via EventSource (read-only); progress
    events drive a toast / progress bar; on done the operator gets a
    summary tally.
    """
    ids = [str(i) for i in (body.report_ids or []) if isinstance(i, str)]
    # Hard cap - bigger batches should run in a background worker
    # queue (out of scope this phase, see roadmap F.10).
    if len(ids) > 100:
        raise HTTPException(
            status_code=400,
            detail=f"Batch too large: {len(ids)} > 100. Split into smaller batches.",
        )
    if not ids:
        raise HTTPException(status_code=400, detail="report_ids cannot be empty")

    # De-dupe + preserve order.
    seen = set()
    deduped: List[str] = []
    for rid in ids:
        if rid not in seen:
            seen.add(rid)
            deduped.append(rid)

    sem = asyncio.Semaphore(3)

    async def _run_one(rid: str) -> dict:
        async with sem:
            try:
                # Each verify_report call manages its own db session
                # internally via Depends - we replicate that here by
                # calling it with a fresh Session per task so the
                # nested transactions don't fight each other.
                from app.db.session import SessionLocal
                inner_db = SessionLocal()
                try:
                    # Synchronous shim - verify_report is async + takes a
                    # Depends-injected db; call its core path directly.
                    await verify_report(report_id=rid, db=inner_db)
                    return {"report_id": rid, "status": "ok"}
                finally:
                    inner_db.close()
            except HTTPException as e:
                return {"report_id": rid, "status": "error",
                        "code": e.status_code, "detail": str(e.detail)[:200]}
            except Exception as e:
                return {"report_id": rid, "status": "error",
                        "code": 500, "detail": f"{type(e).__name__}: {str(e)[:160]}"}

    async def event_stream():
        # Send an opening comment so EventSource's onopen fires
        # promptly even if Sentinel takes a few seconds for the
        # first call.
        yield ": batch-verify stream opening\n\n"
        yield f"event: start\ndata: {json.dumps({'total': len(deduped)})}\n\n"
        done = 0
        failures: List[dict] = []
        tasks = [asyncio.create_task(_run_one(rid)) for rid in deduped]
        for fut in asyncio.as_completed(tasks):
            res = await fut
            done += 1
            payload = {
                "done": done,
                "total": len(deduped),
                "report_id": res.get("report_id"),
                "status": res.get("status"),
            }
            if res.get("status") != "ok":
                payload["code"] = res.get("code")
                payload["detail"] = res.get("detail")
                failures.append(res)
            yield f"event: progress\ndata: {json.dumps(payload)}\n\n"
        # Final tally.
        summary = {
            "total": len(deduped),
            "succeeded": done - len(failures),
            "failed": len(failures),
        }
        yield f"event: done\ndata: {json.dumps({'summary': summary, 'failures': failures})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx response buffering
            "Connection": "keep-alive",
        },
    )
