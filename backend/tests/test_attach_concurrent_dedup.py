"""K.2.a (May 2026, Phase K) — row-lock on /attach prevents duplicate
Media rows under concurrency.

Before this fix, the /attach handler's find-or-create pattern at
reports.py:2645-2675 was a check-then-act race:

    existing = db.query(Media).filter(
        Media.report_id == report.id,
        Media.type == media_in.type,
        Media.assembly_status == 'complete',
    ).first()
    if existing:
        # update URL
    else:
        db.add(Media(...))   # INSERT new row
        report.received_media += 1

Two concurrent /attach calls for the same (report_id, type) both
observed `existing=None`, both INSERTed → two complete Media rows
for the same logical media. Dashboard groups by photo_group_id; the
duplicate confused operators (rendered same image twice / disk
leak).

Fix: `with_for_update()` on the parent Report.first() at line 2592
serialises /attach per report. The second handler waits on the row
lock, then reads the winner's committed Media row → enters the
update branch.

Positive assertions:
  - 3 concurrent /attach for same (report_id, type=IMAGE) → exactly 1
    Media row with assembly_status='complete'.
  - received_media incremented by exactly 1 (not 3).
  - Serial behaviour unchanged.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

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


def _seed_report(db, *, device_hash, expected=1):
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"e2e-k2a-{device_hash}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=expected,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


# ── K.2.a positive assertion ─────────────────────────────────────────────────


def test_three_concurrent_same_type_attach_yields_single_media_row(client, db):
    """3 concurrent /attach calls with same (report_id, type=IMAGE) must
    result in exactly 1 complete Media row + received_media == 1.

    Pre-fix this would frequently end at 2 or 3 Media rows because each
    thread missed the dedup check.
    """
    r = _seed_report(db, device_hash="k2a-three-concurrent-image", expected=1)

    def _attach():
        return client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "LOW",
                "file_size_bytes": 95,
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(_attach) for _ in range(3)]
        statuses = [f.result(timeout=15) for f in futures]

    for s in statuses:
        assert s == 200, f"/attach returned {s}; expected 200 for all three"

    db.expire_all()
    refreshed = db.query(Report).filter(Report.id == r.id).first()
    media_count = db.query(Media).filter_by(
        report_id=r.id,
        assembly_status="complete",
    ).count()

    assert media_count == 1, (
        f"Media rows complete={media_count}; expected exactly 1. "
        f"Row-lock race fix failed — concurrent /attach inserted duplicates."
    )
    assert refreshed.received_media == 1, (
        f"received_media={refreshed.received_media}; expected 1 (dedup should "
        f"have collapsed the 2nd + 3rd attach into update path)."
    )
    assert refreshed.sync_status == SyncStatusEnum.SYNCED


def test_five_concurrent_same_type_attach_stress(client, db):
    """Higher concurrency stress: 5 concurrent /attach for same type →
    still exactly 1 Media row."""
    r = _seed_report(db, device_hash="k2a-five-stress", expected=1)

    def _attach():
        return client.patch(
            f"/api/v1/reports/{r.id}/media/attach",
            json={
                "type": "IMAGE",
                "url": _TINY_IMG,
                "resolution_tier": "LOW",
                "file_size_bytes": 95,
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=5) as ex:
        futures = [ex.submit(_attach) for _ in range(5)]
        statuses = [f.result(timeout=20) for f in futures]

    for s in statuses:
        assert s == 200

    db.expire_all()
    media_count = db.query(Media).filter_by(
        report_id=r.id,
        assembly_status="complete",
    ).count()
    assert media_count == 1, f"Expected 1, got {media_count}"


def test_serial_same_type_attach_baseline(client, db):
    """Regression sentinel: serial /attach for same type still produces
    exactly 1 Media row (the existing dedup at line 2645-2650 already
    handled the single-threaded case; the row-lock fix must not regress
    that behaviour)."""
    r = _seed_report(db, device_hash="k2a-serial-baseline", expected=1)

    for _ in range(3):
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
    media_count = db.query(Media).filter_by(
        report_id=r.id,
        assembly_status="complete",
    ).count()
    assert media_count == 1
