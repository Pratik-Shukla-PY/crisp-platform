"""B-A — URL gating: `GET /media/{id}/file` returns 425 Too Early
while `pii_blur_status='pending'`.

Closes the 5-30 s window where the storage object held the
assembled-but-unblurred bytes and a /file request would redirect to
them. The route guard at `get_media_redirect` in reports.py
short-circuits IMAGE rows in 'pending' with HTTP 425 + Retry-After: 2.

Test matrix:

| Media state                                    | Expected response |
|------------------------------------------------|-------------------|
| IMAGE, pii_blur_status='pending'               | 425 Too Early     |
| IMAGE, pii_blur_status='complete_clean'        | 302 (redirect)    |
| IMAGE, pii_blur_status='complete_with_redact…' | 302 (redirect)    |
| IMAGE, pii_blur_status='failed'                | 302 (redirect — operator sees the red chip on the card) |
| IMAGE, pii_blur_status=NULL (legacy)           | 302 (no guard)    |
| AUDIO, pii_blur_status='pending'               | 302 (audio bypass)|
| /thumb route                                   | 302 always (never gated — partial-assembly previews are intended to lead) |
| Non-existent media_id                          | 404               |

The 425 status is RFC 8470 — tells CDNs/browsers it's transient
(not 404 to cache). The Retry-After: 2 advises a polite 2-second
poll. Dashboard polls every 4 s anyway, so this is purely a hint
for ad-hoc consumers.
"""
from __future__ import annotations

import pytest

from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


def _seed_media(db, *, media_type, pii_status, dev_hash, idx=0):
    """Seed Device + Report + Media row in a known state for HTTP probing."""
    d = Device(device_hash=f"{dev_hash}-{idx}")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"425-{dev_hash}-{idx}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=1,
    )
    db.add(r)
    db.flush()
    m = Media(
        report_id=r.id,
        type=media_type,
        resolution_tier=ResolutionEnum.SMALL,
        url=f"/static/test-{dev_hash}-{idx}.{('jpg' if media_type == MediaTypeEnum.IMAGE else 'ogg')}",
        pii_blur_status=pii_status,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# ── 425 path: IMAGE + pending → Too Early ────────────────────────────────────


def test_image_pending_returns_425_too_early(client, db):
    """IMAGE row in 'pending' MUST return 425 — the gate's whole purpose."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.IMAGE, pii_status='pending',
        dev_hash="gate-pending", idx=1,
    )
    res = client.get(f"/api/v1/reports/media/{m.id}/file", follow_redirects=False)
    assert res.status_code == 425, (
        f"Expected 425 Too Early while blur pending; got {res.status_code}. "
        f"Body: {res.text}"
    )
    # RFC 8470 says servers SHOULD include Retry-After. We do.
    assert "Retry-After" in res.headers, "425 response must include Retry-After"
    assert res.headers["Retry-After"] == "2"


# ── 302 path: terminal statuses lift the gate ───────────────────────────────


@pytest.mark.parametrize("terminal_status", [
    'complete_clean',
    'complete_with_redactions',
    'failed',
])
def test_image_terminal_status_returns_302(client, db, terminal_status):
    """Any non-'pending' status lifts the gate. Even 'failed' redirects —
    the operator still needs to fetch + render the file to manually
    review (and the dashboard renders the red chip alongside)."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.IMAGE, pii_status=terminal_status,
        dev_hash=f"gate-{terminal_status}", idx=1,
    )
    res = client.get(f"/api/v1/reports/media/{m.id}/file", follow_redirects=False)
    # 302 redirect to local /static/ in test mode, or to presigned S3 in prod.
    # Either way it's NOT 425 and NOT 404.
    assert res.status_code in (200, 302, 307), (
        f"status={terminal_status}: expected redirect or success, "
        f"got {res.status_code}. Body: {res.text[:200]}"
    )


