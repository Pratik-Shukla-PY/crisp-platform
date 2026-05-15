import base64
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
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import or_, and_, func as sa_func

from app.db.session import get_db
from app.models.report import (
    Device, Report, Location, Media, MediaChunk, AIAnalysis,
    SatelliteVerification, DeletionAuditLog,
    MediaTypeEnum, ResolutionEnum, ReportStatusEnum, SyncStatusEnum,
    SeverityEnum, InfraTypeEnum,
)
from app.schemas.report import (
    ReportCreate, ReportResponse, ReportMetaCreate, MediaAttach,
    ReportDescriptionUpdate, ThumbnailPayload, MediaChunkPayload,
    VerificationResponse,
    ReportNearbyResponse, ReportNearbyGroup,
)
from app.services.nearby_aggregator import (
    aggregate_nearby, bbox_for_radius, haversine_km,
    NearbyReportInput,
)
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
# rows keep working — the abstraction handles the actual file IO so
# call-sites don't have to know which backend is active.
from app.services.storage import get_storage as _get_media_storage  # noqa: E402

def _normalize_crisis_type(value):
    """Normalise crisis-type wire values to UNDP-canonical enums.

    UNDP Problem Statement (page 8) lists 'Hurricane/Cyclone' as a single
    natural-hazard category. The codebase historically accepted both
    `HURRICANE` (legacy clients) and `CYCLONE` (UNDP-aligned), which let
    the same physical event populate two different enum buckets in the
    DB and confused dashboard filtering / counts. We pick `CYCLONE` as
    the canonical name (matches the UNDP-aligned grouping in the backend
    enum file) and rewrite `HURRICANE` to `CYCLONE` at every write site.

    Idempotent — passing through `CYCLONE`, `EARTHQUAKE`, etc. returns
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
# "webm"` — every audio data: URL got renamed to `.webm` regardless of
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
    up to the comma. `raw_bytes` is the decoded payload — magic bytes
    win because the data: URL header sometimes lies (e.g. when a PWA
    uses MediaRecorder.mimeType="audio/webm" but the underlying iOS
    decoder hands back MP4 anyway).

    Returns ("m4a", "audio/mp4") for unknown/empty input — that's the
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
        # Apple Core Audio — the assembly pipeline transcodes these
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

    # Truly unknown — fall back to m4a/aac which is the most-portable
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
# transcription) is filesystem-based — cv2.imread, PIL.Image.open,
# faster-whisper all expect a path on disk. To keep the persistent
# UPLOAD_DIR empty under MEDIA_BACKEND=s3, we stage the bytes in a
# tempfile under /tmp/ for the lifetime of the worker call, then
# delete it. /tmp is independent of UPLOAD_DIR (the persistent media
# volume) and doesn't accumulate across uploads — even at UNDP scale
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

# P2.2 — bounded thread pool for background assembly.
#
# Previously every final-chunk arrival called `threading.Thread(...).start()`
# directly. Under 100 concurrent uploads this would spawn 100 OS threads, all
# blocking on the GIL during PII blur (MediaPipe + easyocr on CPU) and
# Whisper transcription. Effective parallelism was ~1, memory use 100× worse.
#
# 4 workers is chosen to match typical cloud instance core counts and because
# the bottleneck is Python's GIL + disk I/O + ffmpeg/Torch workloads that
# release the GIL — so more threads past cores adds overhead without speedup.
# Override via CRISP_ASSEMBLY_WORKERS env var for bigger boxes.
_ASSEMBLY_WORKERS = max(1, int(os.getenv("CRISP_ASSEMBLY_WORKERS", "4")))
_assembly_executor = ThreadPoolExecutor(
    max_workers=_ASSEMBLY_WORKERS,
    thread_name_prefix="assembly",
)

# P2.3 — separate pool for the slow AI tasks (PII blur with MediaPipe +
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
    ``djb2_checksum`` — the only difference is the input alphabet
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

    April 2026 — dual-transport assembly. A chunk row stores its payload
    in ONE of two columns:

      * ``data_binary`` (LargeBinary) — new `/media/chunk-bin` endpoint.
      * ``data_b64``    (Text)        — legacy `/media/chunk` endpoint.

    We read each chunk row and take whichever column is populated. The
    CHECK constraint on ``media_chunks`` guarantees exactly one is set.

    Mixed-format chunks for a single ``media_id`` are not produced by
    client logic (one upload session picks one transport), but if they
    ever appear — e.g. retry across an app update — the assembler
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
            f"data_b64 — CHECK constraint violated; aborting assembly."
        )
        return None

    file_bytes = b"".join(parts)

    # Phase C.1 (May 2026) — whole-asset integrity check. The PWA computes
    # djb2 over the FULL original bytes once before chunking and ships it
    # on chunk 0. We re-compute over the concatenated payload here and
    # compare. NULL on the Media row means the client didn't send one
    # (legacy / pre-Phase-C.1 PWA) — skip the check entirely, preserving
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
            tier_label = "LOW"
            try:
                tier_label = getattr(getattr(media_row, "resolution_tier", None), "value", "LOW") or "LOW"
            except Exception:
                pass
            logger.error(
                "[Assembly:integrity] %s tier=%s djb2 MISMATCH expected=%s got=%s — "
                "aborting assembly, marking row failed. Most likely cause: "
                "_assemble_media_file sort/decode/concat regression OR a "
                "compromised chunk row that bypassed the per-chunk djb2 check.",
                media_id, tier_label, expected_checksum, computed_checksum,
            )
            try:
                media_asset_integrity_fail_total.labels(tier=tier_label).inc()
            except Exception:
                pass
            return None

    # Detect audio format from magic bytes (first few bytes)
    if media_type == 'IMAGE':
        ext = 'jpg'
    else:
        # Audio: sniff format for correct extension
        if len(file_bytes) > 12 and file_bytes[4:8] == b'ftyp':
            ext = 'm4a'       # MPEG-4 Audio (AAC) — iOS, Android
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'OggS':
            ext = 'ogg'       # Ogg container (Opus) — WhatsApp, Telegram
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'\x1a\x45\xdf\xa3':
            ext = 'webm'      # WebM (PWA MediaRecorder)
        elif len(file_bytes) >= 4 and file_bytes[0:4] == b'caff':
            # Apple Core Audio Format — older iOS recorder configs produced
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

    # (PR 2 — UNDP scaling) — the assembly path no longer
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
    # + a /tmp/ tempfile for cv2 — no persistent local disk usage.
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
            f"(client_blur_applied={client_claim} — server runs anyway for defense-in-depth)"
        )
        # Perceptual-hash for redundancy detection. Same /tmp/ pattern
        # — worker stages from storage, computes phash, deletes tempfile.
        _ai_executor.submit(_run_photo_phash, media_id, file_url, filename)

    logger.info(f"Assembled {media_id}: {len(file_bytes):,} bytes → {filename}")
    return file_url


def _run_photo_phash(media_id: str, db_url: str, filename: str) -> None:
    """Compute + persist perceptual hash of an assembled photo.

    Fire-and-forget helper invoked from `_assemble_media_file` after the
    PII-blur submission. Opens a short-lived DB session so we don't piggy-
    back on the caller's transaction. Any failure is logged + swallowed —
    `photo_phash` stays NULL and the dashboard treats that as "not yet
    scanned" rather than "unique".

    Apr 2026 (PR 2) — reads bytes through the storage abstraction +
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


def _run_server_pii_blur(media_id: str, db_url: str, filename: str) -> None:
    """Server-side PII blur (MediaPipe faces + easyocr PII text). Runs in
    the AI thread pool so it doesn't block assembly. Never raises —
    failure is logged and the media row's ``pii_blur_status`` is updated
    accordingly so the dashboard can flag the file.

    Apr 2026 — now observability-instrumented + DB-updating:
      * bumps ``pii_blur_runs_total{outcome}`` Prometheus counter
      * writes ``pii_blur_status`` on the Media row
        (``complete`` / ``failed`` / ``skipped``).

    ``pii_blur_status='skipped'`` is the important one — it means the
    backends weren't loadable (model missing, package not installed)
    and the file is on disk UNBLURRED. Operators need to see this
    loudly, which is why the `/api/v1/health/pii` endpoint + the
    `PII-BLUR CRITICAL` log lines in `pii_blur.py` exist.
    """
    outcome = 'failed'
    db = None
    try:
        from app.services.pii_blur import blur_pii
        from app.db.session import SessionLocal

        # Stage bytes from storage into a /tmp/ tempfile for the
        # filesystem-based cv2.imread inside blur_pii. The tempfile
        # is auto-deleted when the context exits — EC2's persistent
        # disk stays empty regardless of upload volume.
        with _stage_from_storage(db_url, filename) as tmp_path:
            pii_result = blur_pii(tmp_path)
            if pii_result.get('ran'):
                outcome = 'complete'
                if pii_result.get('blurred'):
                    logger.info(
                        f"PII blurred in {filename}: "
                        f"faces={pii_result['faces']} pii_text={pii_result['pii_texts']}"
                    )
                    # Re-upload the blurred bytes back to storage. blur_pii
                    # rewrote tmp_path in place; we read the new bytes and
                    # storage.save() to overwrite the original (S3 PUT or
                    # local-disk write — backend agnostic).
                    try:
                        with open(tmp_path, "rb") as _fh:
                            blurred_bytes = _fh.read()
                        _get_media_storage().save(
                            filename, blurred_bytes, _content_type_for(filename)
                        )
                    except Exception as _re_e:
                        logger.warning(
                            f"Re-upload of blurred bytes failed for {filename}: {_re_e}. "
                            "Storage object may still hold unblurred bytes — re-run blur worker to fix."
                        )
                else:
                    logger.info(f"PII blur ran on {filename}: no PII detected")
            else:
                # backends unavailable — the storage object still holds
                # the unblurred bytes. Dashboard flags via pii_blur_status.
                outcome = 'skipped'
                logger.error(
                    f"PII-BLUR SKIPPED for {filename}: {pii_result.get('error')} — "
                    "object kept as-is, dashboard will flag via pii_blur_status='skipped'."
                )
    except Exception as e:
        outcome = 'failed'
        logger.warning(f"PII blur failed for {filename}: {e}")
    finally:
        # Update the Media row in a fresh session — this runs on the
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
        # Prometheus counter. `import inside` + try/except so a missing
        # observability module can't break the blur worker.
        try:
            from app.core.observability import pii_blur_runs_total
            pii_blur_runs_total.labels(outcome=outcome).inc()
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

    # Collect only consecutive chunks (stop at first gap — no gaps in
    # partial JPEG). April 2026: dual-transport — each chunk decodes to
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

    # Phase-2.3 safeguards — don't write an unreadable partial.
    #   (a) Validate JPEG Start-Of-Image marker. A truncated JPEG at least
    #       has to start with 0xFFD8 to even attempt to render; without
    #       this the dashboard shows a "broken image" icon which is worse
    #       UX than no placeholder at all.
    #   (b) Minimum byte threshold. At VERY_SLOW tier (1 KB chunks), a
    #       3-chunk prefix is only 3 KB — too small to contain the quant
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

    # (PR 2) — partial-image PII blur via /tmp/ tempfile so
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

    # (PR 2) — direct in-memory persist via storage abstraction.
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

    Apr 2026 (PR 2) — reads bytes via the storage abstraction + stages a
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
    """Background task wrapper — opens its own DB session so the HTTP response
    is not blocked by Whisper transcription (which can take 10–30 s)."""
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        _run_ai_pipeline(report_id, media_type, file_url, db)
    finally:
        db.close()


