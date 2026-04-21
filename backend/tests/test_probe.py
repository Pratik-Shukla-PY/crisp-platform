"""Upload-bandwidth probe endpoint tests (Apr 2026).

The PWA / RN client calls `POST /api/v1/reports/upload-probe` before
every media upload to measure actual upload throughput — fixes the
class of bugs where `navigator.connection.effectiveType` reports "4g"
while DevTools has throttled the link to 2 Kbps.

These tests pin the endpoint's contract so a future refactor can't
silently break the client's tier-selection logic.
"""
import io
import time

import pytest


def _probe_body(size_bytes: int) -> dict:
    return {
        "data": (
            "probe.bin",
            io.BytesIO(b"\x00" * size_bytes),
            "application/octet-stream",
        )
    }


class TestUploadProbe:
    def test_echoes_payload_size(self, client):
        res = client.post(
            "/api/v1/reports/upload-probe",
            files=_probe_body(8192),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["received_bytes"] == 8192
        assert "server_time_ms" in body
        assert body["server_time_ms"] > 0

    def test_small_payload_accepted(self, client):
        """A 1 KB probe (smallest chunk size in VERY_SLOW tier) must work."""
        res = client.post(
            "/api/v1/reports/upload-probe",
            files=_probe_body(1024),
        )
        assert res.status_code == 200
        assert res.json()["received_bytes"] == 1024

    def test_oversize_payload_rejected(self, client):
        """64 KB+ probes are rejected as potential abuse."""
        res = client.post(
            "/api/v1/reports/upload-probe",
            files=_probe_body(65_537),
        )
        assert res.status_code == 422
        assert "too large" in res.text.lower()

    def test_empty_payload_accepted(self, client):
        """An empty probe is silly but valid — lets clients measure pure
        latency without throughput bias from payload transfer time."""
        res = client.post(
            "/api/v1/reports/upload-probe",
            files={"data": ("probe.bin", io.BytesIO(b""), "application/octet-stream")},
        )
        assert res.status_code == 200
        assert res.json()["received_bytes"] == 0

    def test_rate_limit_60_per_min(self, client):
        """Send 61 probes from the test client (one IP) — 61st returns 429.

        The rate-limiter uses a separate `probe:` key prefix so it
        doesn't compete with the chunk rate-limit bucket.
        """
        from app.main import _rate_limits
        # Clear any residual buckets from other tests.
        _rate_limits.clear()
        for i in range(60):
            res = client.post(
                "/api/v1/reports/upload-probe",
                files=_probe_body(64),
            )
            assert res.status_code == 200, f"probe {i} unexpectedly failed: {res.text}"
        res = client.post(
            "/api/v1/reports/upload-probe",
            files=_probe_body(64),
        )
        assert res.status_code == 429
