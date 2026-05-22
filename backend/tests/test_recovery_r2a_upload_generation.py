"""R2.a (May 2026) — upload_generation epoch / zombie-replay defense.

The Media row carries an integer ``upload_generation`` (alembic 0041,
default 1). Clients must echo the current generation on every chunk
POST. The server:

  * Accepts matching-generation chunks
  * Rejects mismatched-generation chunks with HTTP 409 Conflict + a
    structured body that tells the client the server's current value
  * Bumps the row's generation by 1 on every soft-abandon revival, so
    any pre-revival in-flight chunk replay (a zombie tab, a stale
    service-worker fetch, a delayed retry from a no-longer-active
    session) 409s harmlessly

Legacy clients that don't send the field are treated as generation=1
(Pydantic default) which matches every row's default — so existing
clients keep working uninterrupted.
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


_TINY_JPEG = _tiny_jpeg()


def _seed_report(client) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"R2A-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _post_chunk(client, report_id, *, media_id, seq_num=0, total_chunks=1,
                blob=_TINY_JPEG, upload_generation=1):
    encoded = base64.b64encode(blob).decode("ascii")
    body = {
        "media_id": media_id,
        "type": "IMAGE",
        "seq_num": seq_num,
        "total_chunks": total_chunks,
        "data": encoded,
        "checksum": djb2_checksum(encoded),
        "resolution_tier": "MEDIUM",
        "photo_group_id": str(uuid.uuid4()),
        "client_blur_applied": True,
        "upload_generation": upload_generation,
    }
    return client.post(f"/api/v1/reports/{report_id}/media/chunk", json=body)


# ── Generation match path ───────────────────────────────────────────────────

class TestGenerationDefaultMatches:
    def test_default_generation_creates_row_with_generation_1(self, client, db):
        report_id = _seed_report(client)
        media_id = str(uuid.uuid4())
        res = _post_chunk(client, report_id, media_id=media_id, upload_generation=1)
        assert res.status_code == 200, res.text
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.upload_generation == 1

    def test_legacy_client_omitting_generation_works(self, client, db):
        # Pydantic default of 1 must let legacy clients keep working.
        report_id = _seed_report(client)
        media_id = str(uuid.uuid4())
        encoded = base64.b64encode(_TINY_JPEG).decode("ascii")
        body = {
            "media_id": media_id, "type": "IMAGE",
            "seq_num": 0, "total_chunks": 1,
            "data": encoded, "checksum": djb2_checksum(encoded),
            "resolution_tier": "MEDIUM",
            "client_blur_applied": True,
            # NOTE: no upload_generation field — simulates a legacy client
        }
        res = client.post(f"/api/v1/reports/{report_id}/media/chunk", json=body)
        assert res.status_code == 200, res.text


# ── Generation mismatch → 409 Conflict ──────────────────────────────────────

class TestGenerationMismatchRejects409:
    def _seed_row_at_generation(self, db, report_id, *, gen: int) -> str:
        media_id = str(uuid.uuid4())
        m = Media(
            id=media_id,
            report_id=report_id,
            type="IMAGE",
            resolution_tier="MEDIUM",
            photo_group_id=str(uuid.uuid4()),
            url="",
            is_synced=False,
            chunk_count=2,
            received_chunks=1,
            completion_pct=50.0,
            assembly_status="pending",
            upload_generation=gen,
        )
        db.add(m)
        db.commit()
        return media_id

    def test_stale_client_generation_rejected_with_409(self, client, db):
        report_id = _seed_report(client)
        media_id = self._seed_row_at_generation(db, report_id, gen=2)
        # Client sends an OLD generation (1) but server is at 2.
        res = _post_chunk(client, report_id, media_id=media_id,
                          seq_num=1, total_chunks=2, upload_generation=1)
        assert res.status_code == 409, res.text
        body = res.json()
        # Structured error with server's truth so the client can resync.
        assert body["detail"]["error"] == "upload_generation_mismatch"
        assert body["detail"]["server_generation"] == 2
        assert body["detail"]["client_generation"] == 1
        # Row state must be unchanged.
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.upload_generation == 2
        assert m.received_chunks == 1

    def test_client_ahead_of_server_also_409(self, client, db):
        # Symmetric — claiming a generation higher than the server's is
        # equally invalid. Only the EXACT match passes.
        report_id = _seed_report(client)
        media_id = self._seed_row_at_generation(db, report_id, gen=1)
        res = _post_chunk(client, report_id, media_id=media_id,
                          seq_num=1, total_chunks=2, upload_generation=5)
        assert res.status_code == 409, res.text


# ── Revival bumps generation ────────────────────────────────────────────────

class TestRevivalBumpsGeneration:
    def test_soft_abandon_revival_increments_generation(self, client, db):
        report_id = _seed_report(client)
        media_id = str(uuid.uuid4())
        # Seed an abandoned row at generation=1.
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
            abandoned_at=datetime.now(timezone.utc) - timedelta(minutes=35),
            abandon_reason="chunks_never_arrived",
            recovered_at=None,
            upload_generation=1,
        )
        db.add(m)
        db.commit()
        # Client comes back online and sends the final chunk with
        # generation=1 (which still matches before revival fires).
        res = _post_chunk(client, report_id, media_id=media_id,
                          upload_generation=1)
        assert res.status_code == 200, res.text
        # Allow background assembly to settle.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            db.expire_all()
            m2 = db.query(Media).filter(Media.id == media_id).first()
            if m2 and m2.upload_generation == 2:
                break
            time.sleep(0.05)
        m2 = db.query(Media).filter(Media.id == media_id).first()
        # Post-revival the generation must be bumped.
        assert m2.upload_generation == 2, (
            f"Expected upload_generation=2 after soft-abandon revival, "
            f"got {m2.upload_generation}"
        )

    def test_zombie_chunk_after_revival_409s(self, client, db):
        """The whole point of R2.a: a stale session whose chunks arrive
        AFTER revival must be rejected, not silently merge with the new
        session's chunks."""
        report_id = _seed_report(client)
        media_id = str(uuid.uuid4())
        # Seed at generation=1, then simulate post-revival state.
        m = Media(
            id=media_id,
            report_id=report_id,
            type="IMAGE",
            resolution_tier="MEDIUM",
            photo_group_id=str(uuid.uuid4()),
            url="",
            is_synced=False,
            chunk_count=2,
            received_chunks=0,
            completion_pct=0.0,
            assembly_status="pending",
            upload_generation=2,   # server has revived to gen=2
        )
        db.add(m)
        db.commit()
        # A zombie tab from the pre-revival session sends a chunk with
        # generation=1.
        res = _post_chunk(client, report_id, media_id=media_id,
                          seq_num=0, total_chunks=2, upload_generation=1)
        assert res.status_code == 409
        # No chunk should have been recorded.
        db.expire_all()
        m2 = db.query(Media).filter(Media.id == media_id).first()
        assert m2.received_chunks == 0
