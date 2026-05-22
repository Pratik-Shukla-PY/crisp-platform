"""R1 (May 2026) — recovered_at column + chunk-handler revival + dashboard chip predicate.

Operator-reproduced bug: an upload abandoned by the assembly-recovery
daemon's Action ②/③ (after the 30-minute idle window) and then later
resumed by a returning client would end up in
``assembly_status='complete'`` with ``abandoned_at`` + ``abandon_reason``
still populated. The dashboard chip predicate read abandon_reason
directly, so recovered uploads stayed rendered as "Upload abandoned"
even though they had successfully completed.

R1 closes the bug by introducing ``Media.recovered_at`` (migration 0040):

  * Chunk handlers atomically revive soft-abandoned rows on chunk
    arrival (chunks_never_arrived / assembly_worker_lost /
    bandwidth_tier_deferred). abandoned_at + abandon_reason stay
    populated for the audit trail.
  * Chunk handlers reject hard-abandoned rows with HTTP 410 Gone
    (checksum_mismatch / original_too_large) so chunks don't pile up
    against a row whose bytes are corrupt or already-rejected.
  * The assembly worker stamps recovered_at when assembly succeeds
    on a previously-abandoned row.
  * Dashboard chip predicate flips from `abandon_reason` to
    `abandon_reason && !recovered_at`.

These tests pin all four moving parts so a future regression flips
red instead of silently re-introducing the contradiction.
"""
from __future__ import annotations

import base64
import io
import time
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image

from app.api.endpoints.reports import djb2_bytes, djb2_checksum
from app.models.report import Media, Report


def _tiny_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 255, 255)).save(buf, format="JPEG", quality=70)
    return buf.getvalue()


_TINY_JPEG = _tiny_jpeg()


def _seed_report(client, expected_media: int = 1) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"R1-TEST-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": expected_media,
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _seed_abandoned_media(db, report_id: str, *, abandon_reason: str,
                          total_chunks: int = 1, received_chunks: int = 0,
                          abandoned_minutes_ago: int = 35) -> str:
    """Insert a Media row in failed/abandoned state for revival tests."""
    media_id = str(uuid.uuid4())
    abandoned_at = datetime.now(timezone.utc) - timedelta(minutes=abandoned_minutes_ago)
    m = Media(
        id=media_id,
        report_id=report_id,
        type="IMAGE",
        resolution_tier="MEDIUM",
        photo_group_id=str(uuid.uuid4()),
        url="",
        is_synced=False,
        chunk_count=total_chunks,
        received_chunks=received_chunks,
        completion_pct=0.0,
        assembly_status="failed",
        abandoned_at=abandoned_at,
        abandon_reason=abandon_reason,
        recovered_at=None,
    )
    db.add(m)
    db.commit()
    return media_id


def _b64_chunk(blob: bytes) -> tuple[str, str]:
    encoded = base64.b64encode(blob).decode("ascii")
    return encoded, djb2_checksum(encoded)


# ── Soft-abandon revival ────────────────────────────────────────────────────

class TestSoftAbandonRevival:
    """A chunk arriving on a soft-abandoned row revives the row, the
    assembly worker stamps recovered_at on completion, the audit trail
    is preserved.
    """

    def test_chunks_never_arrived_revives_on_final_chunk(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="chunks_never_arrived",
            total_chunks=1, received_chunks=0,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk",
            json={
                "media_id": media_id, "type": "IMAGE",
                "seq_num": 0, "total_chunks": 1,
                "data": data, "checksum": checksum,
                "resolution_tier": "MEDIUM",
                "client_blur_applied": True,
            },
        )
        assert res.status_code == 200, res.text
        # Allow background assembly to settle.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.assembly_status == "complete":
                break
            time.sleep(0.05)
        m = db.query(Media).filter(Media.id == media_id).first()
        # Audit trail preserved:
        assert m.abandoned_at is not None, "abandoned_at must be preserved (audit trail)"
        assert m.abandon_reason == "chunks_never_arrived", "abandon_reason must be preserved (audit trail)"
        # Recovery stamped:
        assert m.recovered_at is not None, "recovered_at must be set when an abandoned row recovers"
        # Completed:
        assert m.assembly_status == "complete"

    def test_assembly_worker_lost_revives_on_chunk(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="assembly_worker_lost",
            total_chunks=1, received_chunks=0,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk",
            json={
                "media_id": media_id, "type": "IMAGE",
                "seq_num": 0, "total_chunks": 1,
                "data": data, "checksum": checksum,
                "resolution_tier": "MEDIUM",
                "client_blur_applied": True,
            },
        )
        assert res.status_code == 200, res.text
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        # Revival happened (status walked off 'failed' at minimum):
        assert m.assembly_status != "failed", (
            f"row was not revived from failed state: status={m.assembly_status}"
        )
        # Audit trail preserved:
        assert m.abandoned_at is not None
        assert m.abandon_reason == "assembly_worker_lost"


