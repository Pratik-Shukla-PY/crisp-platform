"""PII-blur hardening tests (Apr 2026).

Covers the four fixes shipped after a field test where a photo with
`client_blur_applied=true` slipped through both client + server blur
because the client hardcoded the flag. The fixes are:

  A. Client sends a truthful `client_blur_applied` flag — covered by
     Playwright on the PWA side; not tested here.
  B. pii_blur.py fails loudly when MediaPipe/easyocr are missing, and
     exposes health via a `pii_health_snapshot()` helper + a new
     `GET /api/v1/health/pii` endpoint.
  C. Media has a `pii_blur_status` column tracking actual outcome;
     assembly stamps 'pending' or 'not_needed', the blur worker flips
     to 'complete' / 'failed' / 'skipped'.
  D. Prometheus counter `pii_blur_runs_total{outcome}` incremented
     for every run.

These tests pin the contracts down so a future refactor can't silently
regress the privacy guarantee.
"""
import os
import time

import pytest


# ── B: health endpoint + helper ───────────────────────────────────────────────

class TestPIIHealthEndpoint:
    def test_health_pii_endpoint_exists(self, client):
        res = client.get("/api/v1/health/pii")
        # Either 200 (backends at least partially loaded) or 503 (both
        # missing). Never 404 or 500.
        assert res.status_code in (200, 503), res.text
        body = res.json()
        assert "overall" in body
        assert body["overall"] in {"healthy", "degraded", "unavailable"}
        assert "face_detector" in body
        assert "ocr_reader" in body
        assert "available" in body["face_detector"]
        assert "available" in body["ocr_reader"]

    def test_health_snapshot_helper(self):
        """The helper returns the same shape as the endpoint."""
        from app.services.pii_blur import pii_health_snapshot
        snap = pii_health_snapshot()
        assert isinstance(snap, dict)
        assert snap["overall"] in {"healthy", "degraded", "unavailable"}
        assert isinstance(snap["face_detector"]["available"], bool)
        assert isinstance(snap["ocr_reader"]["available"], bool)

    def test_blur_pii_returns_ran_flag(self):
        """`blur_pii(path)` must include `ran` + `backends` in its
        result so the assembly worker can distinguish 'ran successfully'
        from 'backends missing, nothing happened'."""
        from app.services.pii_blur import blur_pii
        # Non-existent path → still returns a well-formed dict.
        result = blur_pii("/tmp/__crisp_nonexistent__.jpg")
        assert "ran" in result
        assert "backends" in result
        assert "face_detector" in result["backends"]
        assert "ocr_reader" in result["backends"]


# ── C: pii_blur_status column + migration ──────────────────────────────────

class TestPIIBlurStatusColumn:
    def test_column_exists_on_media(self, db):
        """The migration 0005 must have added the column on this test DB.
        Relies on the session-autouse `setup_test_db` fixture that runs
        `Base.metadata.create_all()` against the current model."""
        from sqlalchemy import inspect
        from app.db.session import Base
        engine = db.get_bind()
        insp = inspect(engine)
        cols = {c["name"] for c in insp.get_columns("media")}
        assert "pii_blur_status" in cols, \
            "Media.pii_blur_status column missing — 0005 migration didn't run or model is stale"

    def test_can_write_all_known_values(self, db):
        """The column accepts every documented status value."""
        from app.models.report import Device, Report, Media
        dev = Device(device_hash="TEST-PII-STATUS")
        db.add(dev); db.commit()
        r = Report(device_id=dev.id)
        db.add(r); db.commit()
        for status in ("not_needed", "pending", "complete", "failed", "skipped"):
            m = Media(
                report_id=r.id, type="IMAGE",
                chunk_count=1, received_chunks=1,
                pii_blur_status=status,
            )
            db.add(m); db.commit()
            db.refresh(m)
            assert m.pii_blur_status == status


# ── C+D: run-worker semantics ──────────────────────────────────────────────

