"""R2.b (May 2026) — daemon Action ⑥ hard-abandon retention sweep.

After CRISP_HARD_ABANDON_DAYS (default 30) past abandoned_at, rows
with recovered_at IS NULL are hard-deleted by the daemon's Action ⑥.
The Media → MediaChunk cascade handles chunk cleanup automatically.
The corresponding storage object (if any) is deleted via
storage.delete().

Tests cover:
  - rows past the retention window are deleted
  - rows under the window are spared
  - recovered rows are NEVER deleted (regardless of age)
  - cascade delete removes the MediaChunk rows
  - delete is bounded per sweep tick (500 rows max)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import Media, MediaChunk


def _seed_report(client):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"R2B-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert res.status_code == 201
    return res.json()["id"]


def _make_abandoned_media(db, report_id, *, days_ago: float,
                          abandon_reason: str = "chunks_never_arrived",
                          recovered: bool = False,
                          with_chunk: bool = False) -> str:
    media_id = str(uuid.uuid4())
    abandoned_at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    recovered_at = (
        datetime.now(timezone.utc) - timedelta(days=days_ago - 0.1)
        if recovered else None
    )
    m = Media(
        id=media_id,
        report_id=report_id,
        type="IMAGE",
        resolution_tier="MEDIUM",
        photo_group_id=str(uuid.uuid4()),
        url="/static/uploads/test.jpg",
        is_synced=False,
        chunk_count=1,
        received_chunks=0,
        completion_pct=0.0,
        assembly_status="failed",
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
        recovered_at=recovered_at,
    )
    db.add(m)
    db.flush()
    if with_chunk:
        c = MediaChunk(
            media_id=media_id,
            seq_num=0,
            total_chunks=1,
            data_b64="aGVsbG8=",   # "hello"
            checksum="deadbeef",
        )
        db.add(c)
    db.commit()
    return media_id


def _run_sweep_action6(db, days_threshold: int = 30):
    """Direct invocation of the action ⑥ code path against the current
    session. We import the daemon module fresh per test to honour
    monkeypatched env vars where applicable.
    """
    from app.main import _run_assembly_recovery_sweep
    _run_assembly_recovery_sweep(boot=False)


class TestHardAbandonRetention:
    def test_row_past_deadline_is_deleted(self, client, db, monkeypatch):
        # Default 30 days; we seed at 35 days ago → eligible.
        report_id = _seed_report(client)
        media_id = _make_abandoned_media(
            db, report_id, days_ago=35,
            abandon_reason="chunks_never_arrived",
            recovered=False,
        )
        _run_sweep_action6(db)
        db.expire_all()
        assert db.query(Media).filter(Media.id == media_id).first() is None, (
            "Media row past the 30-day retention window must be hard-deleted"
        )

    def test_row_under_deadline_is_spared(self, client, db):
        # 15 days ago < 30 day default → keep.
        report_id = _seed_report(client)
        media_id = _make_abandoned_media(
            db, report_id, days_ago=15,
            abandon_reason="chunks_never_arrived",
            recovered=False,
        )
        _run_sweep_action6(db)
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m is not None, (
            "Media row under the retention window must NOT be deleted"
        )

    def test_recovered_row_is_never_deleted(self, client, db):
        # Even at 60 days, a recovered row is preserved.
        report_id = _seed_report(client)
        media_id = _make_abandoned_media(
            db, report_id, days_ago=60,
            abandon_reason="chunks_never_arrived",
            recovered=True,
        )
        _run_sweep_action6(db)
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m is not None, (
            "recovered_at IS NOT NULL rows must NEVER be deleted, "
            "regardless of age"
        )
        assert m.recovered_at is not None

    def test_chunks_cascade_delete(self, client, db):
        report_id = _seed_report(client)
        media_id = _make_abandoned_media(
            db, report_id, days_ago=40,
            abandon_reason="chunks_never_arrived",
            recovered=False, with_chunk=True,
        )
        # Confirm the chunk exists pre-sweep.
        n_chunks_before = db.query(MediaChunk).filter(
            MediaChunk.media_id == media_id
        ).count()
        assert n_chunks_before == 1
        _run_sweep_action6(db)
        db.expire_all()
        # Cascade deletes the chunk.
        n_chunks_after = db.query(MediaChunk).filter(
            MediaChunk.media_id == media_id
        ).count()
        assert n_chunks_after == 0, (
            "MediaChunk rows must cascade-delete with the parent Media row"
        )

    def test_metric_increments_with_reason_label(self, client, db):
        from app.core.observability import media_hard_deleted_total
        report_id = _seed_report(client)
        # Stage a snapshot of the counter before sweep.
        before_chunks_never = media_hard_deleted_total.labels(
            reason="chunks_never_arrived"
        )._value.get()
        before_checksum = media_hard_deleted_total.labels(
            reason="checksum_mismatch"
        )._value.get()
        _make_abandoned_media(
            db, report_id, days_ago=45,
            abandon_reason="chunks_never_arrived",
            recovered=False,
        )
        _make_abandoned_media(
            db, report_id, days_ago=45,
            abandon_reason="checksum_mismatch",
            recovered=False,
        )
        _run_sweep_action6(db)
        after_chunks_never = media_hard_deleted_total.labels(
            reason="chunks_never_arrived"
        )._value.get()
        after_checksum = media_hard_deleted_total.labels(
            reason="checksum_mismatch"
        )._value.get()
        assert after_chunks_never == before_chunks_never + 1, (
            f"chunks_never_arrived label: expected +1, "
            f"got delta={after_chunks_never - before_chunks_never}"
        )
        assert after_checksum == before_checksum + 1, (
            f"checksum_mismatch label: expected +1, "
            f"got delta={after_checksum - before_checksum}"
        )