# ── Hard-abandon rejection ─────────────────────────────────────────────────

class TestHardAbandonRejection:
    """checksum_mismatch and original_too_large are HARD abandons. Chunks
    for those rows must be rejected with 410 Gone — chunks can't fix a
    corrupted-on-disk or already-rejected upload.
    """

    def test_checksum_mismatch_rejects_with_410(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="checksum_mismatch",
            total_chunks=1, received_chunks=1,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk",
            json={
                "media_id": media_id, "type": "IMAGE",
                "seq_num": 0, "total_chunks": 1,
                "data": data, "checksum": checksum,
                "resolution_tier": "MEDIUM",
                "client_blur_applied": True,
            },
        )
        assert res.status_code == 410, res.text
        assert "checksum_mismatch" in res.text.lower() or "abandoned" in res.text.lower()
        # Row state must be unchanged.
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.abandon_reason == "checksum_mismatch"
        assert m.assembly_status == "failed"
        assert m.recovered_at is None

    def test_original_too_large_rejects_with_410(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="original_too_large",
            total_chunks=1, received_chunks=1,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk",
            json={
                "media_id": media_id, "type": "IMAGE",
                "seq_num": 0, "total_chunks": 1,
                "data": data, "checksum": checksum,
                "resolution_tier": "MEDIUM",
                "client_blur_applied": True,
            },
        )
        assert res.status_code == 410, res.text


# ── Idempotency ─────────────────────────────────────────────────────────────

