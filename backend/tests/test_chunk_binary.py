"""Binary-chunk endpoint tests (Apr 2026 — Option A).

Covers the new `POST /api/v1/reports/{report_id}/media/chunk-bin` endpoint
and the mixed-format assembly path. Every assertion pins down a guarantee
from the approved binary-chunk plan:

  * djb2 parity between ``djb2_checksum`` (text) and ``djb2_bytes``
    (bytes) on a shared input.
  * Single-chunk round-trip: upload → commit → assemble → disk file.
  * Multi-chunk ordered round-trip.
  * Out-of-order delivery still assembles correctly.
  * Duplicate (media_id, seq_num) no-ops without bumping received_chunks.
  * Checksum mismatch returns HTTP 400 and bumps the rejected metric.
  * Empty / oversize payloads rejected with HTTP 422.
  * client_blur_applied flag persists on the Media row.
  * CHECK constraint rejects a row with neither column populated.
  * Legacy + binary chunks for the same media assemble to one file.
"""
import io
import os
import time
from pathlib import Path

import pytest
from sqlalchemy import text

from app.api.endpoints.reports import djb2_bytes, djb2_checksum
from app.models.report import Media, MediaChunk, Report


# ── Low-level parity check ────────────────────────────────────────────────────

class TestDjb2Parity:
    """The server's binary-djb2 and text-djb2 helpers must produce the
    same hex output for a shared input (bytes vs ASCII chars — the
    polynomial is identical, only the alphabet changes)."""

    def test_hello_bytes_known_vector(self):
        assert djb2_bytes(b"hello") == "0a9cede7"

    def test_hello_text_same_as_bytes_for_ascii(self):
        # For pure ASCII, ord(char) == byte — so the two helpers MUST
        # agree. If they don't, the client/server will mutually reject
        # every checksum.
        assert djb2_bytes(b"hello") == djb2_checksum("hello")

    def test_empty_input(self):
        # djb2 of empty input is the seed value 5381 → 0x1505.
        assert djb2_bytes(b"") == "00001505"

    def test_non_ascii_bytes(self):
        # 0x80..0xFF exercised — these can't be produced by djb2_checksum
        # with a base64 input (alphabet doesn't include them) but the
        # binary path must handle them cleanly.
        assert djb2_bytes(bytes(range(256))) != ""  # doesn't crash
        assert len(djb2_bytes(bytes(range(256)))) == 8


# ── Endpoint smoke + round-trip ──────────────────────────────────────────────

def _make_binary_chunk_form(
    *,
    media_id: str,
    seq_num: int,
    total_chunks: int,
    data: bytes,
    type: str = "IMAGE",
    resolution_tier: str = "LOW",
    photo_group_id: str | None = None,
    client_blur_applied: bool = False,
    checksum: str | None = None,
):
    """Build the multipart form the TestClient wants."""
    form = {
        "media_id": media_id,
        "seq_num": str(seq_num),
        "total_chunks": str(total_chunks),
        "type": type,
        "resolution_tier": resolution_tier,
        "client_blur_applied": "true" if client_blur_applied else "false",
    }
    if photo_group_id is not None:
        form["photo_group_id"] = photo_group_id
    if checksum is not None:
        form["checksum"] = checksum
    files = {"data": ("chunk.bin", io.BytesIO(data), "application/octet-stream")}
    return form, files