def _try_partial_image_bg(media_id: str):
    """Background partial-image assembly — runs PII blur (slow: easyocr + MediaPipe).
    Non-blocking so the chunk handler can return in <100ms."""
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
            # Live transcription (translates to English) — own try/except in the fn
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
         (the symptom we saw for media b36a0511 — image stuck at 50–100 %).
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
            logger.info(f"[AssemblyBG] {media_id[:8]} already complete — skip")
            return
        if media.chunk_count == 0 or media.received_chunks < media.chunk_count:
            logger.info(
                f"[AssemblyBG] {media_id[:8]} not ready: "
                f"{media.received_chunks}/{media.chunk_count}"
            )
            return

        # Optimistic lock: accept either 'pending' (we got here before the
        # handler pre-claimed — rare) OR 'assembling' (the handler pre-claimed
        # the slot for us via its own CAS in the chunk endpoint, which is the
        # common path). We must NOT bail on 'assembling' because the handler's
        # CAS IS our handoff signal — before this fix, every chunk logged
        # "acquired assembly lock" on the handler side and then "lock lost"
        # on the worker side, leaving the media in 'assembling' forever.
        # We still exclude 'complete' and 'failed' so re-submissions no-op.
        locked = db.query(Media).filter(
            Media.id == media_id,
            Media.assembly_status.in_(['pending', 'assembling'])
        ).update({'assembly_status': 'assembling'}, synchronize_session=False)
        db.commit()
        if locked == 0:
            logger.info(f"[AssemblyBG] {media_id[:8]} already terminal (complete/failed) — skip")
            return

        logger.info(
            f"[AssemblyBG] start {media_id[:8]} type={media_type} "
            f"chunks={media.received_chunks}/{media.chunk_count}"
        )

        # Guaranteed-delivery: capture tier + group NOW (before assembly) so
        # we can label metrics even on the failure branches. `tier_label` is
        # kept as the Enum value's string form for stable Prometheus label sets.
        _tier_label = getattr(getattr(media, 'resolution_tier', None), 'value', 'LOW') or 'LOW'
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

        # Mark complete + bump report sync state.
        db.refresh(media)
        media.url = file_url
        media.assembly_status = 'complete'
        media.is_synced = True
        media.completion_pct = 100.0

        report = db.query(Report).filter(Report.id == report_id).first()
        if report:
            report.received_media = (report.received_media or 0) + 1
            if report.expected_media and report.received_media >= report.expected_media:
                report.sync_status = SyncStatusEnum.SYNCED
                logger.info(f"[AssemblyBG] report {report_id[:8]} fully synced")
        db.commit()
        logger.info(f"[AssemblyBG] complete {media_id[:8]} → {file_url}")

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
                    if _tier_label == 'HIGH' and delta >= 0:
                        time_to_full_image_seconds.observe(delta)
            except Exception as e:
                # Metrics must never break the assembly pipeline.
                logger.debug(f"[AssemblyBG] variant metric skipped: {e}")

        # P2.3 — dispatch AI pipeline (Whisper / vision) to the AI pool instead
        # of running it inline. Whisper alone can take 10–30 s on CPU; keeping
        # it here would hold an assembly worker idle for that entire window.
        _ai_executor.submit(_run_ai_pipeline_bg, report_id, media_type, file_url)
    finally:
        db.close()


def _run_ai_pipeline(report_id: str, media_type: str, file_url: str, db: Session):
    """Trigger transcription or image analysis after media assembly.

    Apr 2026 (PR 2) — reads bytes via the storage abstraction + stages
    a /tmp/ tempfile for the underlying filesystem APIs (faster-whisper,
    cv2 image analyzer). No persistent local-disk usage.
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
    elif media_type == 'IMAGE':
        with _stage_from_storage(file_url, filename) as tmp_path:
            vision = ai_service.analyze_image(tmp_path)
        ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report_id).first()
        if ai:
            ai.detected_labels = vision.get("labels", [])
            ai.damage_score = vision.get("risk_score", 0.0)
        else:
            db.add(AIAnalysis(
                report_id=report_id,
                detected_labels=vision.get("labels", []),
                damage_score=vision.get("risk_score", 0.0)
            ))
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


@router.patch("/{report_id}/false-alarm", response_model=ReportResponse)
def mark_false_alarm(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as a FALSE_ALARM without deleting it."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.FALSE_ALARM
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


@router.patch("/{report_id}/dispatch", response_model=ReportResponse)
def dispatch_team(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as RESPONDING — rescue team has been dispatched.

    April 2026: the first time a report leaves PENDING for a verified
    status (RESPONDING / RESOLVED) we bump the reporter's
    ``verified_count`` so quality-based credibility (see §3.8 of
    docs/INCENTIVES.md) reflects the accepted report.

    The endpoint-level ``was_pending`` guard catches the common case
    (status transition from PENDING). For the parallel-request race
    (two analysts both dispatch + resolve at the same instant), the
    real idempotency gate is inside
    ``_mark_report_verified_for_credibility`` — it uses
    ``SELECT … FOR UPDATE`` + a ``first_verified_at`` timestamp check
    to serialize. See May 2026 audit C-2 fix."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    was_pending = report.status == ReportStatusEnum.PENDING
    report.status = ReportStatusEnum.RESPONDING
    if was_pending:
        _mark_report_verified_for_credibility(report, db)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


@router.patch("/{report_id}/resolve", response_model=ReportResponse)
def resolve_report(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as RESOLVED — situation handled."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    was_pending = report.status == ReportStatusEnum.PENDING
    report.status = ReportStatusEnum.RESOLVED
    if was_pending:
        _mark_report_verified_for_credibility(report, db)
    db.commit()
    db.refresh(report)
    _push_status_change_safely(report)
    return report


# ── Phase 5 — reviewer workflow ─────────────────────────────────

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


def _attach_reporter_tier(db: Session, reports: list) -> None:
    """Phase 1.6 (May 2026) — Dashboard V4 field parity helper.

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
        # — operators see "no tier badge" until the next dispatch
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
                # name when serialising ReportResponse — no schema-
                # side validator needed.
                r.reporter_tier = tier  # type: ignore[attr-defined]
    except Exception:
        logger.exception("Failed to attach reporter_tier to reports list")
        # Best-effort — leave unset. The dashboard already handles NULL.
        return


@router.get("/device/{device_hash}", response_model=List[ReportResponse])
def get_device_reports(device_hash: str, db: Session = Depends(get_db)):
    """List all reports submitted by a specific device (for privacy/deletion UI).
    Accepts the client-side device_hash (e.g. DEV-XXXXXXXX) and resolves it."""
    device_id = _resolve_device_id(device_hash, db)
    if not device_id:
        return []
    return db.query(Report).filter(Report.device_id == device_id).order_by(Report.server_created_at.desc()).all()


@router.delete("/device/{device_hash}", status_code=status.HTTP_200_OK)
def delete_device_data(device_hash: str, db: Session = Depends(get_db)):
    """Delete ALL reports and media files submitted by a specific device.
    Used by the mobile app's 'Delete My Data' privacy feature."""
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
        return dt.isoformat() if dt else None

    def _rt(r):
        """Computed response_time_seconds — same formula as ReportResponse."""
        end = r.help_arrived_at or r.help_dispatched_at
        if not (r.reviewed_at and end):
            return None
        from datetime import timezone as _tz
        a = r.reviewed_at if r.reviewed_at.tzinfo else r.reviewed_at.replace(tzinfo=_tz.utc)
        b = end if end.tzinfo else end.replace(tzinfo=_tz.utc)
        delta = int((b - a).total_seconds())
        return delta if delta >= 0 else None

    def _thumb_url(r):
        """Pick the SMALL photo variant if available — cheap to download,
        always sized for a card thumbnail. Falls back to MEDIUM → any
        complete IMAGE → first IMAGE's thumbnail_url. Returns None when
        the report has no photos yet.

        May 2026 (Phase 16, Delta-thumb-S1) — bug fix: this helper used to
        return ``m.url`` raw, which on PROD (``MEDIA_BACKEND=s3``) is an
        ``s3://crisp-uploads/...`` URI. ``MediaResponse``'s
        ``field_serializer`` rewrites those to ``/api/v1/reports/media/<id>/<file|thumb>``
        on JSON encode, but this aggregator returns a plain dict so the
        serializer never fires. Result: every PROD client received
        ``s3://...`` and concatenated it onto the host, producing a 404 and
        the onerror placeholder for every card thumbnail. The
        ``_stable_url`` helper mirrors the serializer's logic so the
        rewrite happens here too — guaranteeing stable thumbnails across
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
        for tier_preference in ('LOW', 'MEDIUM', 'HIGH'):
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

    May 2026 — also recomputes the reporter's tier so a transition
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
    # never break the analyst's PATCH — wrap defensively.
    try:
        _mark_report_lives_impacted_for_tier(report, db)
        db.commit()
    except Exception as e:  # pragma: no cover — observability only
        logger.warning(f"[Tier] recompute on /impact failed for report {report_id[:8]}: {e}")
    return {"id": report_id, "lives_impacted": report.lives_impacted}


@router.delete("/{report_id}", status_code=status.HTTP_200_OK)
def delete_report(report_id: str, user=Depends(require_admin), grace_minutes: int = 1440,
                  deletion_source: str = "DASHBOARD", db: Session = Depends(get_db)):
    """Soft-delete with audit logging. grace_minutes: 1440 (24h) for dashboard, 30 for mobile."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

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
    )
    db.add(audit)

    report.deletion_requested_at = datetime.now(timezone.utc)
    report.deletion_grace_minutes = grace_minutes
    db.commit()
    grace_label = f"{grace_minutes} minutes" if grace_minutes < 120 else f"{grace_minutes // 60} hours"
    logger.info(f"Soft-delete: report {report_id} ({deletion_source}) — permanent in {grace_label}")
    return {"id": report_id, "deletion_requested_at": report.deletion_requested_at.isoformat(),
            "message": f"Your data will be permanently deleted within {grace_label}."}


