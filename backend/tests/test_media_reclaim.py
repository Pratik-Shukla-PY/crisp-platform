"""Phase F image-reliability — operator-gated media reclaim endpoint.

`POST /api/v1/reports/media/{media_id}/reclaim` with mode in
{retry_assembly, mark_abandoned}. Tests the operator surface that lets
an analyst recover from a sweep-abandoned upload or declare one
permanently lost.
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.models.report import (
    Device, Report, Media, MediaTypeEnum, ResolutionEnum, SourceEnum
)


def _seed_report_with_media(
    db,
    *,
    assembly_status: str,
    chunk_count: int,
    received_chunks: int,
    abandoned_at=None,
    abandon_reason=None,
):
    # Unique per-row identifiers; multiple tests share the session DB.
    suffix = uuid.uuid4().hex[:8]
    d = Device(device_hash=f"reclaim-test-{suffix}")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"reclaim-{suffix}",
    )
    db.add(r)
    db.flush()
    m = Media(
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.ORIGINAL,
        url="",
        chunk_count=chunk_count,
        received_chunks=received_chunks,
        assembly_status=assembly_status,
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    db.refresh(r)
    return r, m


def test_reclaim_retry_assembly_revives_failed_with_complete_chunks(client, db, analyst_token):
    """Operator clicks Reclaim on a sweep-abandoned row whose chunks are
    actually all there. Endpoint resets state to pending + clears
    abandon metadata + resubmits to the assembly pool."""
    r, m = _seed_report_with_media(
        db,
        assembly_status="failed",
        chunk_count=4,
        received_chunks=4,
        abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        abandon_reason="assembly_worker_lost",
    )

    with patch("app.api.endpoints.reports._assembly_executor.submit") as mock_submit:
        res = client.post(
            f"/api/v1/reports/media/{m.id}/reclaim",
            json={"mode": "retry_assembly"},
            headers={"Authorization": f"Bearer {analyst_token}"},
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["mode"] == "retry_assembly"
    assert body["assembly_status"] == "pending"
    assert body["abandoned_at"] is None
    assert body["abandon_reason"] is None
    mock_submit.assert_called_once()  # row resubmitted to the pool

    db.refresh(m)
    assert m.assembly_status == "pending"
    assert m.abandoned_at is None
    assert m.abandon_reason is None


def test_reclaim_retry_rejects_when_chunks_incomplete(client, db, analyst_token):
    """Operator can't retry assembly on a row whose chunks were never
    fully delivered — the bytes aren't there to assemble. Endpoint
    surfaces a 400 with a redirect hint to mark_abandoned."""
    r, m = _seed_report_with_media(
        db,
        assembly_status="failed",
        chunk_count=7,
        received_chunks=4,
        abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        abandon_reason="chunks_never_arrived",
    )

    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "retry_assembly"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 400
    assert "received_chunks=4" in res.text
    assert "chunk_count=7" in res.text
    assert "mark_abandoned" in res.text  # hint operator at the right mode


def test_reclaim_mark_abandoned_flips_pending_to_failed_with_metadata(client, db, analyst_token):
    """Operator declares a stuck-pending upload permanently lost. Row
    flips to 'failed' + abandoned_at + abandon_reason='operator_manual'."""
    r, m = _seed_report_with_media(
        db,
        assembly_status="pending",
        chunk_count=7,
        received_chunks=4,
        abandoned_at=None,
        abandon_reason=None,
    )

    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "mark_abandoned"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["assembly_status"] == "failed"
    assert body["abandon_reason"] == "operator_manual"
    assert body["abandoned_at"] is not None

    db.refresh(m)
    assert m.assembly_status == "failed"
    assert m.abandon_reason == "operator_manual"


def test_reclaim_mark_abandoned_preserves_original_abandon_metadata(client, db, analyst_token):
    """Marking an already-abandoned row again must not overwrite the
    original abandoned_at + abandon_reason — preserves audit fidelity."""
    original_when = datetime.now(timezone.utc) - timedelta(hours=2)
    r, m = _seed_report_with_media(
        db,
        assembly_status="failed",
        chunk_count=7,
        received_chunks=4,
        abandoned_at=original_when,
        abandon_reason="chunks_never_arrived",
    )

    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "mark_abandoned"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 200

    db.refresh(m)
    assert m.abandon_reason == "chunks_never_arrived"  # original preserved
    # Timestamp preserved within a second (Pg precision).
    assert abs((m.abandoned_at - original_when).total_seconds()) < 1.0


def test_reclaim_unknown_mode_returns_400(client, db, analyst_token):
    r, m = _seed_report_with_media(
        db, assembly_status="pending", chunk_count=2, received_chunks=2
    )
    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "delete_everything"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 400
    assert "Unknown mode" in res.text


def test_reclaim_missing_media_returns_404(client, analyst_token):
    res = client.post(
        "/api/v1/reports/media/00000000-0000-0000-0000-000000000000/reclaim",
        json={"mode": "mark_abandoned"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 404


def test_reclaim_requires_auth(client, db):
    """Endpoint is analyst-gated — no token = 401."""
    r, m = _seed_report_with_media(
        db, assembly_status="pending", chunk_count=2, received_chunks=2
    )
    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "mark_abandoned"},
    )
    assert res.status_code in (401, 403)


def test_reclaim_writes_audit_log_entry(client, db, analyst_token, analyst_user):
    """Reclaim actions emit MEDIA_RECLAIM_* AuthAuditLog rows so the
    detail panel's admin-action ribbon can show them."""
    from app.models.auth import AuthAuditLog

    r, m = _seed_report_with_media(
        db, assembly_status="pending", chunk_count=2, received_chunks=2
    )
    res = client.post(
        f"/api/v1/reports/media/{m.id}/reclaim",
        json={"mode": "mark_abandoned"},
        headers={"Authorization": f"Bearer {analyst_token}"},
    )
    assert res.status_code == 200

    db.expire_all()
    logs = db.query(AuthAuditLog).filter(
        AuthAuditLog.resource_id == r.id,
        AuthAuditLog.action == "MEDIA_RECLAIM_ABANDON",
    ).all()
    assert len(logs) == 1, "expected exactly one MEDIA_RECLAIM_ABANDON audit row"
    assert m.id in (logs[0].details or "")
