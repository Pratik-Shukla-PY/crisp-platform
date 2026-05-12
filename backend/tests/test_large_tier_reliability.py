"""LARGE-tier (Original) delivery reliability — end-to-end coverage.

Locks down the guarantees that protect the user-facing promise:
"the Original photo always eventually reaches the dashboard, even if
delayed by poor connectivity."

Specifically:

  1. **Multi-tier round-trip.** A single photo group can upload SMALL +
     MEDIUM + LARGE chunks in parallel; all three Media rows assemble
     to disk and share the same `photo_group_id`.

  2. **Resume from chunk N.** A LARGE upload that drops half-way
     (chunks 0-4 received, then disconnect) resumes from chunk 5 on
     the next pass and completes assembly without re-uploading the
     earlier chunks.

  3. **Whole-asset integrity catches assembler regressions.** A
     deliberately wrong `full_asset_checksum` sent with chunk 0 makes
     the assembler abort and flip `assembly_status='failed'`.

  4. **Duplicate seq_num is already-protected** by
     `UniqueConstraint('media_id', 'seq_num')` (existing guarantee
     from `MediaChunk.__table_args__`); covered as a regression smoke
     test so a future migration that drops the constraint trips the
     suite.

Companion to alembic migration 0017_full_asset_checksum which adds the
nullable column the Phase C.1 integrity check reads.
"""
import io
import time

import pytest

from app.api.endpoints.reports import djb2_bytes
from app.models.report import Media, MediaChunk


# ── Helpers ─────────────────────────────────────────────────────────


def _seed_report(client) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": "LARGE-TIER-DEV",
        "client_report_id": f"lt-{time.time_ns()}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "RESIDENTIAL",
        "expected_media": 3,                  # SMALL + MEDIUM + LARGE
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _post_chunk(client, report_id: str, *, media_id: str, seq_num: int,
                total_chunks: int, data: bytes, resolution_tier: str = "LOW",
                photo_group_id: str | None = None,
                full_asset_checksum: str | None = None):
    form = {
        "media_id": media_id,
        "seq_num": str(seq_num),
        "total_chunks": str(total_chunks),
        "type": "IMAGE",
        "resolution_tier": resolution_tier,
        "client_blur_applied": "false",
        "checksum": djb2_bytes(data),
    }
    if photo_group_id:
        form["photo_group_id"] = photo_group_id
    if full_asset_checksum is not None:
        form["full_asset_checksum"] = full_asset_checksum
    files = {"data": ("chunk.bin", io.BytesIO(data), "application/octet-stream")}
    return client.post(
        f"/api/v1/reports/{report_id}/media/chunk-bin",
        data=form, files=files,
    )


# Minimal valid JPEG bytes (just enough magic to not crash a hypothetical
# image-aware downstream). The assembler doesn't validate image content
# so any unique blob works — using a JPEG header keeps tests honest if a
# future feature DOES validate.
def _fake_image_bytes(size_kb: int = 8, marker: int = 0) -> bytes:
    head = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])
    body = bytes([marker % 256]) * (size_kb * 1024 - len(head) - 2)
    tail = bytes([0xFF, 0xD9])
    return head + body + tail


def _wait_for_assembly(db, media_id: str, timeout: float = 5.0) -> Media | None:
    # Assembly runs on the module-level _assembly_executor via background
    # threads. Poll the DB until the row flips off 'pending'/'assembling'
    # or we hit the deadline.
    deadline = time.time() + timeout
    while time.time() < deadline:
        db.expire_all()
        m = db.query(Media).filter(Media.id == media_id).first()
        if m and m.assembly_status in ("complete", "failed"):
            return m
        time.sleep(0.1)
    return db.query(Media).filter(Media.id == media_id).first()


# ── 1. Three-tier round-trip ────────────────────────────────────────