@router.post("/{report_id}/undo-delete", response_model=ReportResponse)
def undo_delete(report_id: str, db: Session = Depends(get_db)):
    """Undo a pending deletion within the 24-hour grace window."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if not report.deletion_requested_at:
        raise HTTPException(status_code=400, detail="Report is not pending deletion")
    # Check if 24h has passed
    elapsed = (datetime.now(timezone.utc) - report.deletion_requested_at.replace(tzinfo=timezone.utc)).total_seconds()
    if elapsed > 86400:
        raise HTTPException(status_code=410, detail="Grace period expired — data already scheduled for permanent deletion")
    report.deletion_requested_at = None
    db.commit()
    db.refresh(report)
    logger.info(f"Undo delete for report {report_id} — restored to active")
    return report


def _purge_expired_deletions(db: Session):
    """Permanently delete reports whose grace period has expired.
    Uses per-report grace_minutes (default 24h, mobile=30min).

    Apr 2026 PR 2 — ALSO decrements the corresponding `ReporterProfile`
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
        # coalesce — 0 is a legitimate value meaning "no grace".
        grace = r.deletion_grace_minutes if r.deletion_grace_minutes is not None else 1440
        # Coerce to UTC safely regardless of whether the column returned
        # a naive datetime (SQLite behaviour — DateTime(timezone=True) is
        # advisory there, values come back without tzinfo) or a real
        # tz-aware datetime (Postgres). `.replace(tzinfo=utc)` on an
        # already-aware datetime OVERWRITES the offset without shifting
        # the wall-clock — which silently shifted the cutoff 5.5h into
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

        # Accumulate counter decrements — look up the device hash before
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


@router.post("/purge-expired", status_code=status.HTTP_200_OK)
def purge_expired_deletions(request: Request, db: Session = Depends(get_db)):
    """Admin endpoint: permanently delete all reports past the 24-hour grace period."""
    from app.main import verify_admin_key
    verify_admin_key(request)
    count = _purge_expired_deletions(db)
    return {"purged": count}


@router.post("/purge-all-pending", status_code=status.HTTP_200_OK)
def purge_all_pending_deletions(request: Request, db: Session = Depends(get_db)):
    """Admin endpoint: permanently delete ALL reports with deletion_requested_at set,
    regardless of whether the 24-hour grace period has passed."""
    from app.main import verify_admin_key
    verify_admin_key(request)
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


# ── Progressive Upload: Stage 1 — metadata only (tiny, instant) ───────────────
def _optional_user_from_auth(request: Request, db: Session):
    """Phase 1 (Apr 2026 — Optional reporter login) — extract the
    authenticated user from a Bearer token IF one is present, return
    None otherwise. Never raises: an expired / invalid token silently
    falls back to anonymous submission (crisis-reporting posture — we
    ALWAYS accept the report, even if we can't attribute it).
    """
    try:
        auth = request.headers.get("authorization") or request.headers.get("Authorization")
        if not auth or not auth.lower().startswith("bearer "):
            return None
        token = auth.split(None, 1)[1].strip()
        if not token:
            return None
        from app.core.security import decode_token
        payload = decode_token(token)
        if not payload:
            return None
        user_id = payload.get("sub") or payload.get("user_id")
        if not user_id:
            return None
        from app.models.auth import User as _User
        user = db.query(_User).filter(_User.id == user_id).first()
        if not user or not user.is_active:
            return None
        return user
    except Exception:
        # Any decoding / query failure → treat as anonymous. Never a 401.
        return None


