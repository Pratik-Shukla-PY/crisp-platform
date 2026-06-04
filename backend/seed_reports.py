"""Seed a handful of interactive reports for local UI testing.

Apr 2026: ported from raw `sqlite3` imports to SQLAlchemy ORM so the
script works on both SQLite (local dev zero-install default) AND
PostgreSQL (full-switch production and dev-via-brew path). The previous
implementation hard-coded `sqlite3.connect("crisp_local.db")` which died
the moment `DATABASE_URL=postgresql://...` was exported.

Behaviour unchanged — inserts 4 reports (ROAD/HOSPITAL/WATER/HOUSE),
each with a location row, a seeded media row (legacy schema; modern
chunked-upload flow doesn't use this), and an AI-analysis row. Idempotent
on a per-device basis via a stable `seed-device-123` device_hash: re-runs
append new reports, they don't update existing ones — if you want a
clean slate, drop + recreate the DB first.

Run via:
    source venv/bin/activate
    export DATABASE_URL="..."   # optional, defaults to SQLite
    python seed_reports.py
"""
import time
from datetime import datetime, timezone

from app.db.session import SessionLocal, engine
from app.models.report import (
    Device, Report, Location, Media, AIAnalysis,
    SourceEnum, SeverityEnum, ReportStatusEnum,
    SyncStatusEnum, InfraTypeEnum, MediaTypeEnum, ResolutionEnum,
)


def _ensure_device(db, device_hash: str, platform: str = "SEEDER") -> Device:
    """Idempotent device lookup — matches the existing-device bootstrap
    logic in app.api.endpoints.reports so seeded rows aren't dissociated
    from the real device flow."""
    existing = db.query(Device).filter(Device.device_hash == device_hash).first()
    if existing:
        return existing
    dev = Device(device_hash=device_hash, platform=platform)
    db.add(dev)
    db.commit()
    db.refresh(dev)
    return dev


def _add_report(db, device: Device, infra_type: InfraTypeEnum,
                severity: SeverityEnum, description: str) -> Report:
    now = datetime.now(timezone.utc)
    report = Report(
        device_id=device.id,
        source=SourceEnum.APP,
        status=ReportStatusEnum.PENDING,
        sync_status=SyncStatusEnum.SYNCED,
        severity=severity,
        infrastructure_type=infra_type,
        description=description,
        expected_media=1,
        received_media=1,
        client_created_at=now,
    )
    db.add(report)
    db.flush()

    # Rough-distributed test coordinates — not remotely accurate, fine for
    # dashboard smoke tests + heatmap debugging.
    db.add(Location(
        report_id=report.id,
        latitude=20.0 + (time.time() % 1),
        longitude=0.0 + (time.time() % 1),
    ))

    db.add(Media(
        report_id=report.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.LOW,
        url="/static/seed_img.jpg",
        is_synced=True,
        chunk_count=0,
        received_chunks=0,
        completion_pct=100.0,
        assembly_status="complete",
        client_blur_applied=False,
    ))

    db.add(AIAnalysis(
        report_id=report.id,
        damage_score=0.8,
        transcription="This is a seeded transcription for testing triage.",
    ))

    db.commit()
    return report


def main():
    # Smoke check — if the tables haven't been created yet (either by
    # `alembic upgrade head` or the dev-mode `Base.metadata.create_all`),
    # bail instead of crashing with an opaque IntegrityError.
    from sqlalchemy import inspect
    inspector = inspect(engine)
    if "reports" not in inspector.get_table_names():
        print("Tables not present — run `alembic upgrade head` first.")
        return

    db = SessionLocal()
    try:
        device = _ensure_device(db, "seed-device-123")
        samples = [
            (InfraTypeEnum.ROAD,     SeverityEnum.SEVERE,   "Bridge collapse near Sector 7. Immediate attention needed."),
            (InfraTypeEnum.HOSPITAL, SeverityEnum.CRITICAL, "Power failure in emergency ward. Critical medical assets at risk."),
            (InfraTypeEnum.WATER,    SeverityEnum.MODERATE, "Major pipe burst on High Street. Multiple residential areas affected."),
            (InfraTypeEnum.HOUSE,    SeverityEnum.MINOR,    "Minor structural damage reported in suburbia."),
        ]
        for infra, sev, desc in samples:
            _add_report(db, device, infra, sev, desc)
        print(f"Success: Seeded {len(samples)} interactive reports "
              f"against {engine.url.drivername}.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
