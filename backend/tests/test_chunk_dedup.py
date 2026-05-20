"""K.1.b (May 2026, Phase K) — IntegrityError on duplicate chunk
is handled idempotently.

Before this fix, the chunk insert at reports.py:2949 + 3298 was wrapped
only in a check-then-act guard:
    existing = db.query(MediaChunk).filter(...).first()
    if not existing:
        db.add(MediaChunk(...))
        db.flush()      # <-- CRASHES with IntegrityError on race
        db.query(Media).update({"received_chunks": ... + 1})

Two concurrent calls with the same (media_id, seq_num) both saw
`existing=None`, both INSERTed, the second hit the
`uq_media_chunk_seq` UniqueConstraint and bubbled a 500 to the client.
The client treated 500 as a retry signal → infinite retry on a
legitimate idempotent dup. Meanwhile the `received_chunks` increment
was rolled back, so the chunk count went wrong.

The fix wraps the insert + flush in a try/except IntegrityError. On
exception, rollback + treat as the dup path (no increment, no error).

Positive assertions:
  - Serial dup: chunk seq=0 submitted twice → 200 + 200, received_chunks=1
  - Concurrent dup: chunk seq=0 submitted twice in parallel → 200 + 200,
    received_chunks=1, no 500.

Covers both endpoints:
  - POST /reports/{id}/media/chunk      (legacy base64 transport)
  - POST /reports/{id}/media/chunk-bin  (binary transport — same fix)
"""
from __future__ import annotations

import io
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.api.endpoints.reports import djb2_checksum, djb2_bytes
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


def _seed_report_and_media_id(db, *, device_hash, total_chunks=3):
    """Create a Report + reserve a fresh media_id (Media row will be created
    by the chunk endpoint on first chunk submission).
    """
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-chunkdedup-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r, str(uuid.uuid4())


# Reuse a tiny payload so the data column is small + the checksum is stable.
_PAYLOAD_DATA = "ABCD" * 64  # 256 chars of plaintext base64-like data
_PAYLOAD_CHECKSUM = djb2_checksum(_PAYLOAD_DATA)


# ── K.1.b positive assertions, legacy /chunk endpoint ────────────────────────


def test_legacy_chunk_serial_dup_returns_200_no_double_increment(client, db):
    """seq=0 submitted twice serially → both 200, received_chunks=1."""
    r, media_id = _seed_report_and_media_id(db, device_hash="legacy-serial-dup")
    payload = {
        "media_id": media_id,
        "type": "IMAGE",
        "seq_num": 0,
        "total_chunks": 3,
        "data": _PAYLOAD_DATA,
        "checksum": _PAYLOAD_CHECKSUM,
        "resolution_tier": "SMALL",
    }

    res1 = client.post(f"/api/v1/reports/{r.id}/media/chunk", json=payload)
    assert res1.status_code == 200, f"first chunk: {res1.status_code} body={res1.text}"

    res2 = client.post(f"/api/v1/reports/{r.id}/media/chunk", json=payload)
    assert res2.status_code == 200, (
        f"duplicate chunk should be idempotent 200, got {res2.status_code} body={res2.text}"
    )

    db.expire_all()
    media = db.query(Media).filter(Media.id == media_id).first()
    assert media is not None
    assert media.received_chunks == 1, (
        f"received_chunks={media.received_chunks}; duplicate chunk must not increment count"
    )
    chunk_count = db.query(MediaChunk).filter(
        MediaChunk.media_id == media_id, MediaChunk.seq_num == 0
    ).count()
    assert chunk_count == 1, f"Expected 1 MediaChunk row, got {chunk_count}"


def test_legacy_chunk_concurrent_dup_no_500(client, db):
    """seq=0 submitted twice concurrently → both 200 (or one 200 + one 200 from
    the dup path), no 500 from uq_media_chunk_seq violation. received_chunks=1.
    """
    r, media_id = _seed_report_and_media_id(db, device_hash="legacy-concurrent-dup")
    payload = {
        "media_id": media_id,
        "type": "IMAGE",
        "seq_num": 0,
        "total_chunks": 3,
        "data": _PAYLOAD_DATA,
        "checksum": _PAYLOAD_CHECKSUM,
        "resolution_tier": "SMALL",
    }

    def _post():
        return client.post(f"/api/v1/reports/{r.id}/media/chunk", json=payload).status_code

    with ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(_post)
        f2 = ex.submit(_post)
        s1 = f1.result(timeout=15)
        s2 = f2.result(timeout=15)

    assert s1 == 200, f"first concurrent chunk: {s1}"
    assert s2 == 200, f"second concurrent chunk: {s2} (race-protect failed?)"

    db.expire_all()
    media = db.query(Media).filter(Media.id == media_id).first()
    assert media.received_chunks == 1, (
        f"received_chunks={media.received_chunks}; concurrent dup must collapse to 1"
    )
    chunk_count = db.query(MediaChunk).filter(MediaChunk.media_id == media_id).count()
    assert chunk_count == 1


# ── K.1.b positive assertions, chunk-bin (binary transport) endpoint ─────────


def _bin_post(test_client, report_id, media_id, raw_bytes, checksum):
    """POST to chunk-bin via multipart form upload (the actual production
    shape — UploadFile + Form fields, NOT custom headers)."""
    return test_client.post(
        f"/api/v1/reports/{report_id}/media/chunk-bin",
        files={"data": ("chunk0.bin", raw_bytes, "application/octet-stream")},
        data={
            "media_id": media_id,
            "seq_num": "0",
            "total_chunks": "3",
            "type": "IMAGE",
            "resolution_tier": "SMALL",
            "checksum": checksum,
        },
    )


def test_chunk_bin_serial_dup_returns_200_no_double_increment(client, db):
    """Binary transport: seq=0 submitted twice serially → both 200, received_chunks=1."""
    r, media_id = _seed_report_and_media_id(db, device_hash="bin-serial-dup")
    raw = b"ABCDEFGH" * 32  # 256 bytes
    checksum = djb2_bytes(raw)

    res1 = _bin_post(client, r.id, media_id, raw, checksum)
    assert res1.status_code == 200, f"first bin chunk: {res1.status_code} body={res1.text}"

    res2 = _bin_post(client, r.id, media_id, raw, checksum)
    assert res2.status_code == 200, (
        f"duplicate bin chunk should be idempotent 200, got {res2.status_code} body={res2.text}"
    )

    db.expire_all()
    media = db.query(Media).filter(Media.id == media_id).first()
    assert media is not None
    assert media.received_chunks == 1, f"received_chunks={media.received_chunks}; expected 1"


def test_chunk_bin_concurrent_dup_no_500(client, db):
    """Binary transport: seq=0 submitted twice concurrently → both 200, no 500."""
    r, media_id = _seed_report_and_media_id(db, device_hash="bin-concurrent-dup")
    raw = b"ABCDEFGH" * 32
    checksum = djb2_bytes(raw)

    def _post():
        return _bin_post(client, r.id, media_id, raw, checksum).status_code

    with ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(_post)
        f2 = ex.submit(_post)
        s1 = f1.result(timeout=15)
        s2 = f2.result(timeout=15)

    assert s1 == 200, f"first concurrent bin chunk: {s1}"
    assert s2 == 200, f"second concurrent bin chunk: {s2}"

    db.expire_all()
    media = db.query(Media).filter(Media.id == media_id).first()
    assert media.received_chunks == 1