@router.post("/meta", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report_meta(meta_in: ReportMetaCreate, request: Request, db: Session = Depends(get_db)):
    """
    Stage 1 of progressive upload: Accept metadata only (< 1KB).
    Creates a PARTIAL report immediately. Media follows via PATCH.

    Phase 1 (Apr 2026 — Optional reporter login): if the caller sends
    an `Authorization: Bearer <token>` header AND the token is valid,
    the created row is decorated with `user_id`. Invalid/expired tokens
    are silently ignored — the report still lands as anonymous.
    """
    auth_user = _optional_user_from_auth(request, db)
    # Rate limit: 30 reports/min per device
    from app.main import check_rate_limit
    if not check_rate_limit(f"meta:{meta_in.device_hash}", 30, 60):
        raise HTTPException(status_code=429, detail="Rate limit exceeded — try again later")

    # Idempotency + collision detection (P1.6).
    # Same-device retry must return the existing Report (idempotent). A
    # different-device collision — astronomically rare with UUID-v4 but
    # possible with short device-side IDs — is a potential data-loss path:
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
                    "message": "client_report_id already used by a different device — regenerate and retry",
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
    report_dict = meta_in.model_dump(exclude={"location", "device_hash"})
    # Phase 1: attach user_id if the
    # client presented a valid Bearer token. Anonymous path leaves it NULL.
    extra_cols = {}
    if auth_user is not None:
        extra_cols["user_id"] = auth_user.id
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
        # Server-side geocoding for offline place names
        if loc_data.get('user_location_name') and loc_data.get('latitude', 0) == 0 and loc_data.get('longitude', 0) == 0:
            try:
                geo_url = f"https://nominatim.openstreetmap.org/search?q={loc_data['user_location_name']}&format=json&limit=1"
                resp = httpx.get(geo_url, headers={"User-Agent": "CRISP-Platform/1.0"}, timeout=10)
                geo_data = resp.json()
                if geo_data and len(geo_data) > 0:
                    loc_data['latitude'] = float(geo_data[0]['lat'])
                    loc_data['longitude'] = float(geo_data[0]['lon'])
                    loc_data['is_user_corrected'] = True
                    logger.info(f"Geocoded '{loc_data['user_location_name']}' -> {loc_data['latitude']}, {loc_data['longitude']}")
            except Exception as e:
                logger.warning(f"Server-side geocoding failed: {e}")
        db_loc = Location(**loc_data, report_id=db_report.id)
        db.add(db_loc)
        db.commit()

    # Auto-assign building_id for deduplication/versioning
    _auto_assign_building_id(db_report, db)
    # Update reporter gamification profile
    _update_reporter_profile(meta_in.device_hash, db)

    db.commit()
    logger.info(f"Report meta created: {db_report.id} (expecting {meta_in.expected_media} media)")
    db.refresh(db_report)
    return db_report


@router.patch("/{report_id}/description", response_model=ReportResponse)
def update_report_description(report_id: str, desc_in: ReportDescriptionUpdate, db: Session = Depends(get_db)):
    """
    Stage 2 of progressive upload: Update the text description/transcript.
    This is split from Stage 1 (meta) to keep the initial packet under 1KB.
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    report.description = desc_in.description
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report.id} description updated ({len(desc_in.description)} chars)")
    return report


@router.patch("/{report_id}/classify", response_model=ReportResponse)
def update_report_classification(report_id: str, request: dict, db: Session = Depends(get_db)):
    """Update severity and/or infrastructure_type on an existing report.
    Used by Telegram/WhatsApp bots to update classification after initial creation."""
    from app.models.report import SeverityEnum, InfraTypeEnum
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
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

    Called by the PWA / RN app when GPS lock fails — the user gets a
    "describe your location" text box as the graceful fallback, and
    this endpoint pipes the result through the same multi-layer
    geocoder (Claude Haiku → Mapbox → Nominatim) the IVR + SMS channels
    already use. Adds w3w if the caller supplies ``include_w3w=true``
    and ``W3W_API_KEY`` is configured.

    Body:
        {
            "text":          "near the big mosque in Koramangala 5th block",
            "country_hint":  "India"  (optional, helps scope fuzzy matches),
            "language":      "ar"     (optional, ISO 639-1 — UNDP §3.1f.5),
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
    # AND the operator supplied W3W_API_KEY — otherwise the field is null
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


@router.patch("/{report_id}/location", response_model=ReportResponse)
def update_report_location(report_id: str, loc_data: dict, db: Session = Depends(get_db)):
    """Add or update location on an existing report.

    Used by the AI extractor to backfill coords from IVR/SMS traffic (no
    ``is_user_corrected`` flag → stays False, matching bot-authored data),
    AND by the dashboard's "pin correction" UI to let an analyst move the
    marker. Dashboard callers pass ``is_user_corrected: true`` so the row
    is clearly attributable to a human vs a geocoder.
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
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
        verified_count = sum(1 for r in all_reps if r.status in (ReportStatusEnum.VERIFIED, ReportStatusEnum.RESPONDING, ReportStatusEnum.RESOLVED))
    false_rate = round((false_count / max(total, 1)) * 100, 1)
    base = {"HERO": 95, "GUARDIAN": 85, "HELPER": 70, "NEWCOMER": 50}.get(profile.badge_level, 50)
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

    Phase 3.3 (May 2026) — Idempotent by report id. The endpoint
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
    this flag. Cost is bounded by analyst headcount — only
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
        # `updated_at`. Idempotent — never overwrites the original.
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

    # ── System prompt (CACHED — 90% token savings) ──
    system_prompt = """You are the Chief Intelligence Analyst for CRISP, a UN crisis response platform deployed in active disaster zones. Your assessment determines whether rescue teams are dispatched to save lives. You receive a full intelligence dossier per incident.

DECISION FRAMEWORK:
1. LIVES AT STAKE — a false negative (dismissing real crisis) kills people. A false positive wastes resources. ALWAYS err toward saving lives.
2. MULTI-SIGNAL FUSION — weight evidence by quality, not just presence. A HERO reporter with photo + verified satellite > 5 anonymous text-only reports.
3. CORROBORATION IS KING — multiple independent sources reporting the same event from different channels (IVR + Telegram + App) is the strongest possible signal.
4. TEMPORAL URGENCY — reports waiting >2 hours need expedited review. Night reports deserve benefit of doubt.
5. INFRASTRUCTURE CRITICALITY — hospital/water/power damage has cascading community-wide effects. Weight higher.
6. HISTORICAL PATTERNS — recurring reports from the same area may indicate chronic vulnerability OR persistent real damage.

REPORTER CREDIBILITY WEIGHTS:
- HERO (25+ verified reports, <5% false alarm): weight testimony at 95%
- GUARDIAN (10+ reports): 85%
- HELPER (3+ reports): 70%
- NEWCOMER (<3 reports): 50% — rely more on other signals
- IVR/SMS (traceable phone): +10% trust bonus regardless of badge

SOURCE RULES:
- IVR/SMS: CANNOT send photos. NEVER penalize for missing visual evidence.
- App/Telegram/WhatsApp: CAN send photos. Missing photo on SEVERE claim = mild flag (not automatic rejection).

SCORE COMPUTATION — You MUST compute and return a breakdown:
1. text_voice_score (0-100): Specificity, local knowledge, genuine detail, distress indicators
2. visual_evidence_score (0-100): Photo quality/relevance, or 50 baseline for IVR/SMS (cannot penalize)
3. satellite_score (0-100): Truth verification score, or 50 baseline if not yet verified
4. corroboration_score (0-100): Nearby reports quality, source diversity, temporal clustering
5. credibility_bonus (-10 to +10): Reporter badge adjustment
6. criticality_bonus (0-5): Infrastructure criticality adjustment
7. penalties (-20 to 0): Batch submission, high false-alarm rate, contradictions
8. final_score: weighted average + bonuses + penalties, clamped 0-100

RESPONSE FORMAT — Return ONLY valid JSON:
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

    # ── Dynamic intelligence dossier (NOT cached — unique per report) ──
    corr_details = ""
    for c in corr["details"][:3]:
        corr_details += f"\n    • {c['dist_m']}m away: {c['type']} ({c['severity']}) via {c['source']}, {'verified '+str(c['v_score'])+'/100' if c['v_score'] else 'unverified'}, {c['hours_ago']}h ago"

    dossier = f"""═══ INCIDENT INTELLIGENCE DOSSIER ═══
Report ID: {report_id[:8]} | Source: {source} {"(NO photo capability)" if is_voice_sms else "(HAS photo capability)"} | Waiting: {wait_hours}h

── SECTION 1: REPORT DATA ──
Infrastructure: {infra} (Criticality: {criticality})
Name: {report.infrastructure_name or 'Not specified'}
Severity: {report.severity.value if report.severity else 'UNKNOWN'}
Crisis Type: {report.crisis_type or 'Not specified'}
Damage: {report.damage_classification or 'Not specified'}
Debris Clearing: {'Needed' if report.debris_clearing_needed else 'Not specified'}
Location: {loc_name} ({lat}, {lng}) ±{acc}m

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
{f"Score: {v.total_score}/100 — {v.verdict}" if v and v.total_score else "Not yet verified (baseline 50)"}
{f"Scene: {(v.satellite_scene_description or '')[:250]}" if v else ""}
{f"Findings: {'; '.join((v.key_findings or [])[:3])}" if v and v.key_findings else ""}
{f"Photo vs Satellite: {(v.photo_analysis or '')[:200]}" if v and v.photo_analysis else ""}

── SECTION 5: CORROBORATION ──
Nearby (5km): {corr['nearby_total']} reports ({corr['nearby_verified']} verified, {corr['nearby_same_type']} same type)
Source Diversity: {corr['source_diversity']} channels
Temporal Cluster (2h): {'YES — likely real event' if corr['temporal_cluster'] else 'No'}
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
Night Report: {'YES' if is_night else 'No'} | Batch Submission: {'YES — SUSPICIOUS' if batch >= 3 else 'No'}
Response Wait: {wait_hours}h | Data Completeness: {completeness}%

Compute the score breakdown and return JSON as specified."""

    try:
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": anthropic_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 1200,
                    "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                    "messages": [{"role": "user", "content": dossier}],
                })
            if r.status_code == 200:
                import json as jsonlib
                text = r.json().get("content", [{}])[0].get("text", "{}")
                try:
                    start = text.index('{')
                    end = text.rindex('}') + 1
                    data = jsonlib.loads(text[start:end])
                except:
                    data = {"summary": text[:200], "suggested_action": "Review Needed", "reasoning": text, "confidence_score": 0}

                # Phase 3.3 — stamp the assessment with metadata so
                # later cache hits can surface "computed at X". The
                # nested keys are namespaced under `_meta` to stay
                # clear of any Claude-emitted field names.
                data["_meta"] = {
                    "computed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "model": "claude-sonnet-4-20250514",
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
                # Phase 3.3 — `_cached: False` so the dashboard can
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


# ── Progressive Upload: Stage 2/3 — attach one media file ────────────────────
@router.patch("/{report_id}/media/attach", response_model=ReportResponse)
def attach_media(report_id: str, media_in: MediaAttach, db: Session = Depends(get_db)):
    """
    Attach a single media file (image or audio) to an existing report.
    Updates sync_status from PARTIAL → SYNCED when all expected media received.
    Triggers AI pipeline for each media type received.
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Decode and save the base64 media via the storage abstraction.
    # extension + content-type now come from
    # _detect_audio_format/the data: URL header (was hardcoded to
    # "webm" for everything non-image, which produced unplayable
    # audio when iOS recorded MP4/AAC).
    file_url = media_in.url
    if media_in.url.startswith("data:"):
        try:
            header, encoded = media_in.url.split(",", 1)
            file_data = base64.b64decode(encoded)
            if not file_data:
                raise ValueError("Empty base64 data")

            if "image" in header:
                ext = "png" if "png" in header else "jpg"
                content_type = _content_type_for(f"x.{ext}")
            else:
                ext, content_type = _detect_audio_format(header, file_data)
            filename = f"{report.id}_{time.time()}.{ext}"

            # (PR 2) — single-shot attach path. PII blur runs
            # via /tmp/ tempfile (filesystem-based cv2), then we
            # storage.save() the (possibly blurred) bytes.
            final_data = file_data
            if ext in ('jpg', 'jpeg', 'png'):
                try:
                    from app.services.pii_blur import blur_pii
                    with _stage_bytes(filename, file_data) as tmp_path:
                        pii_result = blur_pii(tmp_path)
                        with open(tmp_path, "rb") as _fh:
                            final_data = _fh.read()
                    if pii_result.get("blurred"):
                        logger.info(
                            f"PII blurred in attached {filename}: "
                            f"faces={pii_result['faces']} text={pii_result['pii_texts']}"
                        )
                except Exception as e:
                    logger.warning(f"PII blur failed for {filename}: {e}")

            file_url = _get_media_storage().save(filename, final_data, content_type)
            logger.info(
                f"Attached {ext} ({content_type}): {filename} "
                f"({len(final_data)} bytes) → {file_url}"
            )
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
        # Update existing — don't create duplicate
        existing_media.url = file_url
        existing_media.file_size_bytes = media_in.file_size_bytes or (len(file_data) if file_data else 0)
        logger.info(f"Media updated (existing): {existing_media.id[:12]}")
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
        )
        db.add(db_media)

        # Update received count only for new media
        report.received_media = (report.received_media or 0) + 1

    # Check if all expected media received → mark SYNCED
    if report.received_media >= report.expected_media:
        report.sync_status = SyncStatusEnum.SYNCED
        logger.info(f"Report {report.id} fully synced ({report.received_media}/{report.expected_media} media)")
    else:
        logger.info(f"Report {report.id} partial ({report.received_media}/{report.expected_media} media)")

    db.commit()

    # Trigger AI pipeline for this specific media. (PR 3) —
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
            # Best-effort — never block the attach response on a
            # transcription failure. The dashboard renders without
            # transcription; an analyst can retry from the admin panel.
            logger.warning(f"Audio transcription failed for {file_url}: {e}")

    elif media_in.type == MediaTypeEnum.IMAGE and file_url:
        try:
            filename = file_url.rsplit("/", 1)[-1].split("://", 1)[-1].rsplit("/", 1)[-1]
            with _stage_from_storage(file_url, filename) as tmp_path:
                vision_result = ai_service.analyze_image(tmp_path)
            ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report.id).first()
            if ai:
                ai.detected_labels = vision_result.get("labels", [])
                ai.damage_score = vision_result.get("risk_score", 0.0)
            else:
                ai = AIAnalysis(
                    report_id=report.id,
                    detected_labels=vision_result.get("labels", []),
                    damage_score=vision_result.get("risk_score", 0.0)
                )
                db.add(ai)
            db.commit()
        except Exception as e:
            logger.warning(f"Image AI pipeline failed for {file_url}: {e}")

    db.refresh(report)
    return report