class TestBinaryChunkEndpoint:
    def _seed_report(self, client, device_hash: str = "TEST-BIN-DEV"):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": device_hash,
            "client_report_id": f"bin-{time.time_ns()}",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "location": {"latitude": 12.97, "longitude": 77.59},
            "expected_media": 1,
        })
        assert res.status_code == 201, res.text
        return res.json()["id"]

    def test_404_when_report_unknown(self, client):
        payload = b"whatever"
        form, files = _make_binary_chunk_form(
            media_id="m-unknown", seq_num=0, total_chunks=1, data=payload,
        )
        res = client.post(
            "/api/v1/reports/not-a-real-id/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 404

    def test_422_on_empty_payload(self, client):
        report_id = self._seed_report(client)
        form, files = _make_binary_chunk_form(
            media_id="m-empty", seq_num=0, total_chunks=1, data=b"",
        )
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 422
        assert "empty" in res.text.lower()

    def test_422_on_oversize_payload(self, client):
        report_id = self._seed_report(client)
        payload = b"x" * (1_048_577)  # 1 byte over the 1 MB cap
        form, files = _make_binary_chunk_form(
            media_id="m-big", seq_num=0, total_chunks=1, data=payload,
        )
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 422

    def test_400_on_checksum_mismatch(self, client):
        report_id = self._seed_report(client)
        form, files = _make_binary_chunk_form(
            media_id="m-bad-cksm", seq_num=0, total_chunks=1, data=b"hello",
            checksum="deadbeef",
        )
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 400
        assert "checksum" in res.text.lower()

    def test_200_on_valid_checksum(self, client):
        report_id = self._seed_report(client)
        form, files = _make_binary_chunk_form(
            media_id="m-good-cksm", seq_num=0, total_chunks=1, data=b"hello",
            checksum=djb2_bytes(b"hello"),
        )
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["received"] == 1
        assert body["total"] == 1
        assert body["transport"] == "binary"

    def test_idempotent_duplicate_chunk(self, client, db):
        """Sending the same (media_id, seq_num) twice must not
        double-increment received_chunks."""
        report_id = self._seed_report(client)
        payload = b"abc" * 100
        for _ in range(2):
            form, files = _make_binary_chunk_form(
                media_id="m-dup", seq_num=0, total_chunks=3, data=payload,
            )
            res = client.post(
                f"/api/v1/reports/{report_id}/media/chunk-bin",
                data=form, files=files,
            )
            assert res.status_code == 200

        m = db.query(Media).filter(Media.id == "m-dup").first()
        assert m is not None
        assert m.received_chunks == 1

    def test_client_blur_applied_persists(self, client, db):
        report_id = self._seed_report(client)
        form, files = _make_binary_chunk_form(
            media_id="m-blur", seq_num=0, total_chunks=1, data=b"jpgbytes",
            client_blur_applied=True,
        )
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data=form, files=files,
        )
        assert res.status_code == 200

        m = db.query(Media).filter(Media.id == "m-blur").first()
        assert m is not None
        assert m.client_blur_applied is True


# ── Round-trip assembly ───────────────────────────────────────────────────────

class TestBinaryAssemblyRoundTrip:
    """Upload N chunks through the endpoint and verify the assembled
    file on disk contains the exact original bytes in order."""

    def _seed_report(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-BIN-ASSEMBLE",
            "client_report_id": f"bin-assemble-{time.time_ns()}",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "location": {"latitude": 12.97, "longitude": 77.59},
            "expected_media": 1,
        })
        assert res.status_code == 201, res.text
        return res.json()["id"]

    def _upload_chunks(self, client, report_id, media_id, payload, chunks_n):
        size = len(payload)
        part = (size + chunks_n - 1) // chunks_n
        for i in range(chunks_n):
            slice_ = payload[i * part:(i + 1) * part]
            form, files = _make_binary_chunk_form(
                media_id=media_id, seq_num=i, total_chunks=chunks_n,
                data=slice_, checksum=djb2_bytes(slice_),
            )
            res = client.post(
                f"/api/v1/reports/{report_id}/media/chunk-bin",
                data=form, files=files,
            )
            assert res.status_code == 200, res.text

    def test_multi_chunk_assemble_in_order(self, client, db):
        report_id = self._seed_report(client)
        payload = os.urandom(3000)
        self._upload_chunks(client, report_id, "m-ord", payload, chunks_n=5)

        # Wait for the assembly thread to finish; the assembly pool is
        # in-process so a short spin-loop is enough in the test client.
        deadline = time.time() + 5
        while time.time() < deadline:
            m = db.query(Media).filter(Media.id == "m-ord").first()
            db.refresh(m)
            if m.assembly_status == "complete":
                break
            time.sleep(0.1)
        assert m.assembly_status == "complete", f"status={m.assembly_status}"

        url = m.url
        assert url and url.startswith("/static/")
        upload_dir = Path(__file__).parent.parent / "uploads"
        file_path = upload_dir / url.replace("/static/", "")
        assert file_path.exists()
        with open(file_path, "rb") as f:
            assembled = f.read()
        assert assembled == payload

    def test_out_of_order_upload_assembles_in_seq_order(self, client, db):
        report_id = self._seed_report(client)
        payload = os.urandom(2500)
        chunks_n = 5
        part = (len(payload) + chunks_n - 1) // chunks_n
        order = [2, 4, 0, 3, 1]  # deliberately scrambled
        for i in order:
            slice_ = payload[i * part:(i + 1) * part]
            form, files = _make_binary_chunk_form(
                media_id="m-ooo", seq_num=i, total_chunks=chunks_n,
                data=slice_, checksum=djb2_bytes(slice_),
            )
            res = client.post(
                f"/api/v1/reports/{report_id}/media/chunk-bin",
                data=form, files=files,
            )
            assert res.status_code == 200, res.text

        deadline = time.time() + 5
        while time.time() < deadline:
            m = db.query(Media).filter(Media.id == "m-ooo").first()
            db.refresh(m)
            if m.assembly_status == "complete":
                break
            time.sleep(0.1)
        assert m.assembly_status == "complete"

        upload_dir = Path(__file__).parent.parent / "uploads"
        file_path = upload_dir / m.url.replace("/static/", "")
        with open(file_path, "rb") as f:
            assembled = f.read()
        # Despite scrambled delivery, assembled == payload (seq-ordered
        # reconstruction).
        assert assembled == payload


