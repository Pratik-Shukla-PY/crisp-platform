import base64
import os
import time
import logging
import httpx
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.report import (
    Device, Report, Location, Media, MediaChunk, AIAnalysis,
    SatelliteVerification,
    MediaTypeEnum, ResolutionEnum, ReportStatusEnum, SyncStatusEnum,
)
from app.schemas.report import (
    ReportCreate, ReportResponse, ReportMetaCreate, MediaAttach,
    ReportDescriptionUpdate, ThumbnailPayload, MediaChunkPayload,
    VerificationResponse,
)
from app.services.ai_service import ai_service
from app.services.satellite_fetcher import satellite_fetcher
from app.services.truth_scorer import truth_scorer

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ── Data Integrity ────────────────────────────────────────────────────────────
def djb2_checksum(s: str) -> str:
    """djb2 hash — matches client-side simpleChecksum() in app.js (PRD §3.7)."""
    h = 5381
    for c in s:
        h = ((h << 5) + h) ^ ord(c)
        h &= 0xFFFFFFFF
    return format(h, '08x')


def _assemble_media_file(media_id: str, media_type: str, db: Session) -> Optional[str]:
    """Concatenate all received base64 chunks in seq order and write to disk."""
    chunks = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id
    ).order_by(MediaChunk.seq_num).all()

    if not chunks:
        return None

    full_b64 = ''.join(c.data_b64 for c in chunks)
    # Ensure valid base64 padding
    padding = (4 - len(full_b64) % 4) % 4
    full_b64 += '=' * padding

    try:
        file_bytes = base64.b64decode(full_b64)
    except Exception as e:
        logger.error(f"Base64 reassembly failed for {media_id}: {e}")
        return None

    ext = 'jpg' if media_type == 'IMAGE' else 'webm'
    filename = f"{media_id}_assembled.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(file_bytes)

    logger.info(f"Assembled {media_id}: {len(file_bytes):,} bytes → {filename}")
    return f"/static/{filename}"


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

    # Collect only consecutive chunks (stop at first gap — no gaps in partial JPEG)
    parts = []
    expected_seq = 0
    for c in chunks:
        if c.seq_num != expected_seq:
            break
        parts.append(c.data_b64)
        expected_seq += 1

    if not parts:
        return None

    full_b64 = ''.join(parts)
    # Add padding — partial base64 may not be aligned to 4-char boundary
    padding = (4 - len(full_b64) % 4) % 4
    full_b64 += '=' * padding

    try:
        file_bytes = base64.b64decode(full_b64)
    except Exception as e:
        logger.warning(f"Partial assembly decode failed for {media_id}: {e}")
        return None

    filename = f"{media_id}_partial.jpg"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(file_bytes)

    logger.info(f"Partial image updated: {media_id} ({len(parts)} chunks, {len(file_bytes):,} bytes)")
    return f"/static/{filename}"


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

    # Collect only consecutive chunks (stop at first gap)
    parts = []
    expected_seq = 0
    for c in chunks:
        if c.seq_num != expected_seq:
            break
        parts.append(c.data_b64)
        expected_seq += 1

    if not parts:
        return None

    full_b64 = ''.join(parts)
    padding = (4 - len(full_b64) % 4) % 4
    full_b64 += '=' * padding

    try:
        file_bytes = base64.b64decode(full_b64)
    except Exception as e:
        logger.warning(f"Partial audio decode failed for {media_id}: {e}")
        return None

    filename = f"{media_id}_partial.webm"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(file_bytes)

    logger.info(f"Partial audio updated: {media_id} ({len(parts)} chunks, {len(file_bytes):,} bytes)")
    return f"/static/{filename}"


def _run_partial_transcription_bg(report_id: str, partial_url: str):
    """Background task: transcribe partial audio to English as chunks arrive."""
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        disk_path = os.path.join(UPLOAD_DIR, partial_url.replace("/static/", ""))
        if not os.path.exists(disk_path):
            return
        text = ai_service.transcribe_audio_partial(disk_path, translate_to_english=True)
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


def _run_ai_pipeline(report_id: str, media_type: str, file_url: str, db: Session):
    """Trigger transcription or image analysis after media assembly."""
    disk_path = os.path.join(UPLOAD_DIR, file_url.replace("/static/", ""))
    if not os.path.exists(disk_path):
        return

    if media_type == 'AUDIO':
        transcription = ai_service.transcribe_audio(disk_path)
        if transcription:
            ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report_id).first()
            if ai:
                ai.transcription = transcription
            else:
                db.add(AIAnalysis(report_id=report_id, transcription=transcription))
            db.commit()
    elif media_type == 'IMAGE':
        vision = ai_service.analyze_image(disk_path)
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