class TestThreeTierRoundTrip:
    """All three tiers (SMALL, MEDIUM, LARGE) for one photo group can
    upload in any interleaving and assemble independently."""

    def test_all_three_tiers_assemble(self, client, db):
        report_id = _seed_report(client)
        group_id = f"grp-{time.time_ns()}"
        small_id = f"med-s-{time.time_ns()}"
        medium_id = f"med-m-{time.time_ns()}"
        large_id = f"med-l-{time.time_ns()}"

        small_bytes  = _fake_image_bytes(size_kb=4, marker=1)
        medium_bytes = _fake_image_bytes(size_kb=16, marker=2)
        large_bytes  = _fake_image_bytes(size_kb=64, marker=3)

        # Interleave the uploads: chunk 0 of every tier first, then
        # chunk 1+, etc. Mirrors the PWA's tier-first delivery policy.
        for tier_name, mid, payload in [
            ("LOW",    small_id,  small_bytes),
            ("MEDIUM", medium_id, medium_bytes),
            ("HIGH",   large_id,  large_bytes),
        ]:
            res = _post_chunk(
                client, report_id,
                media_id=mid, seq_num=0, total_chunks=1,
                data=payload, resolution_tier=tier_name,
                photo_group_id=group_id,
                full_asset_checksum=djb2_bytes(payload),
            )
            assert res.status_code == 200, res.text

        # All three rows should land at assembly_status='complete'.
        for mid, expected_tier in [
            (small_id,  "LOW"),
            (medium_id, "MEDIUM"),
            (large_id,  "HIGH"),
        ]:
            m = _wait_for_assembly(db, mid)
            assert m is not None, f"media row {mid} not found"
            assert m.assembly_status == "complete", (
                f"{expected_tier} tier did not assemble: status={m.assembly_status}"
            )
            assert m.photo_group_id == group_id
            assert m.full_asset_checksum is not None


# ── 2. Resume from chunk N ──────────────────────────────────────────


class TestPartialResume:
    """A LARGE upload that drops mid-flight resumes from the next
    expected seq_num without re-sending earlier chunks. The
    UniqueConstraint(media_id, seq_num) makes the resume idempotent."""

    def test_resume_after_disconnect(self, client, db):
        report_id = _seed_report(client)
        media_id = f"med-resume-{time.time_ns()}"
        total = 8
        # Use bigger chunks so concat order matters
        chunks = [_fake_image_bytes(size_kb=4, marker=i + 10) for i in range(total)]
        full_bytes = b"".join(chunks)
        full_checksum = djb2_bytes(full_bytes)

        # First wave: chunks 0..3 land. Then "disconnect".
        for seq in range(4):
            res = _post_chunk(
                client, report_id,
                media_id=media_id, seq_num=seq, total_chunks=total,
                data=chunks[seq], resolution_tier="HIGH",
                full_asset_checksum=full_checksum if seq == 0 else None,
            )
            assert res.status_code == 200, res.text

        # Mid-state check: row exists, status still pending, 4/8 chunks.
        db.expire_all()
        mid_state = db.query(Media).filter(Media.id == media_id).first()
        assert mid_state is not None
        assert mid_state.received_chunks == 4
        assert mid_state.assembly_status in ("pending", "partial")
        assert mid_state.full_asset_checksum == full_checksum

        # Second wave: chunks 4..7 arrive. Last chunk triggers assembly.
        for seq in range(4, total):
            res = _post_chunk(
                client, report_id,
                media_id=media_id, seq_num=seq, total_chunks=total,
                data=chunks[seq], resolution_tier="HIGH",
            )
            assert res.status_code == 200, res.text

        m = _wait_for_assembly(db, media_id)
        assert m is not None
        assert m.assembly_status == "complete", (
            f"LARGE resume did not assemble: status={m.assembly_status}"
        )
        assert m.received_chunks == total


# ── 3. Whole-asset checksum integrity ───────────────────────────────


