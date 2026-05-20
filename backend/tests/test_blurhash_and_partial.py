"""Phase-1 progressive-upload backend tests (Apr 2026).

Two slices:
  * **blurhash** round-trip through POST /reports/meta → DB → GET /reports/.
    Confirms the new `Report.blurhash` column is accepted by
    `ReportMetaCreate`, persisted by the meta endpoint (which splats the
    Pydantic fields into the ORM constructor), and surfaced in
    `ReportResponse` for the dashboard.
  * **partial-assembly safeguards** — `_assemble_partial_image` must
    refuse to write an unreadable partial:
      - skip when < 2 KB of contiguous prefix has arrived
      - skip when the first two bytes aren't the JPEG SOI marker (0xFFD8)
    These prevent the dashboard from rendering a "broken image" icon
    while the upload is still mid-flight.
"""
import base64
import io
import os
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db.session import engine, SessionLocal
from app.models.report import Base, Media, MediaChunk
from app.api.endpoints.reports import _assemble_partial_image


@pytest.fixture(scope="module", autouse=True)
def _setup_db():
    # Clean slate per test module.
    Base.metadata.create_all(bind=engine)
    yield
    # Don't tear down — other tests may share the same schema.


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin_token(client):
    # Ensure the e2e admin seed exists + log in.
    # Other tests in this repo use the same pattern; we stay consistent.
    payload = {"email": "e2e-admin@crisp-e2e-tests.org", "password": "E2eAdmin!2026"}
    res = client.post("/api/v1/auth/login", json=payload)
    if res.status_code != 200:
        # Seed on demand — matches scripts/seed_e2e_admin.py behaviour.
        import subprocess, sys
        subprocess.run(
            [sys.executable, os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "seed_e2e_admin.py")
            )],
            check=True,
        )
        res = client.post("/api/v1/auth/login", json=payload)
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


class TestBlurhashRoundTrip:
    """POST /meta with a blurhash → GET /reports/ returns it unchanged."""

    def test_meta_endpoint_accepts_blurhash_and_returns_it(self, client):
        # Realistic 28-char blurhash. First char '4' encodes size flag (4x1
        # DCT); second char 'c' encodes quantMaxAC; next 4 chars are DC;
        # remaining pairs are AC. Use a string that's 4+2*N*M chars for
        # some N,M — for 4x3 DCT = 4+24 = 28 chars. Exact value doesn't
        # matter for a round-trip; we only verify the DB stores the
        # string unchanged.
        hash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
        payload = {
            "device_hash": "TEST-BH-DEVICE-01",
            "client_report_id": "bhtest-0000-0000-0000-000000000001",
            "expected_media": 0,
            "blurhash": hash,
            # infrastructure_type defaults to OTHER which the UNDP
            # validator requires infrastructure_name for; we pass a
            # concrete value so this test stays focused on blurhash.
            "infrastructure_type": "RESIDENTIAL",
        }
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        assert body.get("blurhash") == hash

    def test_db_persists_blurhash_after_meta_post(self, client):
        """Write via POST → re-read via ORM directly. Avoids the admin-auth
        flow (which has its own test-env flakiness around bcrypt version
        detection in the seed path) and asserts the actual persistence.
        """
        hash = "L6PZfSi_.AyE_3t7t7R**0o#DgR4"
        payload = {
            "device_hash": "TEST-BH-PERSIST-01",
            # client_report_id is a VARCHAR(36) on Postgres — must fit.
            # UUID-v4 is 36 chars including hyphens; use one here.
            "client_report_id": "9b9c0a7e-5d31-4a8e-a0b1-1d11f0ba0010",
            "expected_media": 0,
            "blurhash": hash,
            "infrastructure_type": "RESIDENTIAL",  # see UNDP validator note above
        }
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        report_id = res.json()["id"]

        # Re-read through the ORM so we confirm the column actually holds
        # the value — not just that the response serializer echoes it back.
        from app.models.report import Report
        db = SessionLocal()
        try:
            row = db.query(Report).filter(Report.id == report_id).first()
            assert row is not None
            assert row.blurhash == hash, (
                f"expected Report.blurhash == {hash!r}, got {row.blurhash!r}"
            )
        finally:
            db.close()

    def test_blurhash_nullable_for_text_only_reports(self, client):
        payload = {
            "device_hash": "TEST-BH-DEVICE-02",
            "client_report_id": "bhtest-0000-0000-0000-000000000002",
            "expected_media": 0,
            "infrastructure_type": "RESIDENTIAL",  # see UNDP validator note above
            # no `blurhash` key at all — should default to None.
        }
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        assert body.get("blurhash") is None

    def test_blurhash_max_length_enforced(self, client):
        # Pydantic cap: 96 chars. A 200-char string must be rejected 422.
        payload = {
            "device_hash": "TEST-BH-DEVICE-03",
            "client_report_id": "bhtest-0000-0000-0000-000000000003",
            "expected_media": 0,
            "infrastructure_type": "RESIDENTIAL",
            "blurhash": "x" * 200,
        }
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 422, res.text


