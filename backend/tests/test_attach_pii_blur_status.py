"""K.2.b (May 2026, Phase K) — PII blur status tracked on Media row
created via the /attach single-shot path.

Before this fix, the /attach handler at reports.py:2603-2620 swallowed
all blur outcomes silently:
    try:
        pii_result = blur_pii(...)
    except Exception:
        logger.warning(...)   # nothing recorded on Media

If blur raised (e.g. MediaPipe missing on host), the unblurred bytes
were saved as-is and the Media.pii_blur_status column stayed NULL.
Operator dashboard had no signal — image rendered with faces visible,
no warning chip.

Fix: the /attach flow mirrors the chunked-assembly outcome state
machine (reports.py:650-740). Vocabulary refreshed by B-A (alembic
0037) to the canonical 4-state taxonomy:
    'complete_with_redactions' — blur ran AND something was redacted
    'complete_clean'           — blur ran, NO PII detected
    'failed'                   — backends unavailable OR exception;
                                 file as-is, operator review needed
    'not_needed'               — non-image media (audio)

Positive assertions:
  - IMAGE + valid blur w/ detections → 'complete_with_redactions'
  - IMAGE + valid blur w/o detections → 'complete_clean'
  - IMAGE + blur backends unavailable (ran=False) → 'failed'
  - IMAGE + blur raises → 'failed' + image still saved
  - AUDIO → 'not_needed'
"""
from __future__ import annotations

import pytest
from unittest.mock import patch

from app.models.report import (
    Device,
    Report,
    Media,
    SourceEnum,
    SyncStatusEnum,
)


_TINY_IMG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)
_TINY_AUDIO = (
    "data:audio/ogg;base64,"
    "T2dnUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)


def _seed_report(db, *, device_hash):
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k2b-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


# ── K.2.b positive assertions ────────────────────────────────────────────────


def test_image_attach_with_blur_success_sets_complete_with_redactions(client, db):
    """blur_pii returns ran=True, blurred=True → 'complete_with_redactions'."""
    r = _seed_report(db, device_hash="k2b-blur-complete")

    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 1,
            "pii_texts": 0,
            "blurred": True,
            "error": None,
            "ran": True,
            "backends": {"face_detector": True, "ocr_reader": True},
        }
        res = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "SMALL",
                "file_size_bytes": 95,
            },
        )
    assert res.status_code == 200, f"got {res.status_code} body={res.text}"

    db.expire_all()
    media = db.query(Media).filter_by(report_id=r.id).first()
    assert media is not None
    assert media.pii_blur_status == 'complete_with_redactions', (
        f"Expected pii_blur_status='complete_with_redactions', got {media.pii_blur_status!r}"
    )


def test_image_attach_with_blur_ran_no_pii_sets_complete_clean(client, db):
    """blur_pii returns ran=True, blurred=False (clean image) → 'complete_clean'."""
    r = _seed_report(db, device_hash="k2b-blur-clean")

    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 0,
            "pii_texts": 0,
            "blurred": False,
            "error": None,
            "ran": True,
            "backends": {"face_detector": True, "ocr_reader": True},
        }
        res = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "SMALL",
                "file_size_bytes": 95,
            },
        )
    assert res.status_code == 200

    db.expire_all()
    media = db.query(Media).filter_by(report_id=r.id).first()
    assert media.pii_blur_status == 'complete_clean'


def test_image_attach_with_backends_unavailable_sets_failed(client, db):
    """blur_pii returns ran=False (backends missing) → 'failed' (was 'skipped' pre-0037)."""
    r = _seed_report(db, device_hash="k2b-blur-skipped")

    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 0,
            "pii_texts": 0,
            "blurred": False,
            "error": "PII-blur backends unavailable (test).",
            "ran": False,
            "backends": {"face_detector": False, "ocr_reader": False},
        }
        res = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "SMALL",
                "file_size_bytes": 95,
            },
        )
    assert res.status_code == 200

    db.expire_all()
    media = db.query(Media).filter_by(report_id=r.id).first()
    assert media is not None
    assert media.pii_blur_status == 'failed', (
        f"backends-unavailable should set 'failed' (B-A canonical taxonomy), "
        f"got {media.pii_blur_status!r}"
    )


def test_image_attach_with_blur_exception_sets_failed(client, db):
    """blur_pii raises → pii_blur_status='failed' + image still saved."""
    r = _seed_report(db, device_hash="k2b-blur-failed")

    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.side_effect = RuntimeError("simulated blur failure")
        res = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "SMALL",
                "file_size_bytes": 95,
            },
        )
    assert res.status_code == 200, f"attach should still succeed; got {res.status_code}"

    db.expire_all()
    media = db.query(Media).filter_by(report_id=r.id).first()
    assert media is not None
    assert media.pii_blur_status == 'failed', (
        f"blur exception should set 'failed', got {media.pii_blur_status!r}"
    )
    # Image is still saved (unblurred) — operator sees the chip + can decide
    assert media.url, "Media row should still have a URL even when blur failed"


def test_audio_attach_sets_not_needed(client, db):
    """Audio media path → pii_blur_status='not_needed' (no blur applies)."""
    r = _seed_report(db, device_hash="k2b-audio-notneeded")

    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "AUDIO",
            "url": _TINY_AUDIO,
            "resolution_tier": "SMALL",
            "file_size_bytes": 48,
        },
    )
    assert res.status_code == 200, f"got {res.status_code} body={res.text}"

    db.expire_all()
    media = db.query(Media).filter_by(report_id=r.id).first()
    assert media is not None
    assert media.type.value == 'AUDIO'
    assert media.pii_blur_status == 'not_needed', (
        f"Audio should set 'not_needed', got {media.pii_blur_status!r}"
    )


def test_existing_media_update_refreshes_blur_status(client, db):
    """Re-attaching the same (report_id, type) updates pii_blur_status to
    reflect the LATEST upload's outcome — operator's re-upload after a
    failure should clear the 'failed' chip."""
    r = _seed_report(db, device_hash="k2b-re-attach-refresh")

    # First attach: blur fails
    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.side_effect = RuntimeError("first attempt fails")
        res1 = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={"type": "IMAGE", "url": _TINY_IMG, "resolution_tier": "SMALL",
                  "file_size_bytes": 95},
        )
    assert res1.status_code == 200

    db.expire_all()
    m1 = db.query(Media).filter_by(report_id=r.id).first()
    assert m1.pii_blur_status == 'failed'

    # Second attach: blur succeeds (operator re-uploaded after fixing)
    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 0, "pii_texts": 0, "blurred": False,
            "error": None, "ran": True,
            "backends": {"face_detector": True, "ocr_reader": True},
        }
        res2 = client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={"type": "IMAGE", "url": _TINY_IMG, "resolution_tier": "SMALL",
                  "file_size_bytes": 95},
        )
    assert res2.status_code == 200

    db.expire_all()
    # Should be the SAME Media row (existing-media update path), now refreshed
    m2 = db.query(Media).filter_by(report_id=r.id).first()
    assert m2.id == m1.id, "Should be the same Media row (existing-media update)"
    assert m2.pii_blur_status == 'complete_clean', (
        f"Re-attach (blurred=False) should refresh to 'complete_clean', got {m2.pii_blur_status!r}"
    )