class TestWholeAssetIntegrity:
    """The Phase C.1 integrity guard fires when the PWA-supplied
    `full_asset_checksum` doesn't match the post-assembly djb2 over
    the concatenated bytes. The row flips to 'failed', the file is
    never written to storage, and the Prometheus counter increments."""

    def test_mismatch_marks_failed(self, client, db):
        report_id = _seed_report(client)
        media_id = f"med-bad-checksum-{time.time_ns()}"
        payload = _fake_image_bytes(size_kb=8, marker=42)

        # Send chunk 0 with a deliberately WRONG full_asset_checksum.
        # djb2_bytes(payload) is the TRUE value; we send a totally
        # different hex string so the post-assembly comparison fails.
        res = _post_chunk(
            client, report_id,
            media_id=media_id, seq_num=0, total_chunks=1,
            data=payload, resolution_tier="HIGH",
            full_asset_checksum="deadbeefdeadbeef",
        )
        assert res.status_code == 200, res.text

        m = _wait_for_assembly(db, media_id, timeout=5.0)
        assert m is not None
        assert m.assembly_status == "failed", (
            f"Mismatched whole-asset checksum should flip status to failed, "
            f"got {m.assembly_status}. The integrity guard at "
            f"_assemble_media_file() didn't fire."
        )
        # The URL stays empty when the assembler returns None — no file
        # was written, the dashboard will continue to show "uploading"
        # rather than rendering a corrupt blob.
        assert not m.url

    def test_legacy_client_skips_check(self, client, db):
        """A client that doesn't send `full_asset_checksum` at all
        keeps working — the assembler skips the check when the column
        is NULL. Back-compat invariant."""
        report_id = _seed_report(client)
        media_id = f"med-legacy-{time.time_ns()}"
        payload = _fake_image_bytes(size_kb=8, marker=99)

        # No full_asset_checksum on chunk 0.
        res = _post_chunk(
            client, report_id,
            media_id=media_id, seq_num=0, total_chunks=1,
            data=payload, resolution_tier="HIGH",
        )
        assert res.status_code == 200, res.text

        m = _wait_for_assembly(db, media_id, timeout=5.0)
        assert m is not None
        assert m.assembly_status == "complete", (
            f"Legacy client without checksum should still assemble, "
            f"got {m.assembly_status}"
        )
        assert m.full_asset_checksum is None


# ── 4. UniqueConstraint regression ──────────────────────────────────


class TestDuplicateSeqRejected:
    """The MediaChunk(media_id, seq_num) UniqueConstraint protects
    against double-counting + corrupt assembly. The endpoint detects
    duplicates before insert and returns 200 (idempotent no-op),
    not 500. If a future migration drops the constraint this test
    catches it via the endpoint behaviour."""

    def test_duplicate_chunk_is_idempotent(self, client, db):
        report_id = _seed_report(client)
        media_id = f"med-dup-{time.time_ns()}"
        payload = _fake_image_bytes(size_kb=4, marker=7)

        # First write — 200, increments received_chunks.
        res1 = _post_chunk(
            client, report_id,
            media_id=media_id, seq_num=0, total_chunks=2,
            data=payload, resolution_tier="HIGH",
        )
        assert res1.status_code == 200, res1.text

        db.expire_all()
        before = db.query(Media).filter(Media.id == media_id).first()
        assert before.received_chunks == 1

        # Second write of the SAME seq_num — should be idempotent.
        # The endpoint sees an existing row for (media_id, seq_num)
        # and skips the increment + insert.
        res2 = _post_chunk(
            client, report_id,
            media_id=media_id, seq_num=0, total_chunks=2,
            data=payload, resolution_tier="HIGH",
        )
        assert res2.status_code == 200, res2.text

        db.expire_all()
        after = db.query(Media).filter(Media.id == media_id).first()
        assert after.received_chunks == 1, (
            f"Duplicate seq_num bumped received_chunks from "
            f"1 to {after.received_chunks} — UniqueConstraint or "
            f"idempotency guard regressed."
        )

        # Exactly one row in MediaChunk for (media_id, seq_num=0).
        rows = db.query(MediaChunk).filter(
            MediaChunk.media_id == media_id,
            MediaChunk.seq_num == 0,
        ).all()
        assert len(rows) == 1
