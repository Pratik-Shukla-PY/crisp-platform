"""
Nearby Reports Pipeline — Phase 4 (May 2026) regression tests.

Phase 4 adds:
  ① Disaster-mode detection (group_count / report_count thresholds)
  ② aggregate_disaster_zones — area-level mega-zones (heat-map render)
  ③ X-Crisp-Density-Mode response header + `density_mode` field
  ④ /api/v1/config exposes density_buckets + disaster_mode_threshold
  ⑤ Push policy: high-confidence acute → push; low-conf → badge only
  ⑥ Appeal framework — POST /open, GET /list, GET /one, POST /decide;
     reinstate clears device trust state

See docs/NEARBY_REPORTS_PIPELINE.md §3.8, §6.4, §7.5, §8, §14.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.report import Appeal, AppealEvent, Device
from app.services.nearby_aggregator import (
    NearbyGroup, is_disaster_density,
)
from app.services.nearby_push_policy import evaluate_push_eligibility

from tests.test_nearby_endpoint import (
    _make_report, _clear_cache, _wipe_reports_near,
    _nearby, REF_LAT, REF_LNG,
)


@pytest.fixture(autouse=True)
def _isolate(db: Session):
    _wipe_reports_near(db)
    _clear_cache()
    db.query(AppealEvent).delete()
    db.query(Appeal).delete()
    db.query(Device).filter(Device.id.like("p4-%")).delete()
    db.commit()
    yield
    _wipe_reports_near(db)
    _clear_cache()
    db.query(AppealEvent).delete()
    db.query(Appeal).delete()
    db.query(Device).filter(Device.id.like("p4-%")).delete()
    db.commit()


# ── ① Disaster-density threshold ───────────────────────────────────

class TestDisasterDensity:
    def test_normal_density_not_disaster(self):
        assert not is_disaster_density(group_count=10, report_count=50)

    def test_too_many_groups_is_disaster(self):
        assert is_disaster_density(group_count=51, report_count=10)

    def test_too_many_reports_is_disaster(self):
        assert is_disaster_density(group_count=5, report_count=201)


# ── ② + ③ End-to-end disaster mode + response header ───────────────

class TestDisasterModeEndpoint:
    def test_normal_mode_default(self, client, db):
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id=f"p4-bld-{i}", device_id=f"p4-d-{i}")
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        assert body["density_mode"] == "normal"
        assert res.headers.get("X-Crisp-Density-Mode") == "normal"


# ── ④ /api/v1/config exposes new Phase 4 fields ────────────────────

class TestConfigEndpointPhase4:
    def test_config_exposes_density_buckets_and_disaster_threshold(self, client):
        res = client.get("/api/v1/config/")
        assert res.status_code == 200
        body = res.json()
        assert "density_buckets" in body["nearby"]
        assert body["nearby"]["density_buckets"]["pins"] >= 1
        assert body["nearby"]["density_buckets"]["clusters"] >= 1
        assert "disaster_mode_threshold" in body["nearby"]
        assert body["nearby"]["disaster_mode_threshold"]["groups"] >= 1
        assert body["nearby"]["disaster_mode_threshold"]["reports"] >= 1
        assert "push" in body
        assert body["push"]["frequency_cap_per_user_per_hour"] >= 1


# ── ⑤ Push policy ──────────────────────────────────────────────────

class TestPushPolicy:
    def _g(self, *, tier: str = "verified", is_acute: bool = False,
           acute_grade: str | None = None,
           kind: str = "building") -> NearbyGroup:
        return NearbyGroup(
            id="g_test", kind=kind, label="x", summary="x",
            summary_key="x", count=3, verified_count=0, pending_count=3,
            approx_distance_km=0.5, centroid_lat=REF_LAT, centroid_lng=REF_LNG,
            latest_at=datetime.now(timezone.utc),
            earliest_at=datetime.now(timezone.utc),
            crisis_types=["FLOOD"], damage_classes=["PARTIAL"],
            severity_max="MODERATE",
            tier=tier, is_burst=False, is_acute=is_acute,
            acute_grade=acute_grade, crisis_ttl_hours=72,
            coarse_crisis_category="FLOOD",
        )

    def test_high_confidence_acute_pushes_admins_and_citizens(self):
        dec = evaluate_push_eligibility(
            self._g(tier="verified", is_acute=True, acute_grade="high")
        )
        assert dec.should_push is True
        assert dec.target_audience == "admins_and_citizens"

    def test_low_confidence_acute_admins_only_no_push(self):
        dec = evaluate_push_eligibility(
            self._g(tier="verified", is_acute=True, acute_grade="low")
        )
        assert dec.should_push is False
        assert dec.target_audience == "admins_only"

    def test_new_verified_cluster_pushes_citizens(self):
        dec = evaluate_push_eligibility(
            self._g(tier="verified", is_acute=False)
        )
        assert dec.should_push is True
        assert dec.target_audience == "citizens_only"

    def test_weak_tier_no_push(self):
        dec = evaluate_push_eligibility(
            self._g(tier="weak", is_acute=False)
        )
        assert dec.should_push is False

    def test_resolved_recent_no_push(self):
        dec = evaluate_push_eligibility(
            self._g(tier="verified", is_acute=False, kind="resolved_recent")
        )
        assert dec.should_push is False


# ── ⑥ Appeal framework ─────────────────────────────────────────────

class TestAppealFramework:
    def _auth(self, client) -> dict:
        res = client.post("/api/v1/auth/login", json={
            "email": "e2e-admin@crisp-e2e-tests.org",
            "password": "E2eAdmin!2026",
        })
        if res.status_code != 200:
            pytest.skip("e2e-admin not seeded in this test DB")
        return {"Authorization": f"Bearer {res.json()['access_token']}"}

    def _seed_suspicious_device(self, db) -> str:
        dev = Device(
            id="p4-suspicious", device_hash="p4-suspicious",
            platform="TEST", spam_score=2.0, reports_count=20,
            spam_signals=["rate_burst", "gps_spoof"],
        )
        db.add(dev); db.commit()
        return dev.id

    def test_open_appeal_snapshots_device_state(self, client, db):
        device_id = self._seed_suspicious_device(db)
        headers = self._auth(client)
        res = client.post(
            "/api/v1/admin/appeals",
            headers=headers,
            json={"device_id": device_id,
                  "claim_text": "False positive — my reports are legit"},
        )
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["status"] == "open"
        assert body["device_id"] == device_id
        # Snapshot of the device's trust state at open-time.
        assert sorted(body["original_signals"]) == sorted(["rate_burst", "gps_spoof"])
        assert body["original_spam_score"] == 2.0

    def test_duplicate_open_appeal_rejected(self, client, db):
        device_id = self._seed_suspicious_device(db)
        headers = self._auth(client)
        client.post("/api/v1/admin/appeals", headers=headers,
                    json={"device_id": device_id})
        res2 = client.post("/api/v1/admin/appeals", headers=headers,
                           json={"device_id": device_id})
        assert res2.status_code == 409

    def test_decide_reinstated_clears_device_trust_state(self, client, db):
        device_id = self._seed_suspicious_device(db)
        headers = self._auth(client)
        opened = client.post(
            "/api/v1/admin/appeals", headers=headers,
            json={"device_id": device_id, "claim_text": "I'm legit"},
        )
        appeal_id = opened.json()["id"]
        # Decide → reinstated
        decision = client.post(
            f"/api/v1/admin/appeals/{appeal_id}/decide",
            headers=headers,
            json={"decision": "reinstated", "notes": "verified human"},
        )
        assert decision.status_code == 200
        # Device's trust state should be cleared
        db.expire_all()
        dev = db.query(Device).filter(Device.id == device_id).first()
        assert dev.spam_score == 0.0
        assert dev.spam_signals == []
        # Appeal moved to 'reinstated'
        assert decision.json()["status"] == "reinstated"

    def test_decide_upheld_keeps_device_state(self, client, db):
        device_id = self._seed_suspicious_device(db)
        headers = self._auth(client)
        opened = client.post("/api/v1/admin/appeals", headers=headers,
                             json={"device_id": device_id})
        appeal_id = opened.json()["id"]
        client.post(
            f"/api/v1/admin/appeals/{appeal_id}/decide",
            headers=headers,
            json={"decision": "upheld", "notes": "evidence supports"},
        )
        db.expire_all()
        dev = db.query(Device).filter(Device.id == device_id).first()
        # Trust state unchanged
        assert dev.spam_score == 2.0
        assert sorted(dev.spam_signals) == sorted(["rate_burst", "gps_spoof"])

    def test_listing_filters_by_status(self, client, db):
        # Seed two devices + open two appeals + decide one
        for i in range(2):
            db.add(Device(id=f"p4-list-{i}", device_hash=f"p4-list-{i}",
                          platform="TEST", spam_score=1.5))
        db.commit()
        headers = self._auth(client)
        for i in range(2):
            client.post("/api/v1/admin/appeals", headers=headers,
                        json={"device_id": f"p4-list-{i}"})
        # Decide the first
        listed = client.get("/api/v1/admin/appeals?status=open",
                            headers=headers).json()
        # Decide first to upheld
        client.post(f"/api/v1/admin/appeals/{listed[0]['id']}/decide",
                    headers=headers, json={"decision": "upheld"})
        # Now list 'open' — should be 1; 'upheld' — should be 1
        open_after = client.get("/api/v1/admin/appeals?status=open",
                                headers=headers).json()
        upheld_after = client.get("/api/v1/admin/appeals?status=upheld",
                                  headers=headers).json()
        # Filter to just our seeded devices to avoid cross-test pollution
        open_for_us = [a for a in open_after
                       if a["device_id"] and a["device_id"].startswith("p4-list-")]
        upheld_for_us = [a for a in upheld_after
                         if a["device_id"] and a["device_id"].startswith("p4-list-")]
        assert len(open_for_us) == 1
        assert len(upheld_for_us) == 1
