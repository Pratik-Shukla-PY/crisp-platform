import base64
import os
import time
import logging
import httpx
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

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
)
from app.services.ai_service import ai_service
from app.services.satellite_fetcher import satellite_fetcher
from app.services.truth_scorer import truth_scorer
from app.core.deps import get_optional_user, require_viewer, require_analyst, require_admin, require_super_admin

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

    # PII Protection: Auto-blur faces + PII text (GDPR/CCPA compliance)
    if media_type == 'IMAGE':
        try:
            from app.services.pii_blur import blur_pii
            pii_result = blur_pii(filepath)
            if pii_result.get("blurred"):
                logger.info(f"PII blurred in {filename}: faces={pii_result['faces']} pii_text={pii_result['pii_texts']}")
        except Exception as e:
            logger.warning(f"PII blur failed for {filename}: {e}")

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

    # PII Protection: blur faces even in partial images (shown on dashboard during upload)
    try:
        from app.services.pii_blur import blur_pii
        blur_pii(filepath)
    except Exception:
        pass  # Non-critical for partial images

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
def mark_false_alarm(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as a FALSE_ALARM without deleting it."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.FALSE_ALARM
    db.commit()
    db.refresh(report)
    return report


@router.patch("/{report_id}/dispatch", response_model=ReportResponse)
def dispatch_team(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Mark a report as RESPONDING — rescue team has been dispatched."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = ReportStatusEnum.RESPONDING
    db.commit()
    db.refresh(report)
    return report


@router.patch("/{report_id}/resolve", response_model=ReportResponse)
def resolve_report(report_id: str, user=Depends(require_analyst), db: Session = Depends(get_db)):
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


@router.get("/device/{device_hash}/status-since")
def get_device_status_since(device_hash: str, since: str = None, db: Session = Depends(get_db)):
    """Lightweight status polling for mobile apps. Returns only status fields."""
    device_id = _resolve_device_id(device_hash, db)
    if not device_id:
        return []
    q = db.query(Report).filter(Report.device_id == device_id)
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace('Z', '+00:00'))
            q = q.filter(Report.updated_at > since_dt)
        except Exception:
            pass
    reports = q.all()
    return [{"id": r.id, "client_report_id": r.client_report_id, "status": r.status.value,
             "severity": r.severity.value, "infrastructure_type": r.infrastructure_type.value,
             "lives_impacted": r.lives_impacted, "updated_at": r.updated_at.isoformat() if r.updated_at else None}
            for r in reports]


@router.patch("/{report_id}/impact")
def set_lives_impacted(report_id: str, payload: dict, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Set the number of lives impacted by this incident."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.lives_impacted = payload.get("lives_impacted", 0)
    db.commit()
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
    Uses per-report grace_minutes (default 24h, mobile=30min)."""
    now = datetime.now(timezone.utc)
    # Get all reports with deletion requested
    pending = db.query(Report).filter(Report.deletion_requested_at != None).all()
    expired = []
    for r in pending:
        grace = r.deletion_grace_minutes or 1440
        cutoff = r.deletion_requested_at.replace(tzinfo=timezone.utc) + timedelta(minutes=grace)
        if now >= cutoff:
            expired.append(r)
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
@router.post("/meta", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report_meta(meta_in: ReportMetaCreate, request: Request, db: Session = Depends(get_db)):
    """
    Stage 1 of progressive upload: Accept metadata only (< 1KB).
    Creates a PARTIAL report immediately. Media follows via PATCH.
    """
    # Rate limit: 30 reports/min per device
    from app.main import check_rate_limit
    if not check_rate_limit(f"meta:{meta_in.device_hash}", 30, 60):
        raise HTTPException(status_code=429, detail="Rate limit exceeded — try again later")

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
        report.crisis_type = request["crisis_type"]
    if "infrastructure_name" in request and request["infrastructure_name"]:
        report.infrastructure_name = request["infrastructure_name"]
    if "debris_clearing_needed" in request and request["debris_clearing_needed"] is not None:
        report.debris_clearing_needed = request["debris_clearing_needed"]
    if "service_status" in request and request["service_status"]:
        report.service_status = request["service_status"]
    db.commit()
    db.refresh(report)
    logger.info(f"Report {report.id} classified: sev={report.severity.value} type={report.infrastructure_type.value}")
    return report


@router.patch("/{report_id}/location", response_model=ReportResponse)
def update_report_location(report_id: str, loc_data: dict, db: Session = Depends(get_db)):
    """Add or update location on an existing report. Used by AI extractor for IVR/SMS."""
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
async def ai_assess_report(report_id: str, payload: dict, user=Depends(require_analyst), db: Session = Depends(get_db)):
    """Multi-signal intelligence assessment: builds 360° dossier and sends to Claude for analysis."""
    import httpx
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

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
  "inferred_crisis_type": "EARTHQUAKE | FLOOD | CONFLICT | HURRICANE | CYCLONE | WILDFIRE | LANDSLIDE | PANDEMIC | OTHER",
  "inferred_damage_class": "NO_DAMAGE | PARTIAL | COMPLETE",
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
                    report.crisis_type = inferred_crisis
                if inferred_damage:
                    report.damage_classification = inferred_damage

                db.commit()
                logger.info(f"AI assessment saved: {report_id} score={data.get('confidence_score','?')} priority={data.get('priority_level','?')}")
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
            # PII Protection: blur faces + PII text on single-file uploads
            if ext in ('jpg', 'jpeg', 'png'):
                try:
                    from app.services.pii_blur import blur_pii
                    pii_result = blur_pii(filepath)
                    if pii_result.get("blurred"):
                        logger.info(f"PII blurred in attached {filename}: faces={pii_result['faces']} text={pii_result['pii_texts']}")
                except Exception as e:
                    logger.warning(f"PII blur failed for {filename}: {e}")
            file_url = f"/static/{filename}"
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
            thumb_path = os.path.join(UPLOAD_DIR, filename)
            with open(thumb_path, "wb") as f:
                f.write(thumb_bytes)
            # PII blur on thumbnail too
            try:
                from app.services.pii_blur import blur_pii
                blur_pii(thumb_path)
            except Exception:
                pass
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
def get_reports(skip: int = 0, limit: int = 100, include_deleted: bool = False,
                user=Depends(require_viewer), db: Session = Depends(get_db)):
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


# ═══════════════════════════════════════════════════════════════════════════════
# GAMIFICATION: Reporter profiles with badge progression
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/profile/{device_hash}")
def get_reporter_profile(device_hash: str, db: Session = Depends(get_db)):
    """Get reporter's gamification profile (badge level, report count, impact)."""
    from app.models.report import ReporterProfile
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        profile = ReporterProfile(device_hash=device_hash, report_count=0, badge_level="NEWCOMER", impact_score=0)
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return {
        "device_hash": profile.device_hash,
        "report_count": profile.report_count,
        "verified_count": profile.verified_count,
        "badge_level": profile.badge_level,
        "impact_score": profile.impact_score,
    }


def _update_reporter_profile(device_hash: str, db: Session):
    """Increment reporter's profile on report submission. Badge tiers: 1=NEWCOMER, 3=HELPER, 10=GUARDIAN, 25=HERO."""
    from app.models.report import ReporterProfile
    profile = db.query(ReporterProfile).filter(ReporterProfile.device_hash == device_hash).first()
    if not profile:
        profile = ReporterProfile(device_hash=device_hash)
        db.add(profile)
    profile.report_count = (profile.report_count or 0) + 1
    count = profile.report_count
    if count >= 25:
        profile.badge_level = "HERO"
    elif count >= 10:
        profile.badge_level = "GUARDIAN"
    elif count >= 3:
        profile.badge_level = "HELPER"
    else:
        profile.badge_level = "NEWCOMER"


# ═══════════════════════════════════════════════════════════════════════════════
# BUILDING VERSIONING: Group multiple reports about the same structure
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/building/{building_id}")
def get_building_history(building_id: str, db: Session = Depends(get_db)):
    """Get all reports linked to a building, ordered by time (damage progression)."""
    reports = db.query(Report).filter(
        Report.building_id == building_id,
        Report.deletion_requested_at.is_(None)
    ).order_by(Report.server_created_at.asc()).all()
    return [ReportResponse.model_validate(r) for r in reports]


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
