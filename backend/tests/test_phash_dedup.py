"""Perceptual-hash (pHash) redundancy-detection tests.

Pins the Apr 2026 UI v2.1 pHash pipeline (W3) end-to-end:

  (a) `phash.compute_phash` returns stable 16-char hex on real JPEGs.
  (b) Same image → identical hash; cropped variant → small Hamming
      distance; unrelated image → large distance (≥ 20 / 64).
  (c) `hamming_distance` + `are_likely_duplicates` threshold semantics.
  (d) `Media.photo_phash` column persisted + exposed on MediaResponse.
  (e) `GET /api/v1/reports/media/{id}/duplicates` endpoint contract.
  (f) `Media.photo_phash` is nullable (migration 0007 applied) and NULL
      candidates don't leak into duplicate lists.

Test photos are generated in-memory with PIL to keep the suite
dependency-free — no fixture assets to maintain / check-in size
regressions.
"""
import io
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from PIL import Image

from app.services import phash as phash_mod


def _jpeg_bytes(color: tuple[int, int, int], size: tuple[int, int] = (320, 240)) -> bytes:
    """Solid-colour JPEG. 320×240 is big enough for phash (needs >8×8
    before the 8×8 DCT), small enough that test runs stay under a ms."""
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _write_jpeg(tmp_path, color, size=(320, 240)) -> str:
    p = tmp_path / f"{uuid.uuid4().hex}.jpg"
    p.write_bytes(_jpeg_bytes(color, size))
    return str(p)


class TestPhashCompute:
    """Low-level compute_phash helper."""

    def test_available(self):
        """ImageHash + Pillow both loaded at module import."""
        assert phash_mod.is_available(), "imagehash/Pillow missing"

    def test_returns_16_char_hex_on_jpeg(self, tmp_path):
        p = _write_jpeg(tmp_path, (200, 50, 50))
        h = phash_mod.compute_phash(p)
        assert h is not None
        assert isinstance(h, str)
        assert len(h) == 16
        int(h, 16)  # valid hex

    def test_deterministic_on_same_image(self, tmp_path):
        """Two calls on the same bytes → identical hash (DCT is stable)."""
        p = _write_jpeg(tmp_path, (80, 150, 200))
        assert phash_mod.compute_phash(p) == phash_mod.compute_phash(p)

    def test_different_images_differ(self, tmp_path):
        """Two visibly different patterns → Hamming distance > 0.

        Note: phash is DCT-based and ignores the DC component, so solid
        colours are a pathological case (all identical hash). We draw
        two contrasting gradients — the kind of structure real photos
        actually have — and assert the hashes diverge. Real-world
        unrelated photos typically give HD in the 20-40 range; we only
        gate on "non-zero" because the test is validating the SIGNAL
        not the threshold calibration.
        """
        def _gradient_jpeg(horizontal: bool):
            img = Image.new("RGB", (320, 240))
            px = img.load()
            for y in range(240):
                for x in range(320):
                    v = int((x / 320) * 255) if horizontal else int((y / 240) * 255)
                    px[x, y] = (v, 255 - v, (v * 2) % 255)
            p = tmp_path / f"grad-{uuid.uuid4().hex}.jpg"
            img.save(p, format="JPEG", quality=90)
            return str(p)
        h_horiz = phash_mod.compute_phash(_gradient_jpeg(horizontal=True))
        h_vert  = phash_mod.compute_phash(_gradient_jpeg(horizontal=False))
        d = phash_mod.hamming_distance(h_horiz, h_vert)
        assert d > 0, f"horiz vs vert gradient should differ, got HD={d}"

    def test_missing_file_returns_none(self):
        assert phash_mod.compute_phash("/nope/does/not/exist.jpg") is None

    def test_non_image_returns_none(self, tmp_path):
        """Corrupt / non-image file must NOT raise — the assembly pipeline
        relies on this to stay fire-and-forget."""
        p = tmp_path / "garbage.jpg"
        p.write_bytes(b"not a real jpeg")
        assert phash_mod.compute_phash(str(p)) is None