@router.patch("/{report_id}/false-alarm", response_model=ReportResponse)
def mark_false_alarm(report_id: str, db: Session = Depends(get_db)):
    """Mark a report as a FALSE_ALARM without deleting it."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.FALSE_ALARM
    db.commit()
    db.refresh(report)
    return report


@router.patch("/{report_id}/dispatch", response_model=ReportResponse)
def dispatch_team(report_id: str, db: Session = Depends(get_db)):
    """Mark a report as RESPONDING — rescue team has been dispatched."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.RESPONDING
    db.commit()
    db.refresh(report)
    return report


@router.patch("/{report_id}/resolve", response_model=ReportResponse)
def resolve_report(report_id: str, db: Session = Depends(get_db)):
    """Mark a report as RESOLVED — situation handled."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.RESOLVED
    db.commit()
    db.refresh(report)
    return report


def _resolve_device_id(device_hash: str, db: Session) -> Optional[str]:
    """Resolve a client-side device_hash (e.g. DEV-XXXXXXXX) to the internal device UUID."""
    device = db.query(Device).filter(Device.device_hash == device_hash).first()
    if device:
        return device.id
    # Fallback: try direct match on device_id (for backward compatibility)
    existing = db.query(Report).filter(Report.device_id == device_hash).first()
    return device_hash if existing else None


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


@router.delete("/{report_id}", status_code=status.HTTP_200_OK)
def delete_report(report_id: str, db: Session = Depends(get_db)):
    """Soft-delete: mark report for deletion with 24-hour grace period.
    The record is hidden from active views immediately. After 24 hours,
    a background purge job permanently deletes it and all associated files."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.deletion_requested_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(f"Soft-delete requested for report {report_id} — permanent deletion in 24h")
    return {"id": report_id, "deletion_requested_at": report.deletion_requested_at.isoformat(), "message": "Your data will be permanently deleted within 24 hours."}


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
    """Permanently delete all reports whose 24-hour grace period has expired.
    Called by background cron job."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    expired = db.query(Report).filter(
        Report.deletion_requested_at != None,
        Report.deletion_requested_at <= cutoff
    ).all()
    if not expired:
        return 0
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
        db.delete(report)
        count += 1
    db.commit()
    if count > 0:
        logger.info(f"Purge: {count} expired deletion(s) permanently removed")
    return count


@router.post("/purge-expired", status_code=status.HTTP_200_OK)
def purge_expired_deletions(db: Session = Depends(get_db)):
    """Admin endpoint: permanently delete all reports past the 24-hour grace period."""
    count = _purge_expired_deletions(db)
    return {"purged": count}


# ── Progressive Upload: Stage 1 — metadata only (tiny, instant) ───────────────
@router.post("/meta", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report_meta(meta_in: ReportMetaCreate, db: Session = Depends(get_db)):
    """
    Stage 1 of progressive upload: Accept metadata only (< 1KB).
    Creates a PARTIAL report immediately. Media follows via PATCH.
    """
    # Idempotency check
    if meta_in.client_report_id:
        existing = db.query(Report).filter(
            Report.client_report_id == meta_in.client_report_id
        ).first()
        if existing:
            logger.info(f"Meta idempotent hit: {meta_in.client_report_id}")
            return existing

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
    db_report = Report(**report_dict, device_id=device.id, received_media=0, sync_status=sync)
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
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report.id} classified: sev={report.severity.value} type={report.infrastructure_type.value}")
    return report


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

    # Decode and save the base64 media to disk
    file_url = media_in.url
    if media_in.url.startswith("data:"):
        try:
            header, encoded = media_in.url.split(",", 1)
            ext = "jpg" if "image" in header else "webm"
            file_data = base64.b64decode(encoded)
            if not file_data:
                raise ValueError("Empty base64 data")
            filename = f"{report.id}_{time.time()}.{ext}"
            filepath = os.path.join(UPLOAD_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(file_data)
            logger.info(f"Attached {ext}: {filename} ({len(file_data)} bytes)")
            file_url = f"/static/{filename}"
        except Exception as e:
            logger.error(f"Media attach decode error: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to decode media: {str(e)}")

    # Save media record
    db_media = Media(
        report_id=report.id,
        type=media_in.type,
        resolution_tier=media_in.resolution_tier,
        url=file_url,
        file_size_bytes=media_in.file_size_bytes,
        is_synced=True
    )
    db.add(db_media)

    # Update received count
    report.received_media = (report.received_media or 0) + 1

    # Check if all expected media received → mark SYNCED
    if report.received_media >= report.expected_media:
        report.sync_status = SyncStatusEnum.SYNCED
        logger.info(f"Report {report.id} fully synced ({report.received_media}/{report.expected_media} media)")
    else:
        logger.info(f"Report {report.id} partial ({report.received_media}/{report.expected_media} media)")

    db.commit()

    # Trigger AI pipeline for this specific media
    if media_in.type == MediaTypeEnum.AUDIO and file_url.startswith("/static/"):
        disk_path = os.path.join(UPLOAD_DIR, file_url.replace("/static/", ""))
        if os.path.exists(disk_path):
            logger.info(f"Transcribing attached audio: {disk_path}")
            transcription = ai_service.transcribe_audio(disk_path)
            if transcription:
                # Create or update AI analysis
                ai = db.query(AIAnalysis).filter(AIAnalysis.report_id == report.id).first()
                if ai:
                    ai.transcription = transcription
                else:
                    ai = AIAnalysis(report_id=report.id, transcription=transcription)
                    db.add(ai)
                db.commit()

    elif media_in.type == MediaTypeEnum.IMAGE and file_url.startswith("/static/"):
        disk_path = os.path.join(UPLOAD_DIR, file_url.replace("/static/", ""))
        if os.path.exists(disk_path):
            vision_result = ai_service.analyze_image(disk_path)
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

    # Decode and save thumbnail
    thumbnail_url = None
    if payload.thumbnail_data.startswith("data:"):
        try:
            _, b64 = payload.thumbnail_data.split(",", 1)
            padding = (4 - len(b64) % 4) % 4
            thumb_bytes = base64.b64decode(b64 + '=' * padding)
            filename = f"{payload.media_id}_thumb.jpg"
            with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
                f.write(thumb_bytes)
            thumbnail_url = f"/static/{filename}"
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
            resolution_tier=ResolutionEnum.MEDIUM,
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
    db: Session = Depends(get_db)
):
    """
    Receive one ~1KB packet of media data with sequence number and checksum.
    - Verifies checksum for data integrity (PRD §3.7)
    - Idempotent: duplicate packets are silently ignored
    - Assembles full file when all chunks received
    - Triggers AI pipeline in background (non-blocking — P-1 fix)
    - Returns completion_pct for client progress tracking
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Integrity check (PRD §3.7)
    if payload.checksum:
        computed = djb2_checksum(payload.data)
        if computed != payload.checksum:
            raise HTTPException(
                status_code=400,
                detail=f"Checksum mismatch seq={payload.seq_num}: expected {payload.checksum}, got {computed}"
            )

    # Find or create the Media record for this upload session
    media = db.query(Media).filter(Media.id == payload.media_id).first()
    if not media:
        media = Media(
            id=payload.media_id,
            report_id=report_id,
            type=payload.type,
            resolution_tier=ResolutionEnum.MEDIUM,   # P-2 fix: use enum not string
            url='',
            is_synced=False,
            chunk_count=payload.total_chunks,
            received_chunks=0,
            completion_pct=0.0,
            assembly_status='pending'
        )
        db.add(media)
        db.flush()

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

    # Progressive partial assembly every 3 new chunks for smooth real-time preview
    if (is_new_chunk and
        payload.type == MediaTypeEnum.IMAGE and
        media.received_chunks >= 3 and
        media.received_chunks % 3 == 0 and
        media.assembly_status != 'complete'):
        try:
            partial_url = _assemble_partial_image(payload.media_id, db)
            if partial_url:
                media.thumbnail_url = partial_url
                db.commit()
        except Exception as e:
            logger.warning(f"Partial image assembly skipped: {e}")

    # Progressive partial audio assembly every 5 chunks for streaming preview
    if (is_new_chunk and
        payload.type == MediaTypeEnum.AUDIO and
        media.received_chunks >= 5 and
        media.received_chunks % 5 == 0 and
        media.assembly_status != 'complete'):
        try:
            partial_url = _assemble_partial_audio(payload.media_id, db)
            if partial_url:
                media.thumbnail_url = partial_url
                db.commit()
                # Live transcription: translate partial audio to English in background
                background_tasks.add_task(
                    _run_partial_transcription_bg, report_id, partial_url
                )
        except Exception as e:
            logger.warning(f"Partial audio assembly skipped: {e}")

    # Full assembly when all chunks received (PRD §3.6)
    if media.received_chunks >= payload.total_chunks and media.assembly_status != 'complete':
        try:
            file_url = _assemble_media_file(payload.media_id, payload.type.value, db)
            if file_url:
                media.url = file_url
                media.assembly_status = 'complete'
                media.is_synced = True
                media.completion_pct = 100.0
                report.received_media = (report.received_media or 0) + 1
                if report.received_media >= report.expected_media:
                    report.sync_status = SyncStatusEnum.SYNCED
                    logger.info(f"Report {report_id} fully synced after chunk assembly")
                db.commit()
                # P-1 fix: AI pipeline runs in background — never blocks the HTTP response
                background_tasks.add_task(
                    _run_ai_pipeline_bg, report_id, payload.type.value, file_url
                )
        except Exception as e:
            logger.error(f"Assembly error for {payload.media_id}: {e}")

    return {
        "media_id": payload.media_id,
        "seq_num": payload.seq_num,
        "received": media.received_chunks,
        "total": payload.total_chunks,
        "completion_pct": media.completion_pct,
        "assembly_status": media.assembly_status
    }


