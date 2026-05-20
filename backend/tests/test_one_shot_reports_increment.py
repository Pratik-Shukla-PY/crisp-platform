"""K.2.g (May 2026, Phase K) — one-shot `POST /reports/` increments
`received_media` from the media list.

Before this fix, the legacy one-shot endpoint at reports.py:3624 added
Media rows but never updated `report.received_media` or evaluated the
SYNCED gate. Reports submitted via this path were stuck PARTIAL forever
(or QUEUED with media that the dashboard couldn't reconcile).

PWA / Telegram / messaging-bot all use the chunked flow
(/meta + /chunk-bin) and so dodged the bug, but the endpoint is still
public — 3rd-party integrations hit it.

Fix: after the media-row loop at line 3756, count
`len(saved_media_entities)`, stamp `report.received_media`, default
`expected_media` if unset, and promote to SYNCED when count matches.

Positive assertions:
  - POST with 3 media items → received_media=3, sync_status=SYNCED
  - POST with no media (text-only) → received_media unchanged
  - POST with media but expected_media explicitly set higher → stays PARTIAL
"""
from __future__ import annotations

import uuid

import pytest

from app.models.report import Report, Media, SyncStatusEnum


_TINY_IMG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)
_TINY_AUDIO = (
    "data:audio/ogg;base64,"
    "T2dnUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)


def _base_payload(device_hash: str, *, media=None, expected_media=None):
    p = {
        "device_hash": device_hash,
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "K.2.g test report",
        "is_auto_submitted": False,
        "location": {"latitude": 12.97, "longitude": 77.59},
        "media": media or [],
    }
    if expected_media is not None:
        p["expected_media"] = expected_media
    return p


# ── K.2.g positive assertions ────────────────────────────────────────────────


def test_one_shot_with_three_media_sets_received_and_synced(client, db):
    """POST /reports/ with 3 media items → received_media=3, SYNCED."""
    payload = _base_payload(
        "DEV-K2G-three-media",
        media=[
            {"type": "IMAGE", "url": _TINY_IMG, "resolution_tier": "SMALL", "file_size_bytes": 95},
            {"type": "IMAGE", "url": _TINY_IMG, "resolution_tier": "MEDIUM", "file_size_bytes": 95},
            {"type": "AUDIO", "url": _TINY_AUDIO, "resolution_tier": "SMALL", "file_size_bytes": 48},
        ],
    )
    res = client.post("/api/v1/reports/", json=payload)
    assert res.status_code == 201, f"got {res.status_code} body={res.text}"

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    media_count = db.query(Media).filter(Media.report_id == r.id).count()

    assert media_count == 3, f"Expected 3 Media rows, got {media_count}"
    assert r.received_media == 3, (
        f"received_media={r.received_media}; expected 3 after K.2.g fix"
    )
    assert r.sync_status == SyncStatusEnum.SYNCED, (
        f"sync_status={r.sync_status}; expected SYNCED once received >= expected"
    )


def test_one_shot_with_no_media_does_not_change_state(client, db):
    """Text-only one-shot report → received_media stays 0,
    sync_status not flipped to SYNCED via this code path (the existing
    expected_media=0 logic at /meta already handles text-only)."""
    payload = _base_payload("DEV-K2G-no-media", media=[])
    res = client.post("/api/v1/reports/", json=payload)
    assert res.status_code == 201

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    # received_media starts at 0; with no media we don't increment.
    assert r.received_media == 0


def test_one_shot_with_media_and_higher_expected_stays_partial(client, db):
    """POST with 2 media items but `expected_media=3` declared → stays
    PARTIAL since received (2) < expected (3). The remaining media is
    expected to arrive via /attach."""
    payload = _base_payload(
        "DEV-K2G-partial-expected",
        media=[
            {"type": "IMAGE", "url": _TINY_IMG, "resolution_tier": "SMALL", "file_size_bytes": 95},
            {"type": "AUDIO", "url": _TINY_AUDIO, "resolution_tier": "SMALL", "file_size_bytes": 48},
        ],
        expected_media=3,
    )
    res = client.post("/api/v1/reports/", json=payload)
    assert res.status_code == 201

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.received_media == 2
    assert r.expected_media == 3
    assert r.sync_status != SyncStatusEnum.SYNCED, (
        f"sync_status={r.sync_status}; should not promote when received < expected"
    )
