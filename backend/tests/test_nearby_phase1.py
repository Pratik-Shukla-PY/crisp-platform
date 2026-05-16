"""
/api/v1/reports/nearby — Phase 1 (May 2026) regression tests.

Pins the new behaviours introduced by the confidence-tier + RESPONDING-
inclusion + RESOLVED-24h pass. See docs/NEARBY_REPORTS_PIPELINE.md
§3.2, §3.3, §3.5, §3.6, §10 + §14.

Coverage:
  ① RESPONDING reports surface (was excluded pre-Phase-1)
  ② RESOLVED-within-24h surfaces under recently_resolved_groups,
     NOT folded into the active count
  ③ RESOLVED older than 24h does NOT surface anywhere
  ④ Tier classification — single-witness within 30 min → 'weak'
  ⑤ Tier classification — single-witness ≥ 30 min stale → 'emerging'
  ⑥ Tier classification — 2 unique devices → 'emerging'
  ⑦ Tier classification — 3+ unique devices → 'verified'
  ⑧ Tier 'weak' privacy projection — crisis_types collapsed to coarse
     category (FLOOD/FIRE/INFRASTRUCTURE/OTHER); detailed enum suppressed
  ⑨ Tier 'emerging' + 'verified' expose full crisis_type enum
  ⑩ crisis_ttl_hours rule lookup — FLOOD_FLASH → 72h, EARTHQUAKE → 14d
  ⑪ is_burst flag — 3 reports within 1h
  ⑫ Response carries citizen_t1_visibility echo of deployment flag

These tests are the audit pass for the Phase 1 contract. Any change
to the new fields MUST update this file.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

# Reuse helpers from the existing nearby test file.
from tests.test_nearby_endpoint import (
    _make_report,
    _clear_cache,
    _wipe_reports_near,
    _nearby,
    REF_LAT,
    REF_LNG,
)


@pytest.fixture(autouse=True)
def _isolate(db: Session):
    """Wipe nearby reports + clear cache before AND after each test so
    state doesn't bleed between tests."""
    _wipe_reports_near(db)
    _clear_cache()
    yield
    _wipe_reports_near(db)
    _clear_cache()


# ── ① RESPONDING surfacing ──────────────────────────────────────────

class TestRespondingInclusion:
    def test_responding_reports_surface_in_count(self, client, db):
        """3 RESPONDING reports at one building should produce a verified
        group with responding_count=3."""
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="RESPONDING",
                building_id=bid, device_id=f"resp-dev-{i}",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        assert res.status_code == 200
        body = res.json()
        assert body["total_groups"] >= 1
        # Find the group
        bld = next((g for g in body["groups"] if bid in g["id"]), None)
        assert bld is not None, "RESPONDING-only building should surface"
        assert bld["responding_count"] == 3
        assert bld["count"] == 3
        assert bld["tier"] == "verified"


# ── ② + ③ RESOLVED-24h separate channel ─────────────────────────────

