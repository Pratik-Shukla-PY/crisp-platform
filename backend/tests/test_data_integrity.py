"""Data integrity tests — dedup, consistency, no data loss."""
import pytest
from tests.conftest import auth_header


class TestDeduplication:
    def test_same_client_id_returns_same_report(self, client):
        payload = {
            "device_hash": "DEDUP-1", "client_report_id": "dedup-fixed-id",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 10, "longitude": 20},
        }
        r1 = client.post("/api/v1/reports/meta", json=payload)
        r2 = client.post("/api/v1/reports/meta", json=payload)
        assert r1.json()["id"] == r2.json()["id"]

    def test_different_client_ids_create_different_reports(self, client):
        base = {
            "device_hash": "DEDUP-2", "source": "APP", "expected_media": 0,
            "location": {"latitude": 10, "longitude": 20},
        }
        r1 = client.post("/api/v1/reports/meta", json={**base, "client_report_id": "diff-001"})
        r2 = client.post("/api/v1/reports/meta", json={**base, "client_report_id": "diff-002"})
        assert r1.json()["id"] != r2.json()["id"]


class TestStatusTransitions:
    def test_pending_to_dispatch(self, client, analyst_token):
        r = client.post("/api/v1/reports/meta", json={
            "device_hash": "TRANS-1", "client_report_id": "trans-001",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 10, "longitude": 20},
        })
        rid = r.json()["id"]
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        assert res.status_code == 200
        assert res.json()["status"] == "RESPONDING"

    def test_dispatch_then_resolve(self, client, analyst_token):
        r = client.post("/api/v1/reports/meta", json={
            "device_hash": "TRANS-2", "client_report_id": "trans-002",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 10, "longitude": 20},
        })
        rid = r.json()["id"]
        client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        res = client.patch(f"/api/v1/reports/{rid}/resolve", headers=auth_header(analyst_token))
        assert res.json()["status"] == "RESOLVED"


class TestClassification:
    def test_classify_updates_fields(self, client, sample_report):
        rid = sample_report["id"]
        res = client.patch(f"/api/v1/reports/{rid}/classify", json={
            "severity": "CRITICAL", "infrastructure_type": "HOSPITAL",
            "crisis_type": "EARTHQUAKE", "damage_classification": "COMPLETE",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["severity"] == "CRITICAL"
        assert data["crisis_type"] == "EARTHQUAKE"
        assert data["damage_classification"] == "COMPLETE"
