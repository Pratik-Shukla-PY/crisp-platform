"""R2.c (May 2026) — recovery observability metrics.

Three counters + one histogram:
  - crisp_media_recovery_total{outcome="succeeded"|"failed"}
  - crisp_media_recovery_duration_seconds  (histogram)
  - crisp_media_hard_deleted_total{reason}  (already covered in R2.b
    test file; this file focuses on the recovery success path)
  - crisp_disk_orphan_deleted_total{prefix}  (R3.b)

These are the levers the operator uses to tune the daemon's 30-min
soft-abandon deadline + spot a regression in the daemon-vs-handler
race.
"""
from __future__ import annotations

import base64
import io
import time
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image

from app.api.endpoints.reports import djb2_checksum
from app.models.report import Media


def _tiny_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 255, 255)).save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def _seed_report(client):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"R2C-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert res.status_code == 201
    return res.json()["id"]


def _seed_abandoned(db, report_id, *, abandoned_at, abandon_reason="chunks_never_arrived"):
    media_id = str(uuid.uuid4())
    m = Media(
        id=media_id,
        report_id=report_id,
        type="IMAGE",
        resolution_tier="MEDIUM",
        photo_group_id=str(uuid.uuid4()),
        url="",
        is_synced=False,
        chunk_count=1,
        received_chunks=0,
        completion_pct=0.0,
        assembly_status="failed",
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
        recovered_at=None,
    )
    db.add(m)
    db.commit()
    return media_id


class TestRecoveryMetrics:
    def test_recovery_increments_succeeded_counter(self, client, db):
        from app.core.observability import media_recovery_total
        before = media_recovery_total.labels(outcome="succeeded")._value.get()
        report_id = _seed_report(client)
        media_id = _seed_abandoned(
            db, report_id,
            abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=40),
        )
        # Post the final chunk → revives + assembles → stamps recovered_at.
        blob = _tiny_jpeg()
        encoded = base64.b64encode(blob).decode("ascii")
        res = client.post(f"/api/v1/reports/{report_id}/media/chunk", json={
            "media_id": media_id, "type": "IMAGE",
            "seq_num": 0, "total_chunks": 1,
            "data": encoded, "checksum": djb2_checksum(encoded),
            "resolution_tier": "MEDIUM",
            "client_blur_applied": True,
            "upload_generation": 1,
        })
        assert res.status_code == 200, res.text
        # Wait for assembly + metric tick.
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.recovered_at is not None:
                break
            time.sleep(0.05)
        after = media_recovery_total.labels(outcome="succeeded")._value.get()
        assert after == before + 1, (
            f"Expected media_recovery_total{{succeeded}} +1, "
            f"got delta={after - before}"
        )

    def test_recovery_duration_histogram_observed(self, client, db):
        from app.core.observability import media_recovery_duration_seconds
        # Snapshot the histogram's total count before sweep.
        before_count = media_recovery_duration_seconds._sum.get()
        report_id = _seed_report(client)
        media_id = _seed_abandoned(
            db, report_id,
            # 33 minutes ago → histogram bucket 1800s-3600s.
            abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=33),
        )
        blob = _tiny_jpeg()
        encoded = base64.b64encode(blob).decode("ascii")
        res = client.post(f"/api/v1/reports/{report_id}/media/chunk", json={
            "media_id": media_id, "type": "IMAGE",
            "seq_num": 0, "total_chunks": 1,
            "data": encoded, "checksum": djb2_checksum(encoded),
            "resolution_tier": "MEDIUM",
            "client_blur_applied": True,
            "upload_generation": 1,
        })
        assert res.status_code == 200
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.recovered_at is not None:
                break
            time.sleep(0.05)
        after_count = media_recovery_duration_seconds._sum.get()
        assert after_count > before_count, (
            f"Histogram total-sum must increase after a successful "
            f"recovery; before={before_count}, after={after_count}"
        )
        # The observed value is on the order of 33 minutes (1980 s) ± wall clock.
        observed = after_count - before_count
        assert 1500 < observed < 2500, (
            f"Expected ~1980s observed (33 min abandon window), got {observed}"
        )