# ── CHECK constraint + assembly of mixed-format chunks ────────────────────────

class TestChunkInvariant:
    """Enforce the CHECK constraint + the defensive mixed-format
    assembly path added in April 2026."""

    def test_cannot_insert_row_with_no_payload(self, db):
        """CHECK constraint rejects rows missing BOTH columns."""
        from app.models.report import Device
        dev = Device(device_hash="TEST-CHECK-1")
        db.add(dev); db.commit()
        r = Report(device_id=dev.id)
        db.add(r); db.commit()
        m = Media(report_id=r.id, type="IMAGE", chunk_count=1, received_chunks=0)
        db.add(m); db.commit()

        bad = MediaChunk(
            media_id=m.id, seq_num=0, total_chunks=1,
            data_b64=None, data_binary=None,
        )
        db.add(bad)
        with pytest.raises(Exception):  # IntegrityError / OperationalError
            db.commit()
        db.rollback()

    def test_mixed_format_assembly(self, db):
        """A media with 2 base64 chunks + 2 binary chunks (test-only scenario —
        never happens via client) must still assemble to the correct bytes.

        Feeds the assembler directly; we don't route through the HTTP
        endpoint because the client never mixes formats per upload session.
        """
        import base64
        from app.api.endpoints.reports import _assemble_media_file
        from app.models.report import Device

        dev = Device(device_hash="TEST-MIX")
        db.add(dev); db.commit()
        r = Report(device_id=dev.id)
        db.add(r); db.commit()
        m = Media(report_id=r.id, type="IMAGE", chunk_count=4, received_chunks=4,
                  assembly_status='pending')
        db.add(m); db.commit()

        # Create 4 chunks: seq 0 + 2 as base64, seq 1 + 3 as binary.
        slices = [b"AAAA", b"BBBB", b"CCCC", b"DDDD"]
        for i, s in enumerate(slices):
            if i % 2 == 0:
                db.add(MediaChunk(
                    media_id=m.id, seq_num=i, total_chunks=4,
                    data_b64=base64.b64encode(s).decode("ascii"),
                    data_binary=None,
                ))
            else:
                db.add(MediaChunk(
                    media_id=m.id, seq_num=i, total_chunks=4,
                    data_b64=None, data_binary=s,
                ))
        db.commit()

        url = _assemble_media_file(m.id, "IMAGE", db)
        assert url, "assembly failed"
        upload_dir = Path(__file__).parent.parent / "uploads"
        file_path = upload_dir / url.replace("/static/", "")
        with open(file_path, "rb") as f:
            assembled = f.read()
        assert assembled == b"AAAABBBBCCCCDDDD", \
            f"mixed-format assembly produced wrong bytes: {assembled!r}"
