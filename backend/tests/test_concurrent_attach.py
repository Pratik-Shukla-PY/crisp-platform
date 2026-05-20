"""K.1.a (May 2026, Phase K) — atomic `received_media` increment.

Before this fix, the receive-count update at reports.py:966 + :2666 was
a non-atomic read-modify-write (`report.received_media = (received or
0) + 1`). Two threads racing on `/attach` for different media types of
the same report could both read 0, both write 1 → count diverges from
the actual number of Media rows.

The fix replaces both call-sites with an atomic SQL UPDATE:
    db.query(Report).filter(...).update(
        {"received_media": Report.received_media + 1},
        synchronize_session="fetch",
    )

Positive assertion: spawn 2 concurrent /attach calls with DIFFERENT
media types (IMAGE + AUDIO) on the same report; assert
`report.received_media == 2` afterwards (NOT 1).

NOTE: We use different `type` values (not different tiers of same
type) because the dedup at reports.py:2632 currently matches by
(report_id, type, assembly_status='complete'). The same-type-different-
tier duplicate-row race is K.2.a's concern; this test isolates K.1.a's
atomic-increment concern by exercising the path that actually inserts
new rows.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    SourceEnum,
    SyncStatusEnum,
)


# 1x1 PNG (95 bytes assembled), valid as both IMAGE attach payload (mime
# is parsed from the data: prefix) and as a minimal blob the storage
# abstraction will accept.
_TINY_IMG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)
# 32 bytes of OGG container header — enough for the audio MIME sniffer
# in _detect_audio_format to identify the format. (44-char valid base64.)
_TINY_AUDIO = (
    "data:audio/ogg;base64,"
    "T2dnUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)


def _seed_report(db, *, device_hash, expected):
    """A PARTIAL Report row expecting `expected` Media items."""
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-concurrent-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=expected,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


# ── K.1.a positive assertion ─────────────────────────────────────────────────


def test_two_concurrent_different_type_attach_increments_atomically(client, db):
    """Two /attach POSTs in parallel — one IMAGE + one AUDIO — must result
    in received_media == 2.

    Pre-fix this would frequently end at 1 (lost increment) because each
    thread read the same starting value (`(0 or 0) + 1 = 1`, both wrote 1).

    Different types are used so the (report_id, type, complete) dedup at
    reports.py:2632 doesn't gate the second insert.
    """
    r = _seed_report(db, device_hash="two-concurrent-mixed", expected=2)

    def _attach_image() -> int:
        return client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "LOW",
                "file_size_bytes": 95,
            },
        ).status_code

    def _attach_audio() -> int:
        return client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "AUDIO",
                "url": _TINY_AUDIO,
                "resolution_tier": "LOW",
                "file_size_bytes": 48,
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(_attach_image)
        f2 = ex.submit(_attach_audio)
        s1 = f1.result(timeout=15)
        s2 = f2.result(timeout=15)

    assert s1 == 200, f"IMAGE /attach returned {s1}"
    assert s2 == 200, f"AUDIO /attach returned {s2}"

    db.expire_all()
    refreshed = db.query(Report).filter(Report.id == r.id).first()
    media_count = db.query(Media).filter_by(report_id=r.id, assembly_status="complete").count()

    assert refreshed.received_media == 2, (
        f"received_media={refreshed.received_media} — atomic increment race? "
        f"Expected 2 after concurrent IMAGE + AUDIO /attach."
    )
    assert media_count == 2, (
        f"Media rows complete={media_count}; expected 2 (one IMAGE + one AUDIO)."
    )
    assert refreshed.sync_status == SyncStatusEnum.SYNCED, (
        f"sync_status={refreshed.sync_status}; expected SYNCED once "
        f"received_media (2) >= expected_media (2)."
    )


def test_serial_different_type_attach_baseline(client, db):
    """Regression sentinel: serial IMAGE + AUDIO attach still increments
    correctly. The atomic-SQL pattern must not regress the single-threaded
    happy path.
    """
    r = _seed_report(db, device_hash="serial-baseline-mixed", expected=2)

    res1 = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "url": _TINY_IMG,
            "resolution_tier": "LOW",
            "file_size_bytes": 95,
        },
    )
    assert res1.status_code == 200

    res2 = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "AUDIO",
            "url": _TINY_AUDIO,
            "resolution_tier": "LOW",
            "file_size_bytes": 48,
        },
    )
    assert res2.status_code == 200

    db.expire_all()
    refreshed = db.query(Report).filter(Report.id == r.id).first()
    assert refreshed.received_media == 2
    assert refreshed.sync_status == SyncStatusEnum.SYNCED


def test_single_attach_does_not_overshoot(client, db):
    """Negative-direction sentinel: one /attach must increment to exactly 1,
    not 2 (which would mean the atomic UPDATE ran twice due to a bad refresh
    sequence).
    """
    r = _seed_report(db, device_hash="single-attach", expected=3)

    res = client.patch(
        f"/api/v1/reports/{r.id}/media/attach",
        json={
            "type": "IMAGE",
            "url": _TINY_IMG,
            "resolution_tier": "LOW",
            "file_size_bytes": 95,
        },
    )
    assert res.status_code == 200

    db.expire_all()
    refreshed = db.query(Report).filter(Report.id == r.id).first()
    assert refreshed.received_media == 1
    # Expected 3 received 1 → stays PARTIAL
    assert refreshed.sync_status == SyncStatusEnum.PARTIAL