# ── Progressive Upload: Stage 2 — thumbnail (fast preview before full chunks) ─
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

    # Decode + persist via the storage abstraction. (PR 3) —
    # was previously writing directly to UPLOAD_DIR + emitting
    # `/static/<file>`. Under MEDIA_BACKEND=s3 that violated the
    # zero-persistent-disk mandate (every fast-preview thumbnail
    # accumulated on the EC2 volume forever). Now uses the same
    # storage.save() path as full media + chunked uploads, so the
    # backend selection decides where the bytes physically land.
    # PII blur still runs but via _stage_bytes — cv2.imread needs a
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
                # Blur failure must not block the fast-preview write —
                # raw thumbnail still goes up, server-side blur on the
                # full chunked photo will catch the same content later.
                logger.warning(f"Thumbnail PII blur failed (non-fatal): {e}")

            thumbnail_url = _get_media_storage().save(
                filename, final_bytes, _content_type_for(filename)
            )
        except Exception as e:
            logger.warning(f"Thumbnail save failed (non-fatal): {e}")

    # Upsert Media record — create if not exists, update thumbnail if already exists
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


# ── Progressive Upload: Stage 2/3 — one ~1KB media chunk (PRD §3.3) ──────────
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
    - Triggers AI pipeline in background (non-blocking — P-1 fix)
    - Returns completion_pct for client progress tracking

    P1.5 — rate limited to 180 chunks/minute per client IP (= 3/s). A healthy
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

    # Transport observability — emit after integrity check so checksum-mismatch
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
    media = db.query(Media).filter(Media.id == payload.media_id).first()
    if not media:
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
            # Subsequent chunks for the same media_id don't update it —
            # all chunks for one upload share the same blur status.
            client_blur_applied=bool(payload.client_blur_applied),
            # Phase C.1 — whole-asset checksum from the PWA's djb2 over the
            # full original bytes. Sent on chunk 0 only; the assembler will
            # verify after concatenation. NULL on later chunks / legacy
            # clients => check skipped (back-compat).
            full_asset_checksum=(payload.full_asset_checksum if payload.seq_num == 0 else None),
        )
        db.add(media)
        db.flush()
    else:
        if payload.client_blur_applied and not media.client_blur_applied:
            # Client sent the flag on a later chunk (e.g. resumed upload where
            # first chunk predated the client-blur release). Upgrade the media
            # row so the assembler picks it up.
            media.client_blur_applied = True
        # Phase C.1 — late-arriving whole-asset checksum (chunk 0 retried
        # after others landed first). Accept iff the row doesn't already
        # carry one; never overwrite the canonical first-write value.
        if payload.seq_num == 0 and payload.full_asset_checksum and not media.full_asset_checksum:
            media.full_asset_checksum = payload.full_asset_checksum
        # Tier upgrade: /media/thumbnail used to hard-code MEDIUM when it
        # created the row, which stranded HIGH-tier rows at MEDIUM whenever
        # the thumbnail landed first. Conservative rule — only upgrade
        # LOW/MEDIUM → HIGH, never downgrade — so the dashboard "Originals
        # pending" pill (filters on resolution_tier === 'HIGH') sees the
        # full-quality variant once the chunks declare it.
        if (payload.resolution_tier == ResolutionEnum.HIGH
                and media.resolution_tier in (ResolutionEnum.LOW, ResolutionEnum.MEDIUM)):
            media.resolution_tier = ResolutionEnum.HIGH

    # Idempotent chunk insert — check for duplicate before incrementing counter
    existing_chunk = db.query(MediaChunk).filter(
        MediaChunk.media_id == payload.media_id,
        MediaChunk.seq_num == payload.seq_num
    ).first()

    is_new_chunk = not existing_chunk
    if is_new_chunk:
        db.add(MediaChunk(
            media_id=payload.media_id,
            seq_num=payload.seq_num,
            total_chunks=payload.total_chunks,
            data_b64=payload.data,
            checksum=payload.checksum
        ))
        # P-6 fix: atomic SQL-level increment avoids race condition on concurrent retries
        #
        # Phase-2.4 invariant — `chunk_count` is updated on every
        # chunk insert to `payload.total_chunks`. The assumption this relies
        # on: **chunks within a single media_id are UNIFORM size**, so
        # `total_chunks` never changes mid-upload. Clients enforce this via
        # a `LOCKED_TOTAL_CHUNKS` (RN) / `const total = ...` (PWA) computed
        # once at upload-start. Mid-upload tier switches in the adaptive
        # layer (Phase 1.6 re-probe, Phase 2.1 packet-loss shrink) only
        # affect the chunk SIZE of the NEXT media — they do NOT re-chunk
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

    # Progressive partial assembly — BUT skip it if this chunk completes the
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
    # Run in background so the HTTP response returns immediately — otherwise
    # PII blur + disk I/O on the final chunk can hold the handler open long
    # enough for mobile clients to time out and leave the media stuck at
    # 'pending' despite received_chunks == total_chunks. See _try_full_assembly_bg.
    db.refresh(media)  # make sure we see the post-commit state, not stale in-memory
    logger.info(
        f"[Chunk] {payload.media_id[:8]} seq={payload.seq_num} "
        f"received={media.received_chunks}/{payload.total_chunks} "
        f"status={media.assembly_status} new={is_new_chunk}"
    )
    # P1.1 — Atomic-CAS lock before spawning. Previously two concurrent chunk
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
            # P2.2 — submit to the bounded ThreadPoolExecutor instead of
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
# throttling does NOT update at runtime — leading to the client picking
# MEDIUM tier (128 KB chunks, 30 s timeout) on a 2 Kbps throttled link,
# every chunk timing out, upload stuck forever.
#
# The client POSTs a ~8 KB payload, measures wall-clock round-trip time,
# divides → bytes-per-second → picks a tier. No persistence. No auth
# (bandwidth is a public property of the link; hiding this endpoint
# doesn't add security). Rate-limited 60/min per client IP so it can't
# be abused for DoS.
# ── UI v4 — AI classify-suggest (Claude Haiku) ─────────────────────────────
# Used by the v4 capture flow on Page 2: when the user takes a photo on a
# fast network, the client POSTs the photo (+ optional GPS) here, and we ask
# Claude Haiku for suggested infra / crisis / damage classifications. The
# client pre-fills the 3 chip rows so the user only taps what they disagree
# with. On slow / offline tiers, the client never calls this endpoint.
#
# Service: app/services/classify_suggest.py.
# Returns 200 even on degraded paths (no API key, timeout, parse error) —
# the response carries `source: "ai"|"fallback"` so the client can render
# the chips appropriately.
@router.post("/classify-suggest", status_code=status.HTTP_200_OK)
async def classify_suggest(request: Request, payload: dict):
    """
    Body shape (JSON):
      {
        "image_b64":   "<base64-encoded JPEG/PNG, no data: prefix>",
        "media_type":  "image/jpeg" | "image/png" | "image/webp",
        "lat":         optional float,
        "lng":         optional float
      }

    Response:
      {
        "infrastructure_type":   "RESIDENTIAL"|...|"OTHER",
        "crisis_type":           "EARTHQUAKE"|...|"OTHER",
        "damage_classification": "MINIMAL"|"PARTIAL"|"COMPLETE",
        "confidence":            0.0-1.0,
        "reasoning_short":       "<= 80 char justification>",
        "source":                "ai" | "fallback",
        "fallback_reason":       optional string when source=fallback
      }
    """
    from app.main import check_rate_limit
    from app.services.classify_suggest import ClassifySuggestService

    client_ip = request.client.host if request.client else "unknown"
    # Same rate limit as the bandwidth probe — these are both pre-capture
    # signals, neither should be hammered.
    if not check_rate_limit(f"classify:{client_ip}", max_requests=60, window=60):
        raise HTTPException(status_code=429, detail="classify-suggest rate limit exceeded")

    image_b64 = (payload or {}).get("image_b64", "")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=422, detail="image_b64 (base64 JPEG/PNG) is required")

    media_type = (payload or {}).get("media_type", "image/jpeg")
    if media_type not in ("image/jpeg", "image/png", "image/webp"):
        media_type = "image/jpeg"

    lat = (payload or {}).get("lat")
    lng = (payload or {}).get("lng")
    if not isinstance(lat, (int, float)):
        lat = None
    if not isinstance(lng, (int, float)):
        lng = None

    service = ClassifySuggestService()
    result = await service.suggest(
        image_b64=image_b64,
        media_type=media_type,
        lat=lat,
        lng=lng,
    )
    return result


