import base64
import os
import time
import logging
import httpx
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.report import Device, Report, Location, Media, AIAnalysis, MediaTypeEnum, ReportStatusEnum, SyncStatusEnum
from app.schemas.report import ReportCreate, ReportResponse, ReportMetaCreate, MediaAttach
from app.services.ai_service import ai_service

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


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


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(report_id: str, db: Session = Depends(get_db)):
    """Permanently delete a report and its associated media files."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    # Clean up media files from disk
    for m in report.media:
        if m.url and m.url.startswith("/static/"):
            disk_path = os.path.join(UPLOAD_DIR, m.url.replace("/static/", ""))
            if os.path.exists(disk_path):
                try:
                    os.remove(disk_path)
                except Exception as e:
                    print(f"Error removing file {disk_path}: {e}")
    db.delete(report)
    db.commit()
    return


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
def get_reports(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """
    Retrieve aggregated tactical reports for the dashboard sync client.
    """
    reports = db.query(Report).order_by(Report.server_created_at.desc()).offset(skip).limit(limit).all()
    return reports