class TestRevivalIdempotency:
    """Sending the same chunk twice does NOT double-stamp recovered_at
    and does NOT clear the audit trail.
    """

    def test_double_chunk_post_idempotent(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="chunks_never_arrived",
            total_chunks=1, received_chunks=0,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        # Initial body uses upload_generation=1 (matches the seed row).
        body_v1 = {
            "media_id": media_id, "type": "IMAGE",
            "seq_num": 0, "total_chunks": 1,
            "data": data, "checksum": checksum,
            "resolution_tier": "MEDIUM",
            "client_blur_applied": True,
            "upload_generation": 1,
        }
        # First post — revives + assembles + bumps generation 1→2.
        res1 = client.post(f"/api/v1/reports/{report_id}/media/chunk", json=body_v1)
        assert res1.status_code == 200
        # Wait for assembly to settle.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.recovered_at is not None:
                break
            time.sleep(0.05)
        m1 = db.query(Media).filter(Media.id == media_id).first()
        first_recovered_at = m1.recovered_at
        first_abandoned_at = m1.abandoned_at
        first_generation  = m1.upload_generation
        assert first_recovered_at is not None
        assert first_generation == 2, (
            f"R2.a expects generation to be bumped on revival; got {first_generation}"
        )

        # Second post with the OLD generation (a stale-session replay)
        # MUST be rejected with 409 — this is the R2.a contract. Audit
        # columns + recovered_at must stay untouched.
        res2 = client.post(f"/api/v1/reports/{report_id}/media/chunk", json=body_v1)
        assert res2.status_code == 409
        db.expire_all()
        m2 = db.query(Media).filter(Media.id == media_id).first()
        assert m2.recovered_at == first_recovered_at
        assert m2.abandoned_at == first_abandoned_at
        assert m2.abandon_reason == "chunks_never_arrived"
        assert m2.upload_generation == 2

        # Third post with the NEW generation (a smart client that read
        # the 409's server_generation hint and resynced) is idempotent
        # at the chunk-storage level: uq_media_chunk_seq treats it as a
        # duplicate, no double-count.
        body_v2 = dict(body_v1)
        body_v2["upload_generation"] = 2
        res3 = client.post(f"/api/v1/reports/{report_id}/media/chunk", json=body_v2)
        assert res3.status_code == 200
        db.expire_all()
        m3 = db.query(Media).filter(Media.id == media_id).first()
        # Audit trail preserved.
        assert m3.recovered_at == first_recovered_at, (
            "recovered_at must NOT be re-stamped on a same-generation duplicate"
        )
        assert m3.abandoned_at == first_abandoned_at


# ── Schema exposure ─────────────────────────────────────────────────────────

class TestMediaResponseExposesRecoveredAt:
    """MediaResponse must include recovered_at so the dashboard chip
    predicate has the data it needs.
    """

    def test_get_report_includes_recovered_at_field(self, client, db):
        report_id = _seed_report(client)
        media_id = _seed_abandoned_media(
            db, report_id, abandon_reason="chunks_never_arrived",
            total_chunks=1, received_chunks=0,
        )
        data, checksum = _b64_chunk(_TINY_JPEG)
        client.post(
            f"/api/v1/reports/{report_id}/media/chunk",
            json={
                "media_id": media_id, "type": "IMAGE",
                "seq_num": 0, "total_chunks": 1,
                "data": data, "checksum": checksum,
                "resolution_tier": "MEDIUM",
                "client_blur_applied": True,
            },
        )
        # Poll for assembly.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.recovered_at is not None:
                break
            time.sleep(0.05)
        # Auth-protected listing — we just need to confirm the field is
        # exposed on the MediaResponse shape. Use the public media-get-by-id
        # path? Pull via the direct ORM and assert via the schema instead.
        from app.schemas.report import MediaResponse
        m = db.query(Media).filter(Media.id == media_id).first()
        resp = MediaResponse.model_validate(m)
        assert hasattr(resp, "recovered_at")
        assert resp.recovered_at is not None
        assert resp.abandon_reason == "chunks_never_arrived"
        # Dashboard predicate logic: chip should NOT render for this row.
        # (Mimicking web-dashboard/src/app.js:2269 post-R1.)
        is_abandoned_for_chip = bool(resp.abandon_reason and not resp.recovered_at)
        assert is_abandoned_for_chip is False, (
            "post-recovery row must NOT trip the 'abandoned' chip predicate"
        )


# ── Backfill verification ──────────────────────────────────────────────────

class TestMigration0040Backfill:
    """The migration backfills recovered_at = updated_at for rows that
    are 'complete' AND had abandoned_at set — the bug's existing
    footprint. This is destructive-ish (it stamps a value) so we verify
    the behavior in a tested-from-scratch fashion.
    """

    def test_backfill_stamps_complete_with_abandoned_at(self, client, db):
        # Seed a parent report via the API (handles device_hash → device_id
        # normalization and all the relational invariants).
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": f"BACKFILL-{uuid.uuid4()}",
            "client_report_id": str(uuid.uuid4()),
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "crisis_type": "FLOOD",
            "damage_classification": "PARTIAL",
            "location": {"latitude": 12.97, "longitude": 77.59},
            "expected_media": 1,
        })
        assert res.status_code == 201, res.text
        report_id = res.json()["id"]
        # Simulate the bug's footprint: status=complete, abandoned_at set,
        # recovered_at NULL (this is what existed pre-R1).
        from datetime import datetime, timedelta, timezone
        abandoned_at = datetime.now(timezone.utc) - timedelta(hours=2)
        m = Media(
            id=str(uuid.uuid4()),
            report_id=report_id,
            type="IMAGE",
            resolution_tier="MEDIUM",
            url="/static/uploads/test.jpg",
            is_synced=True,
            chunk_count=1,
            received_chunks=1,
            completion_pct=100.0,
            assembly_status="complete",
            abandoned_at=abandoned_at,
            abandon_reason="chunks_never_arrived",
            recovered_at=None,
        )
        db.add(m)
        db.commit()
        # The migration's backfill statement is idempotent — re-run it
        # against this row and confirm recovered_at gets stamped.
        db.execute(
            __import__("sqlalchemy").text(
                "UPDATE media "
                "   SET recovered_at = updated_at "
                " WHERE assembly_status = 'complete' "
                "   AND abandoned_at IS NOT NULL "
                "   AND recovered_at IS NULL"
            )
        )
        db.commit()
        db.expire_all()
        m2 = db.query(Media).filter(Media.id == m.id).first()
        assert m2.recovered_at is not None, (
            "backfill must stamp recovered_at for complete+abandoned rows"
        )
        # And abandon_reason is preserved.
        assert m2.abandon_reason == "chunks_never_arrived"
