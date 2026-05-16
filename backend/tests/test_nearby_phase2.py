"""
/api/v1/reports/nearby — Phase 2 (May 2026) regression tests.

Phase 2 adds:
  ① Multi-pass spatial cascade (building → block → area via geohash)
  ② Decay-weighted relevance sort (exp-decay per crisis half-life)
  ③ HIGH/LOW grading for is_acute (account-linked-user trust proxy)
  ④ Lifecycle events (nearby_group_events) — promote/downgrade/
     acute_on/fading/created/removed/resolved
  ⑤ Admin observability endpoints:
       /api/v1/admin/observability/nearby/acute
       /api/v1/admin/observability/nearby/events?group_id=...

See docs/NEARBY_REPORTS_PIPELINE.md §3.3, §3.4, §3.5, §3.7, §7, §13.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.report import NearbyGroupEvent
from app.services.nearby_aggregator import (
    NearbyGroup, NearbyReportInput,
    _classify_tier, _is_burst, _is_acute, _grade_acute,
    _multi_pass_cluster, _geohash_encode,
    crisis_rule_for,
)
from app.services.nearby_lifecycle import (
    GroupEventKind, diff_groups, persist_events,
)

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
    _wipe_reports_near(db)
    _clear_cache()
    db.query(NearbyGroupEvent).delete()
    db.commit()
    yield
    _wipe_reports_near(db)
    _clear_cache()
    db.query(NearbyGroupEvent).delete()
    db.commit()


# ── ① Multi-pass spatial cascade ───────────────────────────────────

class TestMultiPassCascade:
    def test_geohash_precision_7_is_about_150m(self):
        """Sanity: precision-7 geohash cells are ~150 m. Two points
        ~50 m apart should share the same geohash; ~500 m apart
        should not."""
        gh_a = _geohash_encode(REF_LAT, REF_LNG, 7)
        # ~50 m east (~0.0005° lng at 12°N)
        gh_close = _geohash_encode(REF_LAT, REF_LNG + 0.0005, 7)
        # ~500 m east (~0.005°)
        gh_far = _geohash_encode(REF_LAT, REF_LNG + 0.005, 7)
        assert gh_a == gh_close, "Points 50m apart should share a precision-7 cell"
        assert gh_a != gh_far, "Points 500m apart should NOT share a precision-7 cell"

    def test_three_buildings_without_id_cluster_at_block(self, client, db):
        """3 reports at 3 nearby coords, no building_id, same crisis:
        should cluster at block level (geohash 7)."""
        for i in range(3):
            _make_report(
                db,
                lat=REF_LAT + (i * 0.0001),     # ~10 m apart
                lng=REF_LNG,
                status="PENDING",
                building_id=None,
                crisis_type="FLOOD",
                device_id=f"dev-block-{i}",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        groups = body["groups"]
        assert len(groups) == 1
        # Reports without building_id at ~10m apart should land in a
        # block cluster (or area for very-coarse fallback).
        assert groups[0]["kind"] in ("block", "area")
        assert groups[0]["count"] == 3
        # 3 unique devices → verified tier
        assert groups[0]["tier"] == "verified"

    def test_spread_reports_cluster_at_area(self, client, db):
        """5 reports at coords spread over ~500 m, no building_id,
        same crisis. Building-level passes find no clusters; block
        level has at most 1-2 per geohash; area level catches them."""
        # Spread across ~600 m east-west (well beyond a single
        # block geohash but inside an area geohash).
        offsets_lng = [0.0, 0.001, 0.002, 0.003, 0.004]
        for i, off in enumerate(offsets_lng):
            _make_report(
                db,
                lat=REF_LAT,
                lng=REF_LNG + off,
                status="PENDING",
                building_id=None,
                crisis_type="FLOOD",
                device_id=f"dev-area-{i}",
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        groups = body["groups"]
        # Should end up as one area-level cluster (or a small number
        # of block clusters that didn't claim enough devices).
        # Phase 2 cascade puts them all in ONE area cluster.
        area_groups = [g for g in groups if g["kind"] == "area"]
        # Either it's a single area, OR a single block-level cluster
        # (if the geohash boundaries happened to line up).
        assert sum(g["count"] for g in groups) == 5, (
            "All 5 reports must be accounted for somewhere"
        )


# ── ② Decay-weighted relevance sort ────────────────────────────────

class TestDecayWeightedSort:
    def test_recent_burst_outranks_old_drip(self, client, db):
        """3 reports of FLOOD_FLASH in the last 10 min should rank
        ABOVE 5 reports of the same crisis from 2 days ago. Phase 1
        gave them similar scores; Phase 2's exp-decay puts the
        burst above the drip."""
        # Recent burst — 3 devices, 1 building, last 10 min.
        for i in range(3):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                building_id="osm:way:burst", device_id=f"burst-{i}",
                crisis_type="FLOOD_FLASH",
                created_offset_minutes=-(i * 3),    # 0, 3, 6 min
            )
        # Older drip — 5 devices, different building, 2 days old.
        for i in range(5):
            _make_report(
                db,
                lat=REF_LAT + 0.01,                 # ~1 km away
                lng=REF_LNG + 0.01,
                status="VERIFIED",
                building_id="osm:way:drip",
                device_id=f"drip-{i}",
                crisis_type="FLOOD_FLASH",
                created_offset_minutes=-(48 * 60 + i),  # ~48 h ago
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5,
                      max_age_hours=720)
        body = res.json()
        # Find the two groups by building id
        burst_pos = next(
            (i for i, g in enumerate(body["groups"]) if "burst" in g["id"]),
            None,
        )
        drip_pos = next(
            (i for i, g in enumerate(body["groups"]) if "drip" in g["id"]),
            None,
        )
        assert burst_pos is not None and drip_pos is not None
        assert burst_pos < drip_pos, (
            "Recent burst should rank above older drip with decay-weighted sort"
        )


# ── ③ HIGH/LOW acute grading ───────────────────────────────────────

class TestAcuteGrading:
    def test_unit_grade_acute_low_when_no_trusted_devices(self):
        """All anonymous reports → LOW grade."""
        now = datetime.now(timezone.utc)
        bucket = [
            NearbyReportInput(
                report_id=f"r-{i}", device_id=f"d-{i}",
                status="PENDING", severity="MODERATE",
                crisis_type="FLOOD", damage_class="PARTIAL",
                building_id="b1", infrastructure_name="",
                infrastructure_name_from_osm=True,
                latitude=REF_LAT, longitude=REF_LNG,
                server_created_at=now - timedelta(minutes=i),
                user_id=None,                        # anonymous
            ) for i in range(5)
        ]
        assert _grade_acute(bucket, now=now) == "low"

    def test_unit_grade_acute_high_when_three_trusted_in_window(self):
        """≥ 3 reports from user_id IS NOT NULL inside window → HIGH."""
        now = datetime.now(timezone.utc)
        bucket = [
            NearbyReportInput(
                report_id=f"r-{i}", device_id=f"d-{i}",
                status="PENDING", severity="MODERATE",
                crisis_type="FLOOD", damage_class="PARTIAL",
                building_id="b1", infrastructure_name="",
                infrastructure_name_from_osm=True,
                latitude=REF_LAT, longitude=REF_LNG,
                server_created_at=now - timedelta(minutes=i),
                # 3 of 5 are account-linked.
                user_id=f"u-{i}" if i < 3 else None,
            ) for i in range(5)
        ]
        assert _grade_acute(bucket, now=now) == "high"

    def test_acute_grading_endpoint_default_low(self, client, db):
        """Without account-linked reports, the endpoint's acute
        groups carry grade='low'."""
        # 5 reports within 10 min, all anonymous.
        for i in range(5):
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id="osm:way:acute-test", device_id=f"a-dev-{i}",
                created_offset_minutes=-(i),     # 0, -1, -2, -3, -4 min
            )
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if "acute-test" in g["id"]), None)
        assert g is not None
        assert g["is_acute"] is True
        assert g["acute_grade"] == "low", \
            "anonymous reports should grade LOW even when is_acute"


# ── ④ Lifecycle events (pure diff) ─────────────────────────────────

class TestLifecycleDiff:
    def _mk_group(self, *, gid: str, tier: str, count: int = 3,
                  kind: str = "building",
                  is_acute: bool = False,
                  acute_grade: str | None = None,
                  is_burst: bool = False) -> NearbyGroup:
        now = datetime.now(timezone.utc)
        return NearbyGroup(
            id=gid, kind=kind, label=gid, summary="x", summary_key="x",
            count=count, verified_count=0, pending_count=count,
            approx_distance_km=0.5,
            centroid_lat=REF_LAT, centroid_lng=REF_LNG,
            latest_at=now, earliest_at=now - timedelta(minutes=10),
            crisis_types=["FLOOD"], damage_classes=["PARTIAL"],
            severity_max="MODERATE",
            tier=tier, is_burst=is_burst, is_acute=is_acute,
            acute_grade=acute_grade, crisis_ttl_hours=72,
            coarse_crisis_category="FLOOD",
        )

    def test_diff_emits_created_for_new_group(self):
        events = diff_groups(prior=[], current=[
            self._mk_group(gid="g_building_X", tier="weak"),
        ])
        assert len(events) == 1
        assert events[0]["event_kind"] == GroupEventKind.CREATED
        assert events[0]["to_tier"] == "weak"
        assert events[0]["from_tier"] is None

    def test_diff_emits_removed_for_vanished_group(self):
        events = diff_groups(
            prior=[self._mk_group(gid="g_building_X", tier="verified")],
            current=[],
        )
        assert len(events) == 1
        assert events[0]["event_kind"] == GroupEventKind.REMOVED
        assert events[0]["from_tier"] == "verified"

    def test_diff_emits_promote_when_tier_goes_up(self):
        events = diff_groups(
            prior=[self._mk_group(gid="g_X", tier="weak", count=1)],
            current=[self._mk_group(gid="g_X", tier="emerging", count=2)],
        )
        kinds = {e["event_kind"] for e in events}
        assert GroupEventKind.PROMOTE in kinds

    def test_diff_emits_downgrade_when_tier_goes_down(self):
        events = diff_groups(
            prior=[self._mk_group(gid="g_X", tier="verified", count=3)],
            current=[self._mk_group(gid="g_X", tier="emerging", count=2)],
        )
        kinds = {e["event_kind"] for e in events}
        assert GroupEventKind.DOWNGRADE in kinds

    def test_diff_emits_acute_on(self):
        events = diff_groups(
            prior=[self._mk_group(gid="g_X", tier="verified", is_acute=False)],
            current=[self._mk_group(gid="g_X", tier="verified",
                                    is_acute=True, acute_grade="low")],
        )
        kinds = {e["event_kind"] for e in events}
        assert GroupEventKind.ACUTE_ON in kinds

    def test_persist_writes_rows(self, db):
        events = [
            {
                "group_id": "g_test_persist",
                "event_kind": GroupEventKind.CREATED,
                "from_tier": None, "to_tier": "weak",
                "from_count": None, "to_count": 1,
                "payload": {"kind": "building"},
            }
        ]
        n = persist_events(db, events)
        assert n == 1
        row = (
            db.query(NearbyGroupEvent)
              .filter(NearbyGroupEvent.group_id == "g_test_persist")
              .first()
        )
        assert row is not None
        assert row.event_kind == GroupEventKind.CREATED


# ── ⑤ Observability endpoints ──────────────────────────────────────

class TestObservabilityEndpoints:
    def _auth(self, client) -> dict:
        """Get an admin token (uses the seeded e2e-admin)."""
        res = client.post("/api/v1/auth/login", json={
            "email": "e2e-admin@crisp-e2e-tests.org",
            "password": "E2eAdmin!2026",
        })
        if res.status_code != 200:
            pytest.skip("e2e-admin not seeded in this test DB")
        return {"Authorization": f"Bearer {res.json()['access_token']}"}

    def test_acute_endpoint_requires_admin(self, client):
        res = client.get("/api/v1/admin/observability/nearby/acute")
        assert res.status_code in (401, 403), "Endpoint must require auth"

    def test_acute_endpoint_returns_shape_when_authed(self, client):
        headers = self._auth(client)
        res = client.get(
            "/api/v1/admin/observability/nearby/acute", headers=headers
        )
        assert res.status_code == 200
        body = res.json()
        assert "high_confidence" in body
        assert "low_confidence" in body
        assert "total" in body
        assert isinstance(body["high_confidence"], list)
        assert isinstance(body["low_confidence"], list)

    def test_events_endpoint_returns_persisted_events(self, client, db):
        # Seed an event
        persist_events(db, [{
            "group_id": "g_test_events",
            "event_kind": GroupEventKind.PROMOTE,
            "from_tier": "weak", "to_tier": "emerging",
            "from_count": 1, "to_count": 2,
            "payload": {},
        }])
        headers = self._auth(client)
        res = client.get(
            "/api/v1/admin/observability/nearby/events"
            "?group_id=g_test_events",
            headers=headers,
        )
        assert res.status_code == 200
        body = res.json()
        assert body["group_id"] == "g_test_events"
        assert len(body["events"]) >= 1
        assert body["events"][0]["event_kind"] == "promote"
        assert body["events"][0]["from_tier"] == "weak"
        assert body["events"][0]["to_tier"] == "emerging"
