"""K.6.c follow-up — `crisp_pii_blur_status_total` wiring on the
chunked-upload path.

Sibling to `test_observability_k6c.py` (counter exists) and
`test_attach_pii_blur_status.py` (the /attach one-shot path).
The PWA submits photos via the chunked transport, NOT /attach, so
pre-fix the counter sat at 0 in production while hundreds of Media
rows were being stamped per hour. This file pins the two chunked
write sites that need to tick the counter:

  1. `_assemble_media_file` AUDIO branch (reports.py ~535-548) →
     bumps `status='not_needed'` right after the row UPDATE.
  2. `_run_server_pii_blur` (reports.py ~661-680) → bumps
     `status=<outcome>` alongside the existing `pii_blur_runs_total`
     bump, where outcome ∈ {complete, failed, skipped}.

Each test asserts a counter DELTA rather than absolute value because
Prometheus counters are process-singletons that accumulate across
tests (the K.6.c file in the same suite increments them too).
"""
from __future__ import annotations

import base64
import uuid

import pytest
from unittest.mock import patch

from app.api.endpoints.reports import (
    _assemble_media_file,
    _run_server_pii_blur,
    djb2_bytes,
)
from app.core.observability import pii_blur_status_total
from app.models.report import (
    Device,
    Report,
    Media,
    MediaChunk,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)
from app.services.storage import get_storage


_OGG_HEADER = b"OggS" + b"\x00" * 23
_JPEG_HEADER = b"\xff\xd8\xff\xe0" + b"\x00" * 256


def _counter_value(status: str) -> float:
    """Read the current cumulative value of the labelled counter.
    Used to compute deltas across the unit of work under test.
    """
    return pii_blur_status_total.labels(status=status)._value.get()


def _seed_report_media_chunk(db, *, device_hash, media_type, real_bytes):
    """Mirror of the helper in `test_chunked_assembly_pii_blur_status.py`.
    Seeds a Report + a Media row (pii_blur_status=NULL) + a single
    MediaChunk holding `real_bytes`, ready for `_assemble_media_file`.
    """
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k6c-chunked-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.flush()

    media_id = str(uuid.uuid4())
    m = Media(
        id=media_id,
        report_id=r.id,
        type=media_type,
        resolution_tier=ResolutionEnum.SMALL,
        url="",
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
        assembly_status="pending",
    )
    db.add(m)
    db.flush()

    chunk = MediaChunk(
        media_id=media_id,
        seq_num=0,
        total_chunks=1,
        data_b64=base64.b64encode(real_bytes).decode(),
        checksum=djb2_bytes(real_bytes),
    )
    db.add(chunk)
    db.commit()
    return r, m


# ── AUDIO leg (synchronous, fires inside _assemble_media_file) ──────────────


def test_chunked_audio_assembly_bumps_not_needed_counter(db):
    """The AUDIO branch of `_assemble_media_file` writes
    pii_blur_status='not_needed' and (post-fix) ticks the K.6.c
    counter for that label. Pre-fix the counter stayed at 0 even
    though every PWA audio submission hits this path.
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k6c-audio",
        media_type=MediaTypeEnum.AUDIO,
        real_bytes=_OGG_HEADER,
    )

    before = _counter_value('not_needed')
    file_url = _assemble_media_file(m.id, "AUDIO", db)
    assert file_url, "Audio assembly should succeed for a valid OGG header"
    after = _counter_value('not_needed')

    assert after - before == 1.0, (
        f"Expected pii_blur_status_total{{status='not_needed'}} to tick by 1, "
        f"got delta={after - before} (before={before}, after={after})"
    )

    # Sanity: the DB row also got stamped (the counter is meant to
    # mirror the persisted column).
    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.pii_blur_status == 'not_needed'


# ── IMAGE leg (synchronous when we call _run_server_pii_blur directly) ───────


def _stage_image_in_storage(filename: str) -> str:
    """Drop a minimal JPEG into the test storage backend so
    `_run_server_pii_blur` → `_stage_from_storage` can read it.
    Returns the DB url to pass as the worker's `db_url` arg.
    """
    return get_storage().save(filename, _JPEG_HEADER, "image/jpeg")


def test_chunked_image_blur_clean_bumps_complete_clean_counter(db):
    """B-A: `_run_server_pii_blur` with `blur_pii` returning ran=True +
    blurred=False ends on outcome='complete_clean' (was 'complete'
    pre-0037). The K.6.c counter for status='complete_clean' must tick
    alongside the existing `pii_blur_runs_total` tick.
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k6c-img-ok",
        media_type=MediaTypeEnum.IMAGE,
        real_bytes=_JPEG_HEADER,
    )
    filename = f"{m.id}_assembled.jpg"
    file_url = _stage_image_in_storage(filename)

    before = _counter_value('complete_clean')
    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 0,
            "pii_texts": 0,
            "blurred": False,
            "error": None,
            "ran": True,
            "backends": {"face_detector": True, "ocr_reader": True},
        }
        _run_server_pii_blur(m.id, file_url, filename)
    after = _counter_value('complete_clean')

    assert after - before == 1.0, (
        f"Expected status='complete_clean' counter to tick by 1, "
        f"got delta={after - before}"
    )

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.pii_blur_status == 'complete_clean'


def test_chunked_image_blur_failed_bumps_failed_counter(db):
    """`blur_pii` raising → outcome='failed' → the K.6.c counter for
    status='failed' must tick. This is the operator-useful divergence
    case: if the DB UPDATE inside the finally-block also fails, the
    PERSISTED column stays NULL even though this counter rises.
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k6c-img-fail",
        media_type=MediaTypeEnum.IMAGE,
        real_bytes=_JPEG_HEADER,
    )
    filename = f"{m.id}_assembled.jpg"
    file_url = _stage_image_in_storage(filename)

    before = _counter_value('failed')
    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.side_effect = RuntimeError("simulated blur failure")
        _run_server_pii_blur(m.id, file_url, filename)
    after = _counter_value('failed')

    assert after - before == 1.0, (
        f"Expected status='failed' counter to tick by 1, "
        f"got delta={after - before}"
    )

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.pii_blur_status == 'failed'


def test_chunked_image_blur_backends_unavailable_bumps_failed_counter(db):
    """B-A: Backends-unavailable case — `blur_pii` returns ran=False,
    which the worker treats as outcome='failed' under the canonical
    taxonomy (was 'skipped' pre-0037). The counter must reflect that
    terminal state (operators page on this — file is on disk
    UNBLURRED).
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k6c-img-skip",
        media_type=MediaTypeEnum.IMAGE,
        real_bytes=_JPEG_HEADER,
    )
    filename = f"{m.id}_assembled.jpg"
    file_url = _stage_image_in_storage(filename)

    before = _counter_value('failed')
    with patch("app.services.pii_blur.blur_pii") as mock_blur:
        mock_blur.return_value = {
            "faces": 0,
            "pii_texts": 0,
            "blurred": False,
            "error": "PII-blur backends unavailable (test).",
            "ran": False,
            "backends": {"face_detector": False, "ocr_reader": False},
        }
        _run_server_pii_blur(m.id, file_url, filename)
    after = _counter_value('failed')

    assert after - before == 1.0, (
        f"Expected status='failed' counter to tick by 1 "
        f"(backends-unavailable folded into 'failed' by B-A), "
        f"got delta={after - before}"
    )

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.pii_blur_status == 'failed'
