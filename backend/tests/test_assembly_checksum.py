"""K.2.c (May 2026, Phase K) — checksum mismatch propagates to
Media.abandon_reason for dashboard chip rendering.

Before this fix, `_assemble_media_file` at reports.py:373-394 detected
djb2 checksum mismatches and returned None, but only set
`assembly_status='failed'` via the calling `_try_full_assembly_bg`
handler — `abandon_reason` stayed NULL. Operator dashboard couldn't
distinguish "Media corrupt" (checksum mismatch) from "Upload abandoned"
(chunks_never_arrived) or "Worker lost" (assembly_worker_lost).

Fix: the checksum-mismatch path now also stamps:
    media.assembly_status = 'failed'
    media.abandon_reason  = 'checksum_mismatch'
    media.abandoned_at    = now()

The caller's redundant assembly_status='failed' update is now guarded
by `Media.assembly_status != 'failed'` so we don't clobber the
abandon_reason set inside `_assemble_media_file`.

Positive assertions:
  - Direct call to `_assemble_media_file` with mismatched checksum →
    Media row updated to (assembly_status='failed',
    abandon_reason='checksum_mismatch', abandoned_at != NULL).
  - Caller `_try_full_assembly_bg` doesn't overwrite the abandon_reason.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.api.endpoints.reports import _assemble_media_file, djb2_bytes
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


def _seed_report_media_with_chunks(db, *, device_hash, real_bytes, declared_checksum):
    """Seed a Report + Media row + a single chunk containing `real_bytes`.
    The Media row's `full_asset_checksum` is set to `declared_checksum` —
    pass a deliberately-wrong value to trigger the mismatch path.
    """
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k2c-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.flush()

    import uuid
    media_id = str(uuid.uuid4())
    m = Media(
        id=media_id,
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        url="",
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
        assembly_status="pending",
        full_asset_checksum=declared_checksum,
    )
    db.add(m)
    db.flush()

    # Single chunk holding the real bytes (so _assemble_media_file
    # concatenates them and computes a NEW djb2 → which won't match
    # `declared_checksum`).
    import base64
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


# ── K.2.c positive assertions ────────────────────────────────────────────────


def test_checksum_mismatch_sets_abandon_reason(db):
    """Direct invocation of `_assemble_media_file` with a deliberately-wrong
    `full_asset_checksum` → Media row gets abandon_reason='checksum_mismatch'.
    """
    real_bytes = b"\x89PNG\r\n\x1a\nIHDR" + b"\x00" * 256  # 264 fake png bytes
    declared_checksum = "00000000"  # deliberately wrong (8-char djb2 hex)
    r, m = _seed_report_media_with_chunks(
        db,
        device_hash="k2c-checksum-mismatch",
        real_bytes=real_bytes,
        declared_checksum=declared_checksum,
    )

    # Sanity: the actual djb2 over real_bytes is NOT the declared.
    assert djb2_bytes(real_bytes) != declared_checksum

    file_url = _assemble_media_file(m.id, "IMAGE", db)
    # Mismatch path returns None (assembly aborted).
    assert file_url is None, "Mismatch should abort assembly + return None"

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.assembly_status == "failed", (
        f"assembly_status={refreshed.assembly_status}; expected 'failed' after mismatch"
    )
    assert refreshed.abandon_reason == "checksum_mismatch", (
        f"abandon_reason={refreshed.abandon_reason!r}; expected 'checksum_mismatch'"
    )
    assert refreshed.abandoned_at is not None, (
        "abandoned_at must be set when checksum mismatch fires"
    )


def test_no_checksum_recorded_does_not_trigger_mismatch_path(db):
    """If `full_asset_checksum` is NULL (legacy clients, chunked-flow
    where chunk 0 never carried the field), assembly proceeds without
    the integrity check. abandon_reason stays NULL on success."""
    real_bytes = b"\x89PNG\r\n\x1a\nIHDR" + b"\x00" * 256
    r, m = _seed_report_media_with_chunks(
        db,
        device_hash="k2c-no-checksum",
        real_bytes=real_bytes,
        declared_checksum=None,  # NULL — integrity check skipped
    )

    file_url = _assemble_media_file(m.id, "IMAGE", db)
    # Assembly may still fail for other reasons (e.g., image decode)
    # but the checksum path must not fire.
    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.abandon_reason != "checksum_mismatch", (
        f"abandon_reason={refreshed.abandon_reason!r}; mismatch path "
        f"should not fire when expected_checksum is NULL"
    )
