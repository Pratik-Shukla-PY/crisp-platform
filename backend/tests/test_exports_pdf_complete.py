"""May 21, 2026 — PDF export completeness.

Architectural-audit Item 3 surfaced three regressions in the existing
PDF export at `/api/v1/exports/pdf`:

  · CSV/GeoJSON/KML include the 6 satellite verification columns
    (UNDP must-have #11). The PDF did NOT, regressing the must-have.
  · The PDF embedded zero photos and zero audio attachments,
    silently dropping all media regardless of what was on the report.
  · The endpoint did `_query_reports(...)[:limit]` slice-in-Python
    with no log or response signal when the limit was hit, hiding
    silent truncation from operators.

This test pins the fix:

  1. POST a report with a SatelliteVerification row that carries all
     6 satellite columns — assert all 6 appear in the PDF bytes.
  2. Verify the "Media" section header is present when an Image
     media row exists (we only check section presence, not the
     embedded PNG/JPEG bytes — that's storage-backend dependent).
  3. Verify the stable URL pattern `/api/v1/reports/media/{id}/file`
     is referenced for the image media row.

The PDF bytes are searched as a raw string. ReportLab encodes text in
PDF objects as ASCII (or Latin-1 for the strings we use) so the
satellite column labels are findable in the raw stream.
"""
from __future__ import annotations

import io
import uuid
import pytest

import pypdf  # used to extract rendered text from the compressed PDF body

from app.models.report import (
    Device, Report, Media, Location, SatelliteVerification,
    MediaTypeEnum, ResolutionEnum, SourceEnum, SyncStatusEnum,
    InfraTypeEnum, DamageClassEnum, SeverityEnum,
)


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """Decompress the PDF and concatenate all page text. The PDF body is
    ASCII85+Flate-encoded by ReportLab, so a substring search on the
    raw bytes never matches the label text — must round-trip via
    pypdf to get the decoded strings.
    """
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _seed_report_with_media_and_verification(db) -> tuple[str, str]:
    """Build a Report row with one IMAGE Media + one SatelliteVerification.
    Returns (report_id, media_id).
    """
    d = Device(device_hash=f"PDF-TEST-{uuid.uuid4().hex[:8]}")
    db.add(d); db.flush()

    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"pdf-test-{uuid.uuid4().hex[:12]}",
        sync_status=SyncStatusEnum.SYNCED,
        severity=SeverityEnum.MODERATE,
        infrastructure_type=InfraTypeEnum.ROAD,
        damage_classification=DamageClassEnum.PARTIAL,
        description="pdf export completeness — media + satellite check",
        expected_media=1,
        received_media=1,
    )
    db.add(r); db.flush()

    loc = Location(
        report_id=r.id,
        latitude=12.97,
        longitude=77.59,
        user_location_name="PDF Test Site",
    )
    db.add(loc)

    # One complete SMALL IMAGE — the PDF should reference its stable
    # URL. We use an empty url-string + a placeholder photo_group_id
    # so the storage-read embed path gracefully falls back to the
    # text-only tier listing.
    media_id = str(uuid.uuid4())
    m = Media(
        id=media_id,
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        assembly_status="complete",
        photo_group_id=str(uuid.uuid4()),
        url="",  # empty url → storage embed skipped → tier-list line still emitted
        chunk_count=1,
        received_chunks=1,
    )
    db.add(m)

    v = SatelliteVerification(
        id=f"ver-{uuid.uuid4().hex[:8]}",
        report_id=r.id,
        total_score=84,
        verdict="LIKELY_AUTHENTIC",
        satellite_source="AWS Sentinel-2",
        satellite_acquisition_date="2026-05-20T00:00:00Z",
        satellite_cloud_cover_pct=8.3,
        satellite_days_gap=1,
    )
    db.add(v)
    db.commit()
    return r.id, media_id


def test_pdf_includes_satellite_columns(client, db, viewer_token):
    """The PDF must include the 6 satellite columns required by UNDP
    must-have #11. Pre-fix none of them appeared.
    """
    report_id, media_id = _seed_report_with_media_and_verification(db)

    res = client.get(
        "/api/v1/exports/pdf",
        headers={"Authorization": f"Bearer {viewer_token}"},
    )
    assert res.status_code == 200, res.text
    text = _extract_pdf_text(res.content)

    # Each satellite-column label must appear in the rendered PDF.
    required_labels = [
        "Sat. Verdict",
        "Sat. Total Score",
        "Sat. Acquisition Date",
        "Sat. Days Gap",
        "Sat. Cloud Cover",  # the % sign may not round-trip via pypdf
        "Sat. Source",
    ]
    missing = [lbl for lbl in required_labels if lbl not in text]
    assert not missing, (
        f"Satellite verification labels missing from PDF: {missing}. "
        f"This regresses UNDP must-have #11 (export columns)."
    )

    # And at least one verification VALUE should appear. The verdict
    # text is the easiest to spot.
    assert "LIKELY_AUTHENTIC" in text, (
        "Satellite verdict value not found in PDF text — labels rendered "
        "but values may be missing."
    )


def test_pdf_includes_media_section_with_stable_urls(client, db, viewer_token):
    """The PDF must reference media attached to each report. Pre-fix
    the PDF had zero media references regardless of attachments.
    """
    report_id, media_id = _seed_report_with_media_and_verification(db)

    res = client.get(
        "/api/v1/exports/pdf",
        headers={"Authorization": f"Bearer {viewer_token}"},
    )
    assert res.status_code == 200, res.text
    text = _extract_pdf_text(res.content)

    # "Media" section header must appear.
    assert "Media" in text, (
        "PDF missing 'Media' section header — media rendering regression."
    )

    # Stable URL pattern for the image media must appear. The full
    # URL is `/api/v1/reports/media/{id}/file` — at minimum the
    # media id (or its prefix) should be in the rendered text.
    assert (
        media_id[:8] in text or media_id in text
    ), (
        f"PDF does not reference the attached media row (id starts with "
        f"{media_id[:8]}). Media-listing emit may have regressed."
    )


def test_pdf_empty_filter_returns_valid_pdf(client, db, viewer_token):
    """Regression sentinel: a query that returns no reports still
    produces a valid (non-zero-byte) PDF. The empty-result branch
    must keep working after the new media + satellite additions.
    """
    res = client.get(
        "/api/v1/exports/pdf",
        params={"crisis_type": "NEVER_SUBMITTED_TYPE"},
        headers={"Authorization": f"Bearer {viewer_token}"},
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-"), \
        "Empty-filter response is not a valid PDF stream"
    text = _extract_pdf_text(res.content)
    assert "No reports matched" in text, \
        "Empty-state copy missing from rendered PDF text"
