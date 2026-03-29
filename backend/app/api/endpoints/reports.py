import base64
import os
import time
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.report import Device, Report, Location, Media, AIAnalysis, MediaTypeEnum, ReportStatusEnum
from app.schemas.report import ReportCreate, ReportResponse
from app.services import ai_service

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


@router.post("/", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)

def create_report(report_in: ReportCreate, db: Session = Depends(get_db)):
    """
    Ingest a new multi-modal incident report locally.
    This endpoint supports rich JSON graphs combining GPS telemetry, 
    offline user classification, and associated base64 media blocks.
    """
    
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
        db_loc = Location(**report_in.location.model_dump(), report_id=db_report.id)
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
                    file_data = base64.b64decode(encoded)
                    
                    filename = f"{db_report.id}_{time.time()}.{ext}"
                    filepath = os.path.join(UPLOAD_DIR, filename)
                    with open(filepath, "wb") as f:
                        f.write(file_data)
                    file_url = f"/static/{filename}"
                except Exception as e:
                    print(f"Error handling base64 extract: {e}")
                    pass
                
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
    if audio_files:
        # Pass the first local audio to Whisper for offline NLP
        path = audio_files[0].replace("/static/", "")
        disk_path = os.path.join(UPLOAD_DIR, path)
        if os.path.exists(disk_path):
            ai_metadata["transcription"] = ai_service.transcribe_audio(disk_path)
            
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
