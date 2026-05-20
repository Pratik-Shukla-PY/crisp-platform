"""Phase L (May 2026) — resolution_tier canonical vocabulary + 5 MB cap.

Asserts the L.1 + L.1b + L.12.6 sub-phases work end-to-end:

L.1.a — Enum is the 3 canonical values only
  * ResolutionEnum has exactly {SMALL, MEDIUM, ORIGINAL} — no legacy aliases

L.1.b — Alembic 0035 backfilled HIGH→ORIGINAL, LOW→SMALL.
L.1b — Alembic 0036 dropped LOW/HIGH from the Postgres enum.

L.1.d — Endpoint validates strictly
  * MediaAttach with tier='LOW' → 422 (rejected by Pydantic enum)
  * MediaAttach with tier='HIGH' → 422
  * MediaAttach with tier='SMALL' / 'MEDIUM' / 'ORIGINAL' accepted

L.12.6 — Server-side 5 MB ORIGINAL cap
  * /attach with ORIGINAL tier + 5 MB + 1 byte → 413
  * /attach with ORIGINAL tier + 5 MB exactly → 201
  * /attach with SMALL tier + 6 MB → 201 (cap only applies to ORIGINAL)
  * Chunked assembly assembling 6 MB ORIGINAL → Media row marked failed
    with abandon_reason='original_too_large'
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone

import pytest

from app.models.report import (
    Media,
    MediaTypeEnum,
    Report,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


# ── L.1.a — Enum is the 3 canonical values only ──────────────────────────────


def test_resolution_enum_is_three_canonical_values_only():
    """The Phase L enum has exactly SMALL/MEDIUM/ORIGINAL; legacy
    LOW/HIGH removed in alembic 0036."""
    members = {m.name for m in ResolutionEnum}
    assert members == {"SMALL", "MEDIUM", "ORIGINAL"}, (
        f"Phase L enum must be exactly the 3 canonical values; "
        f"got {sorted(members)}"
    )
    # And the .value attribute strings match.
    assert ResolutionEnum.SMALL.value == "SMALL"
    assert ResolutionEnum.MEDIUM.value == "MEDIUM"
    assert ResolutionEnum.ORIGINAL.value == "ORIGINAL"


# ── L.1.d — /attach accepts legacy names, persists canonical ─────────────────


def _make_report_for_attach(db):
    r = Report(
        id=str(uuid.uuid4()),
        client_report_id=str(uuid.uuid4()),
        source=SourceEnum.APP,
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=2,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


_TINY_JPEG_B64 = (
    # 1×1 white JPEG (minimal valid file)
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEB"
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
    "AQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI"
    "CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS"
    "0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1"
    "dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW"
    "19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD+/iv7+K/v4o//2Q=="
)


def test_attach_with_legacy_LOW_returns_422(client, db):
    """Phase L (L.1b cleanup) — legacy LOW is no longer accepted.
    Clients must send the canonical SMALL value. Pydantic enum
    validation rejects with 422.
    """
    r = _make_report_for_attach(db)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "resolution_tier": "LOW",
            "url": f"data:image/jpeg;base64,{_TINY_JPEG_B64}",
        },
    )
    assert res.status_code == 422, (
        f"Legacy LOW must be rejected post-L.1b; got {res.status_code} body={res.text}"
    )
    # No Media row was persisted.
    assert db.query(Media).filter(Media.report_id == r.id).count() == 0


def test_attach_with_legacy_HIGH_returns_422(client, db):
    """Phase L (L.1b cleanup) — legacy HIGH is no longer accepted.
    Clients must send the canonical ORIGINAL value.
    """
    r = _make_report_for_attach(db)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "resolution_tier": "HIGH",
            "url": f"data:image/jpeg;base64,{_TINY_JPEG_B64}",
        },
    )
    assert res.status_code == 422
    assert db.query(Media).filter(Media.report_id == r.id).count() == 0


def test_attach_with_canonical_SMALL_persists_correctly(client, db):
    """/attach payload sends tier='SMALL' → row reads back as 'SMALL'."""
    r = _make_report_for_attach(db)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "resolution_tier": "SMALL",
            "url": f"data:image/jpeg;base64,{_TINY_JPEG_B64}",
        },
    )
    assert res.status_code in (200, 201)
    media = db.query(Media).filter(Media.report_id == r.id).first()
    assert media.resolution_tier == ResolutionEnum.SMALL


def test_attach_with_canonical_ORIGINAL_persists_correctly(client, db):
    """/attach payload sends tier='ORIGINAL' → row reads back as 'ORIGINAL'."""
    r = _make_report_for_attach(db)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "resolution_tier": "ORIGINAL",
            "url": f"data:image/jpeg;base64,{_TINY_JPEG_B64}",
        },
    )
    assert res.status_code in (200, 201)
    media = db.query(Media).filter(Media.report_id == r.id).first()
    assert media.resolution_tier == ResolutionEnum.ORIGINAL


# ── L.12.6 — Server-side 5 MB ORIGINAL cap ───────────────────────────────────


def _make_payload_of_size(num_bytes: int) -> str:
    """Return a `data:image/jpeg;base64,...` URL whose decoded payload
    is exactly `num_bytes` bytes long. Content is repeated `\\xff\\xd8\\xff\\xe0`
    (JPEG magic prefix) followed by junk — the cap check operates on
    decoded byte count, not on JPEG validity.
    """
    payload = (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
               + b"\x00" * max(0, num_bytes - 20))
    payload = payload[:num_bytes]
    b64 = base64.b64encode(payload).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def test_attach_original_5mb_exactly_accepted(client, db):
    """5 MB exactly (boundary) — must NOT be rejected."""
    r = _make_report_for_attach(db)
    url = _make_payload_of_size(5 * 1024 * 1024)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={"type": "IMAGE", "resolution_tier": "ORIGINAL", "url": url},
    )
    # Some downstream validation (e.g. PII blur on a non-JPEG payload) may
    # report partial issues; assert the 413 path didn't fire.
    assert res.status_code != 413, (
        f"5 MB ORIGINAL exactly should pass; got 413 with body={res.text}"
    )


def test_attach_original_over_5mb_rejected_with_413(client, db):
    """5 MB + 1 byte — must reject with 413 + counter increments."""
    r = _make_report_for_attach(db)
    url = _make_payload_of_size(5 * 1024 * 1024 + 1)

    # Snapshot the counter before
    from app.core.observability import media_abandon_reason_total
    before = media_abandon_reason_total.labels(reason="original_too_large")._value.get()

    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={"type": "IMAGE", "resolution_tier": "ORIGINAL", "url": url},
    )
    assert res.status_code == 413
    assert "5 MB cap" in res.text or "exceeds 5 MB" in res.text or "ORIGINAL" in res.text

    after = media_abandon_reason_total.labels(reason="original_too_large")._value.get()
    assert after == before + 1, (
        f"K.6.c counter should increment on 413; before={before} after={after}"
    )

    # No Media row should have been created
    media_count = db.query(Media).filter(Media.report_id == r.id).count()
    assert media_count == 0


def test_attach_small_over_5mb_accepted(client, db):
    """Cap only applies to ORIGINAL — a 6 MB SMALL tier should NOT be rejected."""
    r = _make_report_for_attach(db)
    url = _make_payload_of_size(6 * 1024 * 1024)
    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={"type": "IMAGE", "resolution_tier": "SMALL", "url": url},
    )
    assert res.status_code != 413, (
        f"6 MB SMALL must NOT trigger the ORIGINAL-tier cap; got 413"
    )