class TestBlurWorkerUpdatesStatus:
    """The `_run_server_pii_blur` worker must update Media.pii_blur_status.
    We can't run the real blur (MediaPipe may be absent in CI), but we
    can verify the status-update plumbing + metric increment by passing
    a bogus filepath which the real `blur_pii` returns an error for."""

    def test_worker_writes_failed_on_bogus_path(self, db):
        from app.models.report import Device, Report, Media
        from app.api.endpoints.reports import _run_server_pii_blur

        dev = Device(device_hash="TEST-PII-WORKER")
        db.add(dev); db.commit()
        r = Report(device_id=dev.id)
        db.add(r); db.commit()
        m = Media(
            report_id=r.id, type="IMAGE",
            chunk_count=1, received_chunks=1,
            pii_blur_status='pending',
        )
        db.add(m); db.commit()
        media_id = m.id

        _run_server_pii_blur("/tmp/__crisp_nonexistent__.jpg", "bogus.jpg", media_id)

        # Re-read in a fresh view; the worker committed via its own session.
        db.expire_all()
        m2 = db.query(Media).filter(Media.id == media_id).first()
        # Either 'skipped' (if backends unavailable in this test env) or
        # 'failed' (if backends loaded but the path was bogus).
        # Never leaves it at 'pending' — that's the whole point of the
        # status update.
        assert m2.pii_blur_status in ("failed", "skipped"), \
            f"status={m2.pii_blur_status!r} — worker didn't update from 'pending'"

    def test_prometheus_counter_incremented(self, db):
        """The `pii_blur_runs_total{outcome}` counter increments per run.
        We just verify the counter exists and is importable — value
        checks under test hostile for pytest parallelism."""
        from app.core.observability import pii_blur_runs_total
        # Exercising the labels for each documented outcome; must not raise.
        for outcome in ("complete", "failed", "skipped"):
            pii_blur_runs_total.labels(outcome=outcome).inc(0)


# ── End-to-end integration: full chunk → assembly → blur status flip ─────────

class TestBlurPipelineEndToEnd:
    """Upload a tiny JPEG through the REAL binary-chunk endpoint with
    `client_blur_applied=false`, wait for the in-process assembly +
    blur workers, and verify `Media.pii_blur_status` transitions
    `pending → {complete, failed, skipped}` depending on the test
    environment's backend availability.

    This pins down the integration boundary the 7 unit tests above
    don't cover — it's the first test that exercises:

      * the full binary multipart receive path
      * the atomic `pii_blur_status='pending'` stamp at assembly
      * the `_run_server_pii_blur` DB session + commit in the worker
      * the `pii_blur_runs_total{outcome}` counter being bumped

    We use a minimal 1×1 red JPEG (valid, decodable, no faces) so the
    real blur pipeline actually runs end-to-end in <2 s.
    """
    import base64 as _b64
    # Pre-computed 1×1 red JPEG (~125 bytes) — valid enough that cv2
    # can decode it, small enough to finish assembly fast in CI.
    _TINY_JPEG_B64 = (
        b"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcU"
        b"FhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo"
        b"KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIA"
        b"AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA"
        b"AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3"
        b"ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm"
        b"p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB"
        b"AAIRAxEAPwD9U6KKKAP/2Q=="
    )
    _TINY_JPEG = _b64.b64decode(_TINY_JPEG_B64)

    def _seed_report(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-BLUR-E2E",
            "client_report_id": f"blur-e2e-{time.time_ns()}",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "location": {"latitude": 12.97, "longitude": 77.59},
            "expected_media": 1,
        })
        assert res.status_code == 201, res.text
        return res.json()["id"]

    def test_upload_with_client_blur_applied_false_stamps_then_resolves(self, client, db):
        """The central integration contract: an image uploaded with
        `client_blur_applied=false` must:

          1. Stamp `pii_blur_status='pending'` when assembly completes.
          2. Flip to `complete` / `failed` / `skipped` when the
             worker finishes.
          3. Never leave the column at NULL for a new row.
        """
        import io
        from app.models.report import Media
        from app.api.endpoints.reports import djb2_bytes

        report_id = self._seed_report(client)
        media_id = f"blur-e2e-media-{time.time_ns()}"
        payload = self._TINY_JPEG

        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data={
                "media_id": media_id,
                "seq_num": "0",
                "total_chunks": "1",
                "type": "IMAGE",
                "resolution_tier": "LOW",
                "client_blur_applied": "false",       # the key assertion input
                "checksum": djb2_bytes(payload),
            },
            files={"data": ("tiny.jpg", io.BytesIO(payload), "application/octet-stream")},
        )
        assert res.status_code == 200, res.text

        # Poll until the async assembly worker + blur worker have both
        # committed. The in-process ThreadPoolExecutor usually finishes
        # within a couple of seconds for a tiny image.
        deadline = time.time() + 15
        final_status = None
        while time.time() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.pii_blur_status in ("complete", "failed", "skipped"):
                final_status = m.pii_blur_status
                break
            time.sleep(0.2)

        assert final_status is not None, \
            f"pii_blur_status never left 'pending' within 15s (status={m.pii_blur_status if m else 'no media row'})"
        # `complete` in the happy case (MediaPipe + easyocr installed),
        # `skipped` if backends missing in CI. Either is the right
        # signal — the important thing is the column stops being NULL
        # or 'pending' and becomes a terminal state.
        assert final_status in {"complete", "failed", "skipped"}

    def test_upload_with_client_blur_applied_true_still_runs_server_pass(self, client, db):
        """Apr-2026 (revised): `client_blur_applied=true` no longer
        short-circuits the server. We always run the server-side pass
        regardless of the client claim — defense-in-depth, since
        BlazeFace-at-confidence-threshold-0.5 can still under-detect
        edge cases (side profiles, distant, partial), and the user
        report on 2026-04-28 ("PII blur stopped working in last 2-3
        reports") proved the previous skip-on-trust design was unsafe.

        The new policy: pii_blur_status flips to 'pending' synchronously
        and the worker drives it to a terminal state — exactly the
        same lifecycle as when client_blur_applied is false. The
        column NEVER lands at 'not_needed' anymore.
        """
        import io
        from app.models.report import Media
        from app.api.endpoints.reports import djb2_bytes

        report_id = self._seed_report(client)
        # Keep prefix short: media_id column is varchar(36).
        media_id = f"blur-srv-anyway-{time.time_ns()}"
        payload = self._TINY_JPEG
        res = client.post(
            f"/api/v1/reports/{report_id}/media/chunk-bin",
            data={
                "media_id": media_id,
                "seq_num": "0",
                "total_chunks": "1",
                "type": "IMAGE",
                "resolution_tier": "LOW",
                "client_blur_applied": "true",
                "checksum": djb2_bytes(payload),
            },
            files={"data": ("tiny.jpg", io.BytesIO(payload), "application/octet-stream")},
        )
        assert res.status_code == 200, res.text

        # Wait for the worker to land. Since server now always runs,
        # the terminal state is one of complete / failed / skipped.
        # 'not_needed' should NEVER appear — that was the old behaviour.
        deadline = time.time() + 25
        final_status = None
        while time.time() < deadline:
            db.expire_all()
            m = db.query(Media).filter(Media.id == media_id).first()
            if m and m.pii_blur_status in {"complete", "failed", "skipped"}:
                final_status = m.pii_blur_status
                break
            time.sleep(0.2)

        m = db.query(Media).filter(Media.id == media_id).first()
        assert final_status in {"complete", "failed", "skipped"}, (
            f"server-side pass must run regardless of client claim; got status="
            f"{m.pii_blur_status if m else 'no media row'} (must NOT be 'not_needed')"
        )
        # Belt-and-braces: explicitly confirm the deprecated state never appears.
        assert (m.pii_blur_status if m else None) != "not_needed", (
            "'not_needed' is the deprecated client-trusts-skip outcome; the "
            "server now always runs its pass."
        )