class TestResolvedRecentChannel:
    def test_resolved_within_24h_surfaces_in_separate_list(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="RESOLVED",
                building_id=bid, device_id=f"res-dev-{i}",
                # 3 hours ago — well inside retention
                created_offset_minutes=-180,
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        # Active groups should NOT include this resolved cluster.
        active_ids = {g["id"] for g in body["groups"]}
        resolved_ids = {g["id"] for g in body["recently_resolved_groups"]}
        assert any(bid in i for i in resolved_ids), \
            "RESOLVED-within-24h cluster should surface in recently_resolved_groups"
        assert not any(bid in i for i in active_ids), \
            "RESOLVED-within-24h cluster MUST NOT inflate active count"
        # The active total_groups should not include the resolved one.
        assert body["total_resolved_recent"] >= 1
        # `kind` must be 'resolved_recent' for these.
        for g in body["recently_resolved_groups"]:
            if bid in g["id"]:
                assert g["kind"] == "resolved_recent"
                assert g["resolved_count"] == 3

    def test_resolved_older_than_24h_drops_entirely(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="RESOLVED",
                building_id=bid, device_id=f"old-res-dev-{i}",
                # 36 hours ago — past retention (24h)
                created_offset_minutes=-36 * 60,
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5,
                      max_age_hours=720)
        body = res.json()
        all_ids = (
            {g["id"] for g in body["groups"]}
            | {g["id"] for g in body["recently_resolved_groups"]}
        )
        assert not any(bid in i for i in all_ids), \
            "RESOLVED past 24h retention must not surface anywhere"


# ── ④ – ⑦ Tier classification ───────────────────────────────────────

class TestTierClassification:
    def test_single_witness_recent_is_weak(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        _make_report(
            db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
            building_id=bid, device_id="dev-weak-1",
            created_offset_minutes=-5,   # 5 min old → < 30 min threshold
        )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        weak = next((g for g in body["groups"] if bid in g["id"]), None)
        assert weak is not None
        assert weak["tier"] == "weak"
        assert weak["count"] == 1

    def test_single_witness_stale_is_emerging(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        _make_report(
            db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
            building_id=bid, device_id="dev-stale-1",
            created_offset_minutes=-45,  # 45 min old → ≥ 30 min stale
        )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["tier"] == "emerging", \
            "1 device + ≥ 30 min stale should promote to emerging"

    def test_two_devices_is_emerging(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(2):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id=bid, device_id=f"dev-em-{i}",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["tier"] == "emerging"

    def test_three_devices_is_verified(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id=bid, device_id=f"dev-v-{i}",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["tier"] == "verified"


# ── ⑧ + ⑨ Coarse-category privacy projection ────────────────────────

class TestCoarseCategoryPrivacy:
    def test_weak_tier_collapses_crisis_types(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        _make_report(
            db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
            building_id=bid, device_id="dev-coarse-1",
            crisis_type="WILDFIRE",
            created_offset_minutes=-5,   # recent → weak
        )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["tier"] == "weak"
        # WILDFIRE should be collapsed to FIRE coarse category.
        assert g["coarse_crisis_category"] == "FIRE"
        # `crisis_types` MUST be the coarse-category list, NOT the full enum.
        assert g["crisis_types"] == ["FIRE"], (
            "Weak-tier crisis_types must collapse to coarse category for privacy"
        )

    def test_verified_tier_exposes_full_crisis_type(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                building_id=bid, device_id=f"dev-vfull-{i}",
                crisis_type="EARTHQUAKE",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["tier"] == "verified"
        # Verified tier surfaces the full enum.
        assert "EARTHQUAKE" in g["crisis_types"]
        # coarse category still set for clients that want it.
        assert g["coarse_crisis_category"] == "INFRASTRUCTURE"


# ── ⑩ Crisis-rule-driven TTL ────────────────────────────────────────

class TestCrisisTtl:
    def test_flood_flash_ttl_is_72h(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                building_id=bid, device_id=f"flash-{i}",
                crisis_type="FLOOD_FLASH",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["crisis_ttl_hours"] == 72, "FLOOD_FLASH T3 TTL is 72h"

    def test_earthquake_ttl_is_14d(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                building_id=bid, device_id=f"quake-{i}",
                crisis_type="EARTHQUAKE",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["crisis_ttl_hours"] == 14 * 24


# ── ⑪ Burst detection ──────────────────────────────────────────────

class TestBurstDetection:
    def test_three_reports_within_one_hour_flags_burst(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        # 3 reports, ALL within 30 min — comfortably inside the 1h window
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id=bid, device_id=f"burst-{i}",
                created_offset_minutes=-(i * 10),   # 0, 10, 20 min ago
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["is_burst"] is True

    def test_three_reports_spread_over_three_hours_is_not_burst(self, client, db):
        bid = f"test-building-{uuid.uuid4().hex[:8]}"
        # 3 reports spread over 3 hours — outside the 1h burst window
        for i, offset_min in enumerate([-180, -120, -5]):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id=bid, device_id=f"slow-{i}",
                created_offset_minutes=offset_min,
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if bid in g["id"]), None)
        assert g is not None
        assert g["is_burst"] is False


# ── ⑫ Citizen T1 visibility flag echo ───────────────────────────────

class TestVisibilityFlagEcho:
    def test_response_echoes_default_visibility_true(self, client, db):
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        # Default settings.CRISP_CITIZEN_T1_VISIBILITY is True.
        assert "citizen_t1_visibility" in body
        assert body["citizen_t1_visibility"] is True


# ── /api/v1/config public endpoint ─────────────────────────────────

class TestConfigEndpoint:
    def test_config_endpoint_exposes_nearby_t1_visibility(self, client):
        res = client.get("/api/v1/config/")
        assert res.status_code == 200
        body = res.json()
        assert "nearby" in body
        assert "citizen_t1_visibility" in body["nearby"]
        assert isinstance(body["nearby"]["citizen_t1_visibility"], bool)