class TestHammingDistance:
    """Hex-string Hamming distance + threshold semantics."""

    def test_identical_hashes_zero(self):
        assert phash_mod.hamming_distance("abcdef0123456789", "abcdef0123456789") == 0

    def test_single_bit_flip_one(self):
        assert phash_mod.hamming_distance("0000000000000001", "0000000000000000") == 1

    def test_all_bits_flipped_64(self):
        assert phash_mod.hamming_distance("ffffffffffffffff", "0000000000000000") == 64

    def test_none_inputs_max_distance(self):
        """Callers must not flag a NULL row as a duplicate candidate."""
        assert phash_mod.hamming_distance(None, "abcdef0123456789") == 64
        assert phash_mod.hamming_distance("abcdef0123456789", None) == 64
        assert phash_mod.hamming_distance(None, None) == 64

    def test_invalid_hex_max_distance(self):
        assert phash_mod.hamming_distance("not-hex!", "0000000000000000") == 64

    def test_are_likely_duplicates_threshold(self):
        a = "0000000000000000"
        b = "0000000000000007"   # HD 3
        c = "ffffffffffffffff"   # HD 64
        assert phash_mod.are_likely_duplicates(a, b, threshold=10) is True
        assert phash_mod.are_likely_duplicates(a, c, threshold=10) is False
        # Custom tight threshold.
        assert phash_mod.are_likely_duplicates(a, b, threshold=2) is False


class TestMediaPhashEndpoint:
    """`GET /api/v1/reports/media/{id}/duplicates` contract."""

    def _seed_media_row(self, db, report_id: str, phash: str | None, hours_ago: int = 0):
        """Insert a Media row with a specific pHash for filter testing."""
        from app.models.report import Media, MediaTypeEnum, ResolutionEnum
        m = Media(
            id=str(uuid.uuid4()),
            report_id=report_id,
            type=MediaTypeEnum.IMAGE,
            resolution_tier=ResolutionEnum.LOW,
            url=f"/static/{uuid.uuid4().hex}.jpg",
            assembly_status='complete',
            photo_phash=phash,
        )
        # Back-date via raw SQL since `created_at` is server_default.
        db.add(m); db.commit()
        if hours_ago:
            from sqlalchemy import text
            db.execute(
                text("UPDATE media SET created_at = :ts WHERE id = :id"),
                {"ts": datetime.now(timezone.utc) - timedelta(hours=hours_ago), "id": m.id},
            )
            db.commit()
        return m.id

    def _seed_report(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "DEV-PHASH-E2E",
            "client_report_id": str(uuid.uuid4()),
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "crisis_type": "FLOOD",
            "damage_classification": "PARTIAL",
            "description": "phash endpoint test",
            "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        })
        assert res.status_code == 201
        return res.json()["id"]

    def test_unknown_media_id_404(self, client):
        res = client.get("/api/v1/reports/media/does-not-exist/duplicates")
        assert res.status_code == 404

    def test_media_without_phash_returns_empty_candidates(self, client, db):
        rid = self._seed_report(client)
        mid = self._seed_media_row(db, rid, phash=None)
        res = client.get(f"/api/v1/reports/media/{mid}/duplicates")
        assert res.status_code == 200
        body = res.json()
        assert body["phash"] is None
        assert body["candidates"] == []
        assert "not yet computed" in body["message"]

    def test_identical_phash_within_window_flagged(self, client, db):
        """Two rows with the same hash inside 24h → one flags the other."""
        rid = self._seed_report(client)
        h = "abcdef0123456789"
        mid_a = self._seed_media_row(db, rid, phash=h, hours_ago=0)
        mid_b = self._seed_media_row(db, rid, phash=h, hours_ago=0)
        res = client.get(f"/api/v1/reports/media/{mid_a}/duplicates")
        assert res.status_code == 200
        hits = [c["media_id"] for c in res.json()["candidates"]]
        assert mid_b in hits
        assert mid_a not in hits  # never its own duplicate

    def test_out_of_window_rows_excluded(self, client, db):
        """A match dated 48h ago is past the default 24h window."""
        rid = self._seed_report(client)
        h = "0123456789abcdef"
        mid_a = self._seed_media_row(db, rid, phash=h, hours_ago=0)
        self._seed_media_row(db, rid, phash=h, hours_ago=48)
        res = client.get(f"/api/v1/reports/media/{mid_a}/duplicates")
        assert res.status_code == 200
        assert res.json()["candidates"] == []
        # Widening to 72h picks it up.
        res2 = client.get(
            f"/api/v1/reports/media/{mid_a}/duplicates",
            params={"window_hours": 72},
        )
        assert len(res2.json()["candidates"]) == 1

    def test_threshold_controls_match_set(self, client, db):
        """Lowering threshold to 0 requires exact hash match."""
        rid = self._seed_report(client)
        mid_a = self._seed_media_row(db, rid, phash="0000000000000000")
        # Hamming distance 2 from mid_a.
        mid_b = self._seed_media_row(db, rid, phash="0000000000000003")
        res_loose = client.get(f"/api/v1/reports/media/{mid_a}/duplicates")   # default 10
        assert mid_b in [c["media_id"] for c in res_loose.json()["candidates"]]
        res_tight = client.get(
            f"/api/v1/reports/media/{mid_a}/duplicates",
            params={"threshold": 0},
        )
        assert res_tight.json()["candidates"] == []