@router.post("/upload-probe", status_code=status.HTTP_200_OK)
async def upload_probe(request: Request, data: UploadFile = File(...)):
    """Echo `len(data)` for client-side bandwidth measurement.

    Client usage:
      * generate an N-byte payload (8 KB recommended — enough signal,
        fast enough at worst-case bandwidth)
      * `performance.now()` before the POST
      * `performance.now()` after the 200 response arrives
      * throughput ≈ N / elapsed_ms * 1000 bytes/sec
    """
    from app.main import check_rate_limit
    client_ip = request.client.host if request.client else 'unknown'
    if not check_rate_limit(f"probe:{client_ip}", max_requests=60, window=60):
        raise HTTPException(status_code=429, detail="probe rate limit exceeded")
    # 64 KB hard cap — stops abuse where a client POSTs 100 MB "probes".
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
#     media_id           — string, UUID chosen by the client
#     seq_num            — int, 0-indexed chunk sequence
#     total_chunks       — int, total chunks for this media
#     type               — "IMAGE" | "AUDIO"
#     resolution_tier    — "LOW" | "MEDIUM" | "HIGH"   (default "LOW")
#     photo_group_id     — string, UUID grouping the 3 variants of one photo
#     client_blur_applied — "true"/"false"/"1"/"0"
#     checksum           — hex djb2 over the raw bytes (optional)
#     data               — UploadFile, the raw-byte chunk payload
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
    # Phase C.1 — whole-asset djb2 checksum, sent on chunk 0 only.
    # Absent / NULL on later chunks and on legacy clients; the assembler
    # skips the integrity check when the column is NULL on the Media row.
    full_asset_checksum: Optional[str] = Form(None),
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
    if tier_upper not in {"LOW", "MEDIUM", "HIGH", "ORIGINAL"}:
        raise HTTPException(status_code=422, detail=f"invalid resolution_tier: {resolution_tier!r}")

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

    # Transport observability — post-checksum-verify so rejected uploads
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

    # ── Find-or-create Media row. Mirrors the legacy endpoint exactly.
    media = db.query(Media).filter(Media.id == media_id).first()
    if not media:
        from app.models.report import MediaTypeEnum as _MTE, ResolutionEnum as _RE
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
            # Phase C.1 — persist the PWA-computed whole-asset checksum on
            # creation. Only chunk 0 carries this field; later chunks pass
            # None and `seq_num != 0` short-circuits the assignment below.
            full_asset_checksum=(full_asset_checksum if seq_num == 0 else None),
        )
        db.add(media)
        db.flush()
    else:
        if blur_flag and not media.client_blur_applied:
            # Late-arriving blur flag (same upgrade path as the legacy endpoint).
            media.client_blur_applied = True
        # Phase C.1 — late-arriving full-asset checksum. If chunk 0 was lost
        # or re-sent after an intermediate chunk landed first, accept the
        # value when the row doesn't already carry one. Don't overwrite an
        # existing non-NULL value (the original is canonical).
        if seq_num == 0 and full_asset_checksum and not media.full_asset_checksum:
            media.full_asset_checksum = full_asset_checksum
        # Tier upgrade — same conservative rule as the legacy JSON endpoint.
        # See attach_media_chunk's else branch for the full why.
        from app.models.report import ResolutionEnum as _RE2
        if (tier_upper == "HIGH"
                and media.resolution_tier in (_RE2.LOW, _RE2.MEDIUM)):
            media.resolution_tier = _RE2.HIGH

    # ── Idempotent insert. Mirrors the legacy endpoint byte-for-byte
    #    except the column we write (data_binary instead of data_b64).
    existing_chunk = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id,
        MediaChunk.seq_num == seq_num
    ).first()

    is_new_chunk = not existing_chunk
    if is_new_chunk:
        db.add(MediaChunk(
            media_id=media_id,
            seq_num=seq_num,
            total_chunks=total_chunks,
            data_b64=None,            # legacy column NULL — binary wins
            data_binary=raw_bytes,
            checksum=checksum,
        ))
        # Atomic SQL-level increment — same race-safe pattern as the legacy path.
        db.query(Media).filter(Media.id == media_id).update(
            {"received_chunks": Media.received_chunks + 1,
             "chunk_count": total_chunks},
            synchronize_session="fetch"
        )
        db.flush()
        db.refresh(media)
        media.completion_pct = round((media.received_chunks / total_chunks) * 100, 1)

    db.commit()

    # ── Progressive partial assembly — same trigger cadence as legacy
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
        raise HTTPException(status_code=429, detail="Rate limit exceeded — try again later")
    
    # 0. Idempotency + collision detection (P1.6 — same guard as /meta).
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
                    "message": "client_report_id already used by a different device — regenerate and retry",
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
    db_report = Report(**report_dict, device_id=device.id)
    db.add(db_report)
    db.commit()
    db.refresh(db_report)

    # 3. Geo-Telemetry Attachment
    if report_in.location:
        loc_data = report_in.location.model_dump()

        # Server-side geocoding: if user typed a place name but has no real coordinates
        # (e.g. offline submission with 0,0 coords), resolve the name to coordinates
        if loc_data.get('user_location_name') and loc_data.get('latitude', 0) == 0 and loc_data.get('longitude', 0) == 0:
            try:
                geo_url = f"https://nominatim.openstreetmap.org/search?q={loc_data['user_location_name']}&format=json&limit=1"
                resp = httpx.get(geo_url, headers={"User-Agent": "CRISP-Platform/1.0"}, timeout=10)
                geo_data = resp.json()
                if geo_data and len(geo_data) > 0:
                    loc_data['latitude'] = float(geo_data[0]['lat'])
                    loc_data['longitude'] = float(geo_data[0]['lon'])
                    loc_data['is_user_corrected'] = True
                    logger.info(f"Geocoded '{loc_data['user_location_name']}' -> {loc_data['latitude']}, {loc_data['longitude']}")
            except Exception as e:
                logger.warning(f"Server-side geocoding failed for '{loc_data['user_location_name']}': {e}")

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

                    # (PR 2) — write through the storage
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

    db.commit()

    # 5. Pipeline Trigger: Local AI NLP & Computer Vision processing
    # If the user included text, photos, or voice notes, we analyze them synchronously 
    # for the MVP to provide immediate tactical insight.
    ai_metadata = {
        "transcription": None,
        "labels": [],
        "damage_score": 0.0,
        "processing_time": 0
    }
    
    start_time = time.time()
    
    # Extract audio for speech-to-text
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
            ai_metadata["transcription"] = transcription_result
            logger.info(f"Transcription result: {transcription_result[:100] if transcription_result else 'EMPTY'}")
        else:
            logger.error(f"Audio file not found at: {disk_path}")
            
    # Extract images for damage assessment
    image_files = [m.url for m in saved_media_entities if m.type == MediaTypeEnum.IMAGE]
    if image_files:
        path = image_files[0].replace("/static/", "")
        disk_path = os.path.join(UPLOAD_DIR, path)
        if os.path.exists(disk_path):
            vision_result = ai_service.analyze_image(disk_path)
            ai_metadata["labels"] = vision_result.get("labels", [])
            ai_metadata["damage_score"] = vision_result.get("risk_score", 0.0)

    processing_time = int((time.time() - start_time) * 1000)
    
    # Hydrate AI analysis table
    if ai_metadata["transcription"] or ai_metadata["labels"]:
        db_ai = AIAnalysis(
            report_id=db_report.id,
            damage_score=ai_metadata["damage_score"],
            transcription=ai_metadata["transcription"],
            detected_labels=ai_metadata["labels"],
            processing_time_ms=processing_time
        )
        db.add(db_ai)
        db.commit()

    db.refresh(db_report)
    return db_report

