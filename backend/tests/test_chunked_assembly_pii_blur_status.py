"""K.2.b (May 2026, Phase K) — PII blur status tracked on Media rows
created via the chunked-upload assembly path.

Sibling to `test_attach_pii_blur_status.py`. That file exercises the
one-shot `/attach` handler; this one exercises `_assemble_media_file`
— the assembler invoked by `_try_full_assembly_bg` when the final
chunk arrives. PWA audio capture goes through the chunked transport
exclusively, so the chunked path is the one that actually runs in
production for audio.

Bug closed:
  Pre-fix, `_assemble_media_file` only stamped `pii_blur_status` on
  IMAGE rows ('pending', later overwritten by the server-PII-blur
  worker with 'complete' / 'failed' / 'skipped'). The AUDIO branch
  fell through without touching the column, so audio Media rows
  retained the NULL default from row creation in /media/chunk{,-bin}.
  The dashboard's "PII review needed" chip is keyed off
  `pii_blur_status`, and NULL renders as no chip — operators had no
  signal at all on audio.

Fix at reports.py:528-541: the AUDIO branch now UPDATEs the column
to 'not_needed', matching the /attach handler's audio default.

Positive assertions:
  - IMAGE chunked assembly → 'pending' (worker takes it from there)
  - AUDIO chunked assembly → 'not_needed' (terminal state)
"""
from __future__ import annotations

import base64
import uuid

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


# Real OGG/Opus header so _assemble_media_file's format-sniff picks 'ogg'
# and storage.save lands a real audio file rather than the m4a fallback.
# 4-byte magic 'OggS' + 23 bytes of zero padding = 27 bytes total, enough
# for the magic-byte check at reports.py:431 to fire without needing a
# decodable stream.
_OGG_HEADER = b"OggS" + b"\x00" * 23

# Minimal JPEG header (SOI + APP0 marker stub). Decoders will reject it
# as a real image, but _assemble_media_file just concatenates + saves,
# then hands off to the server-PII-blur worker; we only need the bytes
# to make it through assembly + storage.save.
_JPEG_HEADER = b"\xff\xd8\xff\xe0" + b"\x00" * 256


def _seed_report_media_chunk(db, *, device_hash, media_type, real_bytes):
    """Create a Report + Media row + a single MediaChunk holding
    `real_bytes`. Media is created with pii_blur_status=NULL, matching
    the row-creation pattern in /media/chunk{,-bin}.
    """
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k2b-chunked-{device_hash}",
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
        resolution_tier=ResolutionEnum.LOW,
        url="",
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
        assembly_status="pending",
        # NULL pii_blur_status — matches the /media/chunk and
        # /media/chunk-bin row-creation paths (reports.py:3104, 3474).
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


# ── K.2.b positive assertions (chunked path) ─────────────────────────────────


def test_chunked_audio_assembly_sets_not_needed(db):
    """The whole point of this file. Audio chunked assembly must stamp
    `pii_blur_status='not_needed'` — pre-fix it stayed NULL.
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k2b-chunked-audio",
        media_type=MediaTypeEnum.AUDIO,
        real_bytes=_OGG_HEADER,
    )

    # Pre-condition: NULL after row creation (mirrors production reality
    # — /media/chunk{,-bin} create the row with no pii_blur_status).
    assert m.pii_blur_status is None, (
        f"Pre-condition violated: row was created with "
        f"pii_blur_status={m.pii_blur_status!r}; expected NULL"
    )

    file_url = _assemble_media_file(m.id, "AUDIO", db)
    assert file_url, "Assembly should succeed for a valid OGG header"

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    assert refreshed.pii_blur_status == 'not_needed', (
        f"Audio chunked assembly should set pii_blur_status='not_needed', "
        f"got {refreshed.pii_blur_status!r}"
    )


def test_chunked_image_assembly_sets_pending(db):
    """Regression guard: existing image-pending behaviour at
    reports.py:513 must survive the audio-branch addition. The
    server-PII-blur worker (running async in a thread pool) takes
    the row from 'pending' → terminal; we only assert the pre-worker
    state stamped by the assembler.
    """
    r, m = _seed_report_media_chunk(
        db,
        device_hash="k2b-chunked-image",
        media_type=MediaTypeEnum.IMAGE,
        real_bytes=_JPEG_HEADER,
    )

    file_url = _assemble_media_file(m.id, "IMAGE", db)
    assert file_url, "Assembly should succeed for a valid JPEG header"

    db.expire_all()
    refreshed = db.query(Media).filter(Media.id == m.id).first()
    # The worker runs in _ai_executor; depending on timing the status
    # may have already transitioned. Accept any post-pending terminal
    # state OR 'pending' itself — the invariant we care about is that
    # the column is NEVER NULL after assembly.
    assert refreshed.pii_blur_status is not None, (
        "Image chunked assembly must stamp pii_blur_status; got NULL"
    )
    assert refreshed.pii_blur_status in ('pending', 'complete', 'failed', 'skipped'), (
        f"Unexpected pii_blur_status={refreshed.pii_blur_status!r}"
    )
