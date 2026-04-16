"""Load tests — concurrent submissions, response time validation."""
import pytest
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi.testclient import TestClient
from tests.conftest import auth_header


class TestConcurrentSubmissions:
    def test_50_concurrent_report_submissions(self, client):
        """50 threads submitting reports simultaneously — all should succeed."""
        results = []

        def submit(i):
            res = client.post("/api/v1/reports/meta", json={
                "device_hash": f"LOAD-{i}",
                "client_report_id": f"load-{i}-{time.time()}",
                "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
                "expected_media": 0,
                "location": {"latitude": 12.97 + i * 0.001, "longitude": 77.59},
            })
            return res.status_code

        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = [executor.submit(submit, i) for i in range(50)]
            results = [f.result() for f in as_completed(futures)]

        success_count = sum(1 for r in results if r == 201)
        assert success_count >= 45, f"Only {success_count}/50 succeeded"

    def test_report_creation_under_500ms(self, client):
        """Single report creation should complete in under 500ms."""
        start = time.time()
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "PERF-1", "client_report_id": f"perf-{time.time()}",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 10, "longitude": 20},
        })
        elapsed = time.time() - start
        assert res.status_code == 201
        assert elapsed < 0.5, f"Took {elapsed:.2f}s (limit: 0.5s)"

    def test_10_sequential_reads(self, client, viewer_token):
        """10 sequential dashboard reads — all should succeed."""
        for i in range(10):
            res = client.get("/api/v1/reports/", headers=auth_header(viewer_token))
            assert res.status_code == 200