@router.get("/", response_model=List[ReportResponse])
def get_reports(
    request: Request,
    response: Response,
    skip: int = 0,
    limit: int = 100,
    include_deleted: bool = False,
    since: Optional[datetime] = Query(
        None,
        description=(
            "ISO 8601 timestamp (e.g. 2026-05-09T18:30:00Z). When set, returns "
            "ONLY reports whose own row, or any of their media rows, has been "
            "updated since this time. Dashboard reads X-Server-Time on each "
            "response and echoes it back as `since` on the next poll for "
            "incremental delta sync — typical poll body drops from ~440 KB to "
            "<2 KB on idle dashboards. Omit `since` for the initial full load."
        ),
    ),
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
):
    """
    Retrieve aggregated tactical reports for the dashboard sync client.
    By default, excludes reports pending deletion (24h grace period).
    Pass ?include_deleted=true to see them (admin use).

    P2.1 — the serializer walks every Report's media + ai_analysis + location
    + verification. Without eager loading this is an N+1: a 1000-row dashboard
    fetch fires 4001+ queries. `joinedload` pulls all relationships in one
    wide SELECT per relationship, taking the query count to ~5 regardless of N.

    P2.11 — also returns X-Total-Count header and caps `limit` at 500 so a
    misbehaving client can't pull the whole table in one shot. The dashboard
    reads the header to drive its pagination / infinite-scroll.

    Phase 3 (May 2026, HAR-driven) — `since` parameter enables incremental
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
    if not include_deleted:
        q = q.filter(Report.deletion_requested_at == None)

    # Phase 3: delta filter. Match reports whose own row OR any of their
    # media rows has updated since `since`. Media is included because the
    # chunked-upload pipeline only bumps `report.updated_at` at assembly-
    # complete (via received_media++); per-chunk progress lives on
    # Media.updated_at, and partial-upload progress visualisation in the
    # dashboard would stop animating without the EXISTS clause.
    if since is not None:
        # Strip tzinfo for the comparison if the column is tz-naive — but
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

    # Phase 1.6 (May 2026) — Dashboard V4 field parity. The
    # ReportResponse schema carries `reporter_tier` for the masked
    # reporter badge. Bulk-fetch tier mappings for every device_hash
    # in this page in ONE query (no N+1), then stash on each Report
    # as a transient attribute. The model_validator on
    # `_compute_identity_badge` picks it up — keeps the join logic in
    # the endpoint where the session is live, and the projection
    # logic in the schema where the rest of the derived fields live.
    _attach_reporter_tier(db, reports)

    # ETag / If-None-Match.
    # Cheap fingerprint: include each report's id+updated_at AND each
    # media row's id+updated_at+completion_pct. Catches changes in the
    # parent report AND in chunked-upload progress (which doesn't always
    # bump the parent's updated_at). Already-loaded SQLAlchemy objects
    # — zero extra DB hits.
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
    # Phase 3: ISO 8601 with `Z` suffix — same shape as our datetime
    # serialization elsewhere. Dashboard reads this and echoes it back
    # as `?since=<value>` on the next poll.
    response.headers["X-Server-Time"] = cursor.isoformat().replace("+00:00", "Z")
    response.headers["ETag"] = etag_value
    # `Cache-Control: no-cache` — browsers MUST revalidate (send
    # If-None-Match) on every poll. Without this, a stale cached body
    # would short-circuit the conditional check.
    response.headers["Cache-Control"] = "no-cache"
    # CORS: without this the dashboard's fetch() can't actually read the header.
    response.headers["Access-Control-Expose-Headers"] = (
        "X-Total-Count, X-Limit, X-Offset, X-Server-Time, ETag"
    )

    # If the dashboard echoed our previous ETag back, short-circuit with
    # 304 — saves the schema-validation + JSON-encoding cost on the
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


# ── "Verified Reports Nearby" — Public intel summary ─────────────────────────
#
# Public endpoint (no auth) — the response is heavily privacy-projected
# via ReportNearbyResponse + the aggregator service. No device_id,
# no user_id, no description, no individual report id, no precise
# per-report coords. Same trust model as the existing share-token +
# stable media URL endpoints.
#
# Drives the home-stage "Verified Reports Nearby" module on the PWA +
# RN companion. Reporters get ambient awareness ("12 reports nearby
# at Green Valley Apartments") without compromising any reporter's
# anonymity. The module is INVISIBLE when offline / GPS denied — see
# the offline-behavior matrix in the design plan.
#
# UNDP alignment:
#   • must-have #6 (building footprints) — primary group key
#   • must-have #7 (PII protection)      — strict allow-list projection
#   • must-have #9 (anonymity)           — zero reporter identification
#   • must-have #12 (scale)              — bbox pre-filter + top-N + cache

_NEARBY_CACHE: dict = {}
_NEARBY_CACHE_TTL_SECONDS = 90

def _nearby_cache_key(lat3: float, lng3: float, radius_km: float,
                     since_iso: str, group_by: str,
                     limit: int, max_age_hours: int) -> str:
    return f"{lat3:.3f}|{lng3:.3f}|{radius_km:.1f}|{since_iso}|{group_by}|{limit}|{max_age_hours}"


@router.get("/nearby", response_model=ReportNearbyResponse)
def get_nearby_reports(
    request: Request,
    response: Response,
    lat: float = Query(..., ge=-90, le=90,
                       description="Latitude of the user's location. Client SHOULD round to 3dp (~110m) before sending."),
    lng: float = Query(..., ge=-180, le=180,
                       description="Longitude of the user's location. Client SHOULD round to 3dp (~110m) before sending."),
    radius_km: float = Query(5.0, ge=0.1, le=25.0,
                             description="Search radius in kilometres. Default 5, max 25."),
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
    """
    # Cache key uses caller's rounded coords + filter params. 3-decimal
    # rounding (~110m) clusters nearby callers onto the same cache row.
    lat_r = round(lat, 3)
    lng_r = round(lng, 3)
    since_iso = since.isoformat() if since else ""
    cache_key = _nearby_cache_key(lat_r, lng_r, radius_km, since_iso, group_by, limit, max_age_hours)

    now_ts = datetime.now(timezone.utc).timestamp()
    cached = _NEARBY_CACHE.get(cache_key)
    if cached and (now_ts - cached["ts"] < _NEARBY_CACHE_TTL_SECONDS):
        # Cache hit — replay headers + serve cached payload.
        cached_payload = cached["payload"]
        response.headers["Cache-Control"] = "private, max-age=60"
        response.headers["X-Cache"] = "HIT"
        return cached_payload

    # ── DB query ──────────────────────────────────────────────────────
    # Bbox pre-filter on indexed lat/lng columns. cos(lat) handles
    # meridian convergence; we widen at high latitudes but the
    # haversine post-filter still nails the actual radius.
    lat_min, lat_max, lng_min, lng_max = bbox_for_radius(lat, lng, radius_km)

    # Cut-off for `max_age_hours`. server_created_at index narrows the
    # scan further.
    age_cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

    # Surface VERIFIED + PENDING only (operator approved INCLUDE
    # PENDING with a ⏳ badge). Explicitly exclude REJECTED, DUPLICATE,
    # FALSE_ALARM — these are spam / mis-reports and must not show up.
    q = (
        db.query(Report)
          .join(Location, Location.report_id == Report.id)
          .filter(Location.latitude.between(lat_min, lat_max))
          .filter(Location.longitude.between(lng_min, lng_max))
          .filter(Report.status.in_([
              ReportStatusEnum.VERIFIED,
              ReportStatusEnum.PENDING,
          ]))
          .filter(Report.deletion_requested_at == None)
          .filter(Report.server_created_at >= age_cutoff)
          .options(joinedload(Report.location))
    )

    if since is not None:
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        else:
            since = since.astimezone(timezone.utc)
        q = q.filter(Report.updated_at > since)

    candidates = q.all()

    # Exact haversine post-filter — drops bbox false-positives.
    inputs: List[NearbyReportInput] = []
    for r in candidates:
        if not r.location:
            continue
        d_km = haversine_km(lat, lng, r.location.latitude, r.location.longitude)
        if d_km > radius_km:
            continue
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
        ))

    # Aggregate → groups (k-anonymity + relevance sort applied inside).
    groups = aggregate_nearby(
        reports=inputs,
        user_lat=lat,
        user_lng=lng,
        radius_km=radius_km,
        group_by=group_by,
        max_groups=limit,
    )

    payload = ReportNearbyResponse(
        user_location={"lat": lat_r, "lng": lng_r},
        radius_km=radius_km,
        as_of=datetime.now(timezone.utc),
        groups=[
            ReportNearbyGroup(
                id=g.id, kind=g.kind, label=g.label, summary=g.summary,
                summary_key=g.summary_key, count=g.count,
                verified_count=g.verified_count, pending_count=g.pending_count,
                approx_distance_km=g.approx_distance_km,
                centroid_lat=g.centroid_lat, centroid_lng=g.centroid_lng,
                latest_at=g.latest_at, earliest_at=g.earliest_at,
                crisis_types=g.crisis_types, damage_classes=g.damage_classes,
                severity_max=g.severity_max,
            )
            for g in groups
        ],
        total_groups=len(groups),
        total_reports=len(inputs),
    )

    # Cache for 90 s. Capped at 1000 entries to bound memory; LRU-ish
    # eviction at insertion time.
    if len(_NEARBY_CACHE) >= 1000:
        # Drop the 100 oldest entries
        oldest = sorted(_NEARBY_CACHE.items(), key=lambda kv: kv[1]["ts"])[:100]
        for k, _ in oldest:
            _NEARBY_CACHE.pop(k, None)
    _NEARBY_CACHE[cache_key] = {"ts": now_ts, "payload": payload}

    response.headers["Cache-Control"] = "private, max-age=60"
    response.headers["X-Cache"] = "MISS"
    response.headers["X-Total-Groups"] = str(payload.total_groups)
    response.headers["X-Total-Reports"] = str(payload.total_reports)
    return payload


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
async def verify_report(report_id: str, db: Session = Depends(get_db)):
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
            detail="Report has no GPS coordinates — cannot fetch satellite image"
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
            detail="Could not fetch satellite imagery — check SENTINEL_HUB_CLIENT_ID/SECRET and MAPBOX_TOKEN in .env"
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
    # grid. The primary is duplicated as `images[0]` for consistency —
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
    # `s3://abc.jpg` (S3Storage) — `os.path.join` produces a nonsensical
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
                suffix = ".jpg"  # safe default — Claude infers from bytes anyway
            tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            try:
                tmp.write(img_bytes)
            finally:
                tmp.close()
            user_image_path = tmp.name
            user_image_tmp = tmp.name
        except Exception as exc:
            # Don't block verification if the photo can't be loaded —
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
        )
    finally:
        # Clean up the temp file — both on success and on Claude API failure.
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
    # .2 — stamp the time the
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

    Apr 2026 PR 2 — defense-in-depth against stored-counter drift. The
    stored `ReporterProfile.report_count` is only decremented in
    `_purge_expired_deletions`. If the purge job hasn't run yet (or
    failed), the stored counter can be higher than the actual live
    rows. We report the MIN of stored vs live so the UI never shows a
    number that's greater than the reports the user can actually see.
    Same for `verified_count`.

    May 2026 second-pass — extended response shape for the 4-tier
    reward ladder (SCOUT / SIGNAL / CHANGEMAKER / LIFEKEEPER):

      * ``responded_count`` — live count of reports in
        {RESPONDING, RESOLVED} (drives the T3 promotion).
      * ``lives_saved_total`` — sum of ``lives_impacted`` across the
        device's reports (drives the T4 promotion + the home/My-Reports
        Lives Saved aggregate).
      * ``badge_level`` — one of T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER
        / T4_LIFEKEEPER. Recomputed on the fly here so a stale stored
        value (e.g. from before the v2 migration) corrects itself on
        the next read.
      * ``badge_legacy`` — same tier mapped to the old 3-tier names
        (NEWCOMER / CONTRIBUTOR / TRUSTED) for pre-v145 PWA shells
        that haven't picked up the new BADGE_LEVELS map yet. Removed
        in a post-submission cleanup once SW cache invalidation has
        propagated.
      * ``tier`` object — current tier id, next tier id, and a
        machine-readable ``progress`` block telling the PWA exactly
        what action moves the user up. The PWA renders this verbatim
        in the badge-chip sub-line so backend stays the single source
        of truth for the progression copy.
    """
    from app.models.report import ReporterProfile
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        profile = ReporterProfile(device_hash=device_hash, report_count=0, badge_level="T1_SCOUT", impact_score=0)
        db.add(profile)
        db.commit()
        db.refresh(profile)

    # Live count of un-deleted rows for this device. If the device row
    # doesn't exist (rare — only for fresh profiles), fall back to 0.
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
    else:  # T4 — top tier
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
    ``report_count`` — i.e. it rewarded exactly the behaviour UNDP
    warned against.

    May 2026 second-pass — extended to a 4-tier identity-forward
    ladder (SCOUT → SIGNAL → CHANGEMAKER → LIFEKEEPER). Promotion
    triggers are concrete impact events, never raw volume:
      * T2 SIGNAL       — ≥1 report submitted (this function)
      * T3 CHANGEMAKER  — ≥1 report dispatched (RESPONDING/RESOLVED
                          — see ``_mark_report_verified_for_credibility``)
      * T4 LIFEKEEPER   — analyst set ``lives_impacted ≥ 1`` on any
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
    """4-tier reward ladder — May 2026 second-pass redesign.

    Replaces ``_recompute_badge_from_verified`` (3-tier, verified-count
    only). The new ladder is quality-driven across THREE signals:
    submission, dispatch (help sent), and lives impacted. Every
    promotion requires either an analyst action or a real downstream
    impact event — never raw volume alone.

    Tier criteria:
      * T4 LIFEKEEPER   — sum(lives_impacted across device's reports) ≥ 1
                          (requires analyst to call ``/impact``)
      * T3 CHANGEMAKER  — ≥1 report in {RESPONDING, RESOLVED}
                          (requires analyst to call ``/dispatch`` or
                          ``/resolve``)
      * T2 SIGNAL       — ≥1 report submitted (any status)
      * T1 SCOUT        — default

    INCENTIVES.md compliance note (re-verified May 2026 audit):
    T2_SIGNAL fires on the FIRST submission as a one-time
    participation acknowledgement. This is INTENTIONAL and DOES
    honor the "no volume-based repeat reward" rule:
      · 1 submission  → T2 (one-time bump)
      · 50 submissions → still T2 (no further reward from raw volume)
      · 1 verified    → T3 (analyst action required)
      · 1 life saved  → T4 (downstream impact required)
    The fraud-prevention guarantee — that flooding reports does NOT
    advance the tier beyond T2 — is upheld. The home-stage HERO STAT
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

    # Soft-deleted rows are excluded — they were either restored within
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
    """DEPRECATED — kept as a shim so any external import doesn't crash
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

    1. ``report.first_verified_at`` short-circuit — once this column
       is non-NULL, this function returns immediately. The endpoint-
       level ``was_pending`` guard catches the common case (status
       transition), but is NOT safe under parallel dispatch + resolve
       requests where both transactions see ``status == PENDING``
       before either commits.
    2. ``SELECT … FOR UPDATE`` row lock on the report — serializes
       concurrent calls inside Postgres. The second transaction
       blocks until the first commits, then sees
       ``first_verified_at`` already set and bails.

    Net effect: ``verified_count`` is bumped at most ONCE per report,
    even when called twice from racing parallel endpoints. The audit
    finding C-2 (CRITICAL — `verified_count` non-idempotent under
    race) is resolved by this gate.

    May 2026 — also calls ``_recompute_tier`` so T3 CHANGEMAKER promotion
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
    same building, with different levels of damage — the system should
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

        `building_version_ordinal` — 1-based index within this building's
            history (1 = latest). Human-rendered as "V 2 of 3".
        `building_is_latest`       — true for ordinal 1, false otherwise.

    "Latest complete" bias: if a newer report exists but is still in
    PARTIAL sync status (chunks incomplete), we still consider it the
    latest. Operators value freshness over "complete" flag. A future
    tightening would check Media.assembly_status instead — noted in
    docs/UNDP-ALIGNMENT-CHANGELOG.md for the followup sprint.
    """
    reports = db.query(Report).filter(
        Report.building_id == building_id,
        Report.deletion_requested_at.is_(None)
    ).order_by(Report.server_created_at.desc()).all()

    # Serialise via Pydantic first, then splice the ordinal fields
    # onto the dicts so JSON emission doesn't require model extension.
    serialised = [ReportResponse.model_validate(r).model_dump(mode="json") for r in reports]
    total = len(serialised)
    latest_id = serialised[0]["id"] if serialised else None
    for idx, row in enumerate(serialised):
        row["building_version_ordinal"] = idx + 1
        row["building_is_latest"] = (idx == 0)
    return {
        "building_id": building_id,
        "total": total,
        "latest_id": latest_id,
        "reports": serialised,
    }


# ── Stable media URLs ────────────────────────────────────────────
#
# Background — the dashboard's HAR analysis showed every ~4 s API poll
# generated a FRESH presigned S3 URL for every media row, because
# MediaResponse._resolve_url called storage.public_url() on each
# serialization. Same image bytes → 49 different X-Amz-Signature
# values → browser cache miss every poll → 98× refetch of identical
# bytes (~2.5 MB wasted per dashboard tab per 6 minutes). Same story
# for thumbnails on partial uploads.
#
# Fix — MediaResponse now emits a STABLE backend-routed URL of the form
# `/api/v1/reports/media/<media_id>/<file|thumb>`. The browser caches
# under that URL key and reuses bytes across polls. The endpoint below
# is what those URLs resolve to: a 302 redirect to a freshly-presigned
# S3 URL, with a 1-hour Cache-Control on the redirect itself so even
# cold caches hit the backend at most once per hour per image.
#
# Auth model — intentionally NO auth on this endpoint. The previous
# behaviour embedded presigned S3 URLs directly in the API response,
# making media accessible to anyone who held a presigned URL (no auth
# header needed). The new behaviour matches that exactly: anyone with
# the media_id (a UUID, unguessable) can fetch. Listing media_ids
# still requires Bearer auth via /api/v1/reports/.

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
    browser HTTP cache reuses the bytes — eliminating the per-poll
    refetch storm documented in HAR analysis.

    `/file` → media.url (full image / audio / video)
    `/thumb` → media.thumbnail_url (small placeholder, may be partial-
              assembly bytes during chunked upload)

    Cache-Control: public, max-age=3600 — the redirect itself is cached
    for 1 hour, so even hard-refresh paths only hit the backend once per
    image per hour. The actual S3 object cache TTL is set bucket-side.
    """
    media = db.query(Media).filter(Media.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")

    # Path-suffix sniff is more reliable than parsing routing params here
    # (FastAPI doesn't expose which alternative `@router.get` matched).
    is_thumb = request.url.path.rstrip("/").endswith("/thumb")
    db_url = media.thumbnail_url if (is_thumb and media.thumbnail_url) else media.url
    if not db_url:
        raise HTTPException(status_code=404, detail="No URL available for this media")

    target = _get_media_storage().public_url(db_url)

    # Defensive: if storage backend can't produce a real URL (e.g. local
    # backend asked to resolve an `s3://` row from a previously-S3 deploy),
    # surface 503 instead of redirecting the browser to garbage.
    if not (target.startswith("http://") or target.startswith("https://") or target.startswith("/")):
        raise HTTPException(
            status_code=503,
            detail="Storage backend cannot resolve URL for this media",
        )

    # Local-disk path: prefix with the same /static/ that nginx serves.
    # The dashboard already prepends BACKEND_HOST for relative paths.
    return RedirectResponse(
        url=target,
        status_code=302,
        headers={"Cache-Control": "public, max-age=3600"},
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
# No Bearer auth — same anonymity contract as the chunk endpoints
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
# Background — the satellite verification feature stores 1 primary image,
# 0-1 alternate images, and a 4-cell multi-provider grid (AWS Sentinel-2 +
# Microsoft Planetary Computer + ESA Copernicus + Mapbox). Before this
# refactor, VerificationResponse._resolve_sat_url called
# storage.public_url() directly, regenerating a fresh X-Amz-Signature on
# every dashboard poll. Worse, the dashboard hard-coded
# `${BACKEND_HOST}${v.satellite_image_url}` at 11 render sites — when
# MEDIA_BACKEND=s3 and the serializer returned a signed
# `https://s3.../...` URL, the dashboard prepended BACKEND_HOST and
# produced `https://undp/.../https://s3.../...` → 404.
#
# Fix — VerificationResponse now emits a STABLE backend-routed URL of the
# form `/api/v1/reports/{report_id}/satellite/<primary|alt|grid/<idx>>`.
# This endpoint resolves to a fresh presigned target on demand and tags
# the redirect with `Cache-Control: public, max-age=3600`. Same browser-
# cache-friendly pattern as the media redirect above.
#
# Auth model — intentionally NO auth (matches `get_media_redirect` and the
# previous behaviour where presigned URLs were embedded in API responses).
# The report_id is a UUID, unguessable — listing report_ids still requires
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

    Identical 1-hour Cache-Control as `get_media_redirect` so cold
    caches still only hit the backend ~once per image per hour.
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
        # Decode the JSON column. Forgiving — malformed JSON yields no URL
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

    target = _get_media_storage().public_url(db_url)

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
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{report_id}/satellite/primary")
def get_satellite_primary(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to the primary satellite image.

    Maps to `SatelliteVerification.satellite_image_url`. The "primary"
    is whichever provider the chain picked first (typically Sentinel-2
    via AWS, Microsoft, or ESA — Mapbox only when all Sentinel-2
    sources fail or are heavily clouded)."""
    return _satellite_redirect(db, report_id, "primary")


@router.get("/{report_id}/satellite/alt")
def get_satellite_alt(
    report_id: str,
    db: Session = Depends(get_db),
):
    """Stable URL → 302 to the alternate satellite image.

    Maps to `SatelliteVerification.satellite_image_url_alt` — typically
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
    (the Apr 2026 multi-provider fan-out — AWS / Microsoft / ESA /
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
# below — no Bearer auth, no login flow. Trust model matches the
# existing presigned-URL pattern: anyone with the report_id (a UUID,
# unguessable) can view. Listing report_ids still requires auth via
# /api/v1/reports/.
#
# Returned shape is intentionally compact and stable — designed for a
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
    yet — the evidence page renders an "awaiting verification" state.
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
    # /api/v1/reports/media/<id>/file URL — no auth, browser-cacheable.
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
        # Multi-provider grid URLs — same stable URLs the dashboard uses.
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
    out — a photo is not its own duplicate.

    Scope intentionally time-windowed + hash-filtered — NOT an O(N²) join.
    The typical working set is a few hundred candidates per crisis cell,
    which Python-side Hamming filtering dispatches in milliseconds.
    """
    from datetime import datetime, timedelta, timezone as _tz
    from app.services.phash import hamming_distance

    source = db.query(Media).filter(Media.id == media_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Media not found")
    if not source.photo_phash:
        # The row hasn't been scanned yet — no false "unique" claim.
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
                "created_at": m.created_at.isoformat() if m.created_at else None,
            })
    hits.sort(key=lambda x: x["hamming_distance"])
    return {
        "media_id": media_id,
        "phash": source.photo_phash,
        "threshold": threshold,
        "window_hours": window_hours,
        "candidates": hits,
    }


def _auto_assign_building_id(report: Report, db: Session):
    """Auto-link reports within 30m of each other to the same building_id."""
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
                report.building_id = n.building_id
                return
            else:
                import uuid
                bid = str(uuid.uuid4())
                report.building_id = bid
                n.building_id = bid
                return