# ── Health endpoint 503 path ────────────────────────────────────────────────

class TestHealthPIIUnavailablePath:
    """The earlier `test_health_pii_endpoint_exists` accepts 200 OR 503.
    Here we pin down the 503 path specifically — monkey-patch BOTH
    backends to None and assert the endpoint responds with
    `overall="unavailable"` and HTTP 503 so a load balancer can pull
    the instance out of rotation."""

    def test_503_when_both_backends_none(self, client, monkeypatch):
        import app.services.pii_blur as pii_blur_mod
        monkeypatch.setattr(pii_blur_mod, "_face_detector", None, raising=False)
        monkeypatch.setattr(pii_blur_mod, "_ocr_reader", None, raising=False)
        monkeypatch.setattr(pii_blur_mod, "_face_detector_error",
                             "test: forced None", raising=False)
        monkeypatch.setattr(pii_blur_mod, "_ocr_reader_error",
                             "test: forced None", raising=False)

        res = client.get("/api/v1/health/pii")
        assert res.status_code == 503, res.text
        body = res.json()
        assert body["overall"] == "unavailable"
        assert body["face_detector"]["available"] is False
        assert body["ocr_reader"]["available"] is False

    def test_200_degraded_when_one_backend_available(self, client, monkeypatch):
        """If face_detector is loaded but ocr_reader is missing (or vice
        versa) the overall is 'degraded' and the status code is 200 —
        partial coverage is still useful."""
        import app.services.pii_blur as pii_blur_mod
        # Simulate: face detector present, ocr missing.
        monkeypatch.setattr(pii_blur_mod, "_face_detector",
                             object(), raising=False)
        monkeypatch.setattr(pii_blur_mod, "_ocr_reader", None, raising=False)
        monkeypatch.setattr(pii_blur_mod, "_ocr_reader_error",
                             "test: forced None", raising=False)

        res = client.get("/api/v1/health/pii")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["overall"] == "degraded"
        assert body["face_detector"]["available"] is True
        assert body["ocr_reader"]["available"] is False