@router.post("/", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report(report_in: ReportCreate, db: Session = Depends(get_db)):
    """
    Ingest a new multi-modal incident report locally.
    This endpoint supports rich JSON graphs combining GPS telemetry, 
    offline user classification, and associated base64 media blocks.
    """
    
    # 0. Idempotency Check — prevent duplicate submissions on retry
    if report_in.client_report_id:
        existing = db.query(Report).filter(
            Report.client_report_id == report_in.client_report_id
        ).first()
        if existing:
            logger.info(f"Idempotent hit: client_report_id={report_in.client_report_id}, returning existing report {existing.id}")
            return existing

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
                    ext = "jpg" if "image" in header else "webm"

                    # Decode base64
                    try:
                        file_data = base64.b64decode(encoded)
                    except Exception as decode_err:
                        logger.error(f"Base64 decode error for {ext}: {decode_err}")
                        file_data = b""

                    if not file_data:
                        logger.warning(f"Empty file data for {ext}")
                        raise ValueError("Base64 decoding produced empty data")

                    filename = f"{db_report.id}_{time.time()}.{ext}"
                    filepath = os.path.join(UPLOAD_DIR, filename)

                    # Write file
                    with open(filepath, "wb") as f:
                        bytes_written = f.write(file_data)

                    logger.info(f"Saved {ext} file: {filename} ({len(file_data)} bytes, {bytes_written} written)")
                    file_url = f"/static/{filename}"

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
def get_reports(skip: int = 0, limit: int = 100, include_deleted: bool = False, db: Session = Depends(get_db)):
    """
    Retrieve aggregated tactical reports for the dashboard sync client.
    By default, excludes reports pending deletion (24h grace period).
    Pass ?include_deleted=true to see them (admin use).
    """
    q = db.query(Report)
    if not include_deleted:
        q = q.filter(Report.deletion_requested_at == None)
    reports = q.order_by(Report.server_created_at.desc()).offset(skip).limit(limit).all()
    return reports


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

    # Save satellite image to disk so the frontend can display it
    sat_image_url: Optional[str] = None
    try:
        sat_bytes = base64.b64decode(sat_data["image_b64"])
        ext       = "png" if "png" in sat_data.get("image_media_type", "image/png") else "jpg"
        sat_fname = f"sat_{report_id}.{ext}"
        sat_path  = os.path.join(UPLOAD_DIR, sat_fname)
        with open(sat_path, "wb") as fh:
            fh.write(sat_bytes)
        sat_image_url = f"/static/{sat_fname}"
        logger.info(f"Satellite image saved: {sat_fname} ({len(sat_bytes):,} bytes)")
    except Exception as exc:
        logger.warning(f"Could not save satellite image: {exc}")

    # ── Find user photo on disk ───────────────────────────────────────────────
    user_image_path: Optional[str] = None
    img_media = next(
        (m for m in report.media if m.type == MediaTypeEnum.IMAGE and m.url), None
    )
    if img_media:
        candidate = os.path.join(UPLOAD_DIR, img_media.url.replace("/static/", ""))
        if os.path.exists(candidate):
            user_image_path = candidate

    # ── Run AI scoring ───────────────────────────────────────────────────────
    has_audio = any(m.type == MediaTypeEnum.AUDIO for m in report.media)
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

    # Save alternate satellite source (e.g. Mapbox when Sentinel is primary)
    alt = sat_data.get("alt")
    if alt:
        try:
            alt_bytes = base64.b64decode(alt["image_b64"])
            alt_ext   = "png" if "png" in alt.get("image_media_type", "image/jpeg") else "jpg"
            alt_fname = f"sat_alt_{report_id}.{alt_ext}"
            alt_path  = os.path.join(UPLOAD_DIR, alt_fname)
            with open(alt_path, "wb") as fh:
                fh.write(alt_bytes)
            v.satellite_image_url_alt      = f"/static/{alt_fname}"
            v.satellite_source_alt         = alt.get("source")
            v.satellite_acquisition_date_alt = alt.get("acquisition_date")
            v.satellite_resolution_m_alt   = alt.get("resolution_m")
            logger.info(f"Alt satellite image saved: {alt_fname}")
        except Exception as exc:
            logger.warning(f"Could not save alt satellite image: {exc}")

    db.commit()
    db.refresh(v)
    return v