def test_image_null_status_legacy_returns_302(client, db):
    """Legacy IMAGE rows (pre-0037, pii_blur_status=NULL) bypass the gate —
    we can't retroactively determine their state, so render and let the
    operator decide via the legacy 'no chip' rendering."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.IMAGE, pii_status=None,
        dev_hash="gate-null-legacy", idx=1,
    )
    res = client.get(f"/api/v1/reports/media/{m.id}/file", follow_redirects=False)
    assert res.status_code != 425, (
        f"NULL status (legacy) should NOT be gated; got {res.status_code}"
    )


# ── AUDIO bypass: audio rows are never gated ────────────────────────────────


def test_audio_pending_bypasses_gate(client, db):
    """Audio rows never enter the blur pipeline; even if some test
    fixture seeds 'pending' on an audio row, the gate must NOT fire
    (audio has no PII concept).

    In practice audio rows write 'not_needed' immediately at /attach
    time, but the route guard explicitly checks `media.type == 'IMAGE'`
    rather than checking the status field alone — defensive coding
    against any future state where an audio row briefly carries the
    'pending' label."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.AUDIO, pii_status='pending',
        dev_hash="gate-audio-pending", idx=1,
    )
    res = client.get(f"/api/v1/reports/media/{m.id}/file", follow_redirects=False)
    assert res.status_code != 425, (
        f"AUDIO 'pending' must bypass the gate; got {res.status_code}"
    )


# ── /thumb route: never gated ────────────────────────────────────────────────


def test_thumb_route_not_gated(client, db):
    """Thumbnails are explicit partial-assembly previews — they exist
    BY DESIGN before the full file is ready, and the dashboard expects
    them to lead. The 425 gate applies ONLY to /file."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.IMAGE, pii_status='pending',
        dev_hash="gate-thumb-skip", idx=1,
    )
    # Even seeding a thumbnail_url isn't necessary — the test asserts
    # the gate doesn't fire 425 on /thumb. Whatever happens
    # (404 because thumbnail_url=None, OR 302 if set) is fine as long
    # as it's not 425.
    res = client.get(f"/api/v1/reports/media/{m.id}/thumb", follow_redirects=False)
    assert res.status_code != 425, (
        f"/thumb must never return 425; got {res.status_code}"
    )


# ── 404 fall-through ────────────────────────────────────────────────────────


def test_nonexistent_media_id_returns_404(client, db):
    """Unknown media_id → 404. The gate doesn't run; we never get
    far enough to check pii_blur_status."""
    fake_id = "00000000-0000-0000-0000-000000000000"
    res = client.get(f"/api/v1/reports/media/{fake_id}/file", follow_redirects=False)
    assert res.status_code == 404, (
        f"Unknown media_id should 404; got {res.status_code}"
    )


# ── Transition: pending → terminal lifts the gate within one poll ───────────


def test_pending_to_terminal_transition_lifts_gate(client, db):
    """Simulate the live transition: a row goes from 'pending' to
    'complete_with_redactions' (the worker just finished). The very
    next /file request must lift the gate without any cache invalidation
    needed on the client side."""
    m = _seed_media(
        db, media_type=MediaTypeEnum.IMAGE, pii_status='pending',
        dev_hash="gate-transition", idx=1,
    )

    # 1st request: gated.
    res_pending = client.get(
        f"/api/v1/reports/media/{m.id}/file", follow_redirects=False,
    )
    assert res_pending.status_code == 425

    # Worker finishes — update the row directly to simulate
    # _run_server_pii_blur's terminal DB write.
    db.query(Media).filter(Media.id == m.id).update(
        {'pii_blur_status': 'complete_with_redactions'},
        synchronize_session=False,
    )
    db.commit()

    # 2nd request: gate lifts.
    res_done = client.get(
        f"/api/v1/reports/media/{m.id}/file", follow_redirects=False,
    )
    assert res_done.status_code != 425, (
        f"Gate should have lifted after status transition; got "
        f"{res_done.status_code}"
    )