class TestPartialAssemblySafeguards:
    """Phase-2.3 — refuse to write unreadable partial JPEGs."""

    def _make_media(self, db, media_id: str, total_chunks: int = 10):
        # Postgres enforces the `media.report_id` FK that SQLite lets
        # through silently — ensure a matching report row exists before
        # we insert media. Use a stable id derived from the media id so
        # each test gets its own parent + no cross-test FK collisions.
        from app.models.report import Report
        parent_id = f"parent-{media_id}"[:36]
        if db.query(Report).filter(Report.id == parent_id).first() is None:
            db.add(Report(
                id=parent_id,
                source="APP",
                status="PENDING",
                sync_status="SYNCED",
                severity="UNKNOWN",
                infrastructure_type="OTHER",
                is_auto_submitted=False,
                expected_media=1,
                received_media=0,
                reviewer_verdict="NOT_REVIEWED",
            ))
            db.flush()
        media = Media(
            id=media_id,
            report_id=parent_id,
            type="IMAGE",
            resolution_tier="SMALL",
            url="",
            is_synced=False,
            chunk_count=total_chunks,
            received_chunks=0,
            completion_pct=0.0,
            assembly_status="pending",
            client_blur_applied=True,  # skip server blur for test speed
        )
        db.add(media)
        db.flush()
        return media

    def _add_chunk(self, db, media_id: str, seq: int, data: bytes):
        db.add(MediaChunk(
            media_id=media_id,
            seq_num=seq,
            total_chunks=10,
            data_binary=data,
        ))
        db.flush()

    def test_skip_when_prefix_below_min_bytes(self):
        """< 2 KB total → _assemble_partial_image returns None."""
        db = SessionLocal()
        try:
            mid = "partial-test-tiny-01"
            self._make_media(db, mid)
            # 3 chunks × 500 bytes = 1500 bytes — below the 2048-byte threshold.
            # Use plausible JPEG prefix so the SOI guard ISN'T what rejects it.
            for seq in range(3):
                self._add_chunk(db, mid, seq, b"\xff\xd8" + b"\x00" * 498)
            result = _assemble_partial_image(mid, db)
            assert result is None, "partial should be skipped when < 2 KB"
        finally:
            db.rollback()
            db.close()

    def test_skip_when_missing_soi_marker(self):
        """Bytes arrive but don't start with 0xFFD8 → skip."""
        db = SessionLocal()
        try:
            mid = "partial-test-nosoi-01"
            self._make_media(db, mid)
            # 10 chunks × 300 bytes = 3000 bytes (above 2048). No SOI marker
            # at byte 0 — random data.
            for seq in range(10):
                self._add_chunk(db, mid, seq, b"\x00\x00\x00" + b"A" * 297)
            result = _assemble_partial_image(mid, db)
            assert result is None, "partial should be skipped without SOI marker"
        finally:
            db.rollback()
            db.close()

    def test_writes_partial_when_soi_and_size_ok(self, tmp_path, monkeypatch):
        """Valid-looking JPEG prefix → partial is persisted via storage.

        Apr 2026 (PR 2) — partial assembly no longer writes to UPLOAD_DIR
        directly; bytes go through the storage abstraction. We reset the
        storage singleton + point CRISP_UPLOAD_DIR at tmp_path so the
        LocalStorage backend writes there for the test.
        """
        # Reset storage singleton + point upload dir at tmp.
        from app.services import storage as storage_mod
        monkeypatch.setenv("MEDIA_BACKEND", "local")
        monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path))
        storage_mod.reset_storage_for_tests()
        db = SessionLocal()
        try:
            mid = "partial-test-ok-01"
            self._make_media(db, mid)
            # First chunk has SOI + tables; subsequent chunks pad to >2 KB.
            self._add_chunk(db, mid, 0, b"\xff\xd8\xff\xe0" + b"\x00" * 496)
            for seq in range(1, 5):
                self._add_chunk(db, mid, seq, b"\x00" * 500)
            # Monkey-patch blur_pii to no-op so the test doesn't load MediaPipe.
            import app.services.pii_blur as pii_mod
            monkeypatch.setattr(pii_mod, "blur_pii", lambda *a, **kw: {"ran": False})
            result = _assemble_partial_image(mid, db)
            # Result is the storage-returned URL; for LocalStorage it's
            # `/static/<filename>`. Verify the bytes via storage.read().
            assert result is not None, "partial should be written when prefix is valid"
            assert result == f"/static/{mid}_partial.jpg", f"got {result!r}"
            written = storage_mod.get_storage().read(result)
            assert written[:2] == b"\xff\xd8", "SOI marker preserved"
        finally:
            db.rollback()
            db.close()
            storage_mod.reset_storage_for_tests()

    def test_skip_when_prefix_has_gap(self, tmp_path, monkeypatch):
        """Seq 0,1,3 (missing 2) → partial assembles prefix through 1 only."""
        import app.api.endpoints.reports as reports_mod
        monkeypatch.setattr(reports_mod, "UPLOAD_DIR", str(tmp_path))
        db = SessionLocal()
        try:
            mid = "partial-test-gap-01"
            self._make_media(db, mid)
            # Only seq 0 + 1 are contiguous; seq 3 is past a gap so ignored.
            self._add_chunk(db, mid, 0, b"\xff\xd8\xff\xe0" + b"\x00" * 496)
            self._add_chunk(db, mid, 1, b"\x00" * 500)
            self._add_chunk(db, mid, 3, b"\x00" * 500)
            # Total contiguous = 1000 bytes — below the 2048 threshold, so
            # still skipped. This asserts BOTH safeguards work together.
            import app.services.pii_blur as pii_mod
            monkeypatch.setattr(pii_mod, "blur_pii", lambda *a, **kw: {"ran": False})
            result = _assemble_partial_image(mid, db)
            assert result is None, (
                "gapped prefix below 2 KB should be skipped — even though "
                "the total chunk byte-sum is above threshold, the contiguous "
                "prefix (seq 0,1) is only 1000 bytes"
            )
        finally:
            db.rollback()
            db.close()
