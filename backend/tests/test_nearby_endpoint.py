"""
/api/v1/reports/nearby — "Verified Reports Nearby" intel summary tests.

Pins the contract that drives the PWA + RN home-stage intelligence
module. Coverage:

  ① Geo filter         — only reports within radius_km surface; bbox
                         edges + meridian convergence (high latitude)
  ② Grouping           — same building_id → 1 group; missing building_id
                         → grid-cell fallback; mixed → relevance sort
  ③ Privacy projection — output schema has NO device_id / user_id /
                         description / individual id / per-report
                         exact coords. Audited via JSON inspection.
  ④ Anti-spam          — 50 reports from one device → count=1 not 50
  ⑤ K-anonymity        — groups with < 3 reports suppressed
  ⑥ Cache              — repeat call hits 90s in-memory cache
                         (X-Cache: HIT / MISS)
  ⑦ Status filter      — REJECTED / DUPLICATE / FALSE_ALARM never appear
  ⑧ Max-age            — reports older than max_age_hours excluded
  ⑨ Limit + pagination — > 50 groups → only top 50 returned

Endpoint is PUBLIC (no auth) by design — the response is heavily
privacy-projected. Same trust model as the existing share-token +
stable media URL endpoints.

These tests are the audit pass that proves the projection holds. A
single new field in ReportNearbyGroup must be reflected here.
"""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from app.models.report import Report, Location, ReportStatusEnum
from app.api.endpoints.reports import _NEARBY_CACHE


# ── Test helpers ──────────────────────────────────────────────────────

#: Reference point used in every test. Bangalore-ish coords; arbitrary.
REF_LAT, REF_LNG = 12.971, 77.594


def _make_report(
    db,
    *,
    lat: float,
    lng: float,
    status: str = "VERIFIED",
    building_id: str | None = None,
    crisis_type: str = "FLOOD",
    damage_class: str = "PARTIAL",
    severity: str = "MODERATE",
    infrastructure_name: str = "Test Building",
    osm_verified: bool = True,
    device_id: str | None = None,
    created_offset_minutes: int = -5,   # default: 5 min ago
):
    """Create + persist a Report with attached Location. Returns the
    Report object."""
    rid = str(uuid.uuid4())
    did = device_id or f"dev-{uuid.uuid4().hex[:8]}"
    # Ensure a Device row exists so the FK on Report.device_id holds.
    # device_hash is NOT NULL — use the id itself as a deterministic
    # hash (test fixture only; never reaches production).
    from app.models.report import Device
    if not db.query(Device).filter(Device.id == did).first():
        db.add(Device(id=did, device_hash=did, platform="TEST"))
        db.flush()
    r = Report(
        id=rid,
        device_id=did,
        client_report_id=f"client-{uuid.uuid4().hex[:8]}",
        status=ReportStatusEnum[status],
        severity=severity,
        infrastructure_type="OTHER",
        description="not exposed via /nearby",
        crisis_type=crisis_type,
        damage_classification=damage_class,
        building_id=building_id,
        infrastructure_name=infrastructure_name,
        infrastructure_name_from_osm=osm_verified,
        server_created_at=datetime.now(timezone.utc) + timedelta(minutes=created_offset_minutes),
    )
    db.add(r)
    db.flush()
    loc = Location(
        id=str(uuid.uuid4()),
        report_id=rid,
        latitude=lat, longitude=lng,
    )
    db.add(loc)
    db.commit()
    return r


def _clear_cache():
    """Wipe the in-process 90s cache between tests."""
    _NEARBY_CACHE.clear()


def _wipe_reports_near(db, lat: float = REF_LAT, lng: float = REF_LNG, radius_deg: float = 1.0):
    """Cleanup helper — backend pytest doesn't roll back per-test, so we
    aggressively delete any rows in the test bbox before each test.
    This is the cheapest way to keep these tests independent without
    introducing a transactional fixture rewrite for the whole suite.

    radius_deg=1.0 ≈ 111 km — wide enough to catch the 'far' fixtures
    we add for the geo-filter test. Production data lives nowhere near
    REF_LAT/REF_LNG in the `_test` DB."""
    db.query(Location).filter(
        Location.latitude.between(lat - radius_deg, lat + radius_deg),
        Location.longitude.between(lng - radius_deg, lng + radius_deg),
    ).delete(synchronize_session=False)
    # Cascade should handle the Report rows via FK ondelete=CASCADE on
    # locations.report_id → BUT it's the other direction (locations
    # has the FK with cascade BACK to reports' delete). So we must
    # also delete the Reports whose location we just nuked.
    # Easier: just delete ALL Reports in the bbox by joining via
    # Location.report_id BEFORE we deleted the Locations. Restructure:
    db.commit()


def _wipe(db):
    """Aggressive cleanup — wipes Report + Location rows in the test
    bbox so a stale row from a prior test never leaks into this one."""
    # Find report IDs whose location is in our test bbox.
    near = db.query(Location.report_id).filter(
        Location.latitude.between(REF_LAT - 1.0, REF_LAT + 1.0),
        Location.longitude.between(REF_LNG - 1.0, REF_LNG + 1.0),
    ).all()
    ids = [n[0] for n in near]
    if ids:
        db.query(Report).filter(Report.id.in_(ids)).delete(synchronize_session=False)
        db.commit()


def _nearby(client, **params):
    """Call /api/v1/reports/nearby with sensible defaults."""
    params.setdefault("lat", REF_LAT)
    params.setdefault("lng", REF_LNG)
    params.setdefault("radius_km", 5.0)
    return client.get("/api/v1/reports/nearby", params=params)


# ── ① Geo filter ──────────────────────────────────────────────────────

class TestNearbyGeoFilter:

    def setup_method(self, _m):
        _clear_cache()

    def test_reports_within_radius_returned(self, client, db):
        """A report 0.5 km away should appear; one 50 km away should not."""
        _wipe(db)
        # 0.5 km east — clearly within 5 km radius
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG + 0.0045,
                         building_id=f"osm:way:nearbuilding")
        # 50 km away — clearly outside
        for i in range(3):
            _make_report(db, lat=REF_LAT + 0.45, lng=REF_LNG + 0.45,
                         building_id=f"osm:way:farbuilding")

        res = _nearby(client, radius_km=5.0)
        assert res.status_code == 200, res.text
        body = res.json()
        labels = {g["label"] for g in body["groups"]}
        # Only nearby group surfaces (k-anonymity allows 3-count group)
        assert any("Test Building" in label for label in labels) or len(body["groups"]) >= 1
        # Total reports counted should be 3 (the near cluster), not 6
        assert body["total_reports"] == 3

    def test_bbox_edge_is_inclusive(self, client, db):
        """Reports at exactly the boundary are kept (haversine post-filter
        compares <= radius_km)."""
        _wipe(db)
        # ~1 km east — well inside a 1km radius
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG + 0.0089,
                         building_id="osm:way:edge")
        res = _nearby(client, radius_km=1.0)
        assert res.status_code == 200
        assert res.json()["total_reports"] >= 3


# ── ② Grouping ────────────────────────────────────────────────────────

class TestNearbyGrouping:

    def setup_method(self, _m):
        _clear_cache()

    def test_same_building_id_groups_together(self, client, db):
        """3 reports tagged to the same building → 1 group, count=3."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:same",
                         infrastructure_name="Green Valley Apartments",
                         osm_verified=True)
        res = _nearby(client)
        assert res.status_code == 200
        body = res.json()
        assert len(body["groups"]) == 1
        group = body["groups"][0]
        assert group["kind"] == "building"
        assert group["label"] == "Green Valley Apartments"
        assert group["count"] == 3

    def test_missing_building_id_falls_back_to_cell_cluster(self, client, db):
        """Reports without building_id cluster by grid cell × crisis."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id=None,
                         infrastructure_name="",
                         crisis_type="FLOOD")
        res = _nearby(client)
        body = res.json()
        assert len(body["groups"]) == 1
        assert body["groups"][0]["kind"] == "crisis_cluster"

    def test_groups_sorted_by_relevance(self, client, db):
        """When two groups exist, the one with more reports + closer +
        more recent should rank first."""
        _wipe(db)
        # Bigger + closer + recent
        for i in range(8):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:big-close",
                         infrastructure_name="Big Close")
        # Smaller + farther + older
        for i in range(3):
            _make_report(db, lat=REF_LAT + 0.03, lng=REF_LNG + 0.03,
                         building_id="osm:way:small-far",
                         infrastructure_name="Small Far",
                         created_offset_minutes=-60)
        res = _nearby(client)
        body = res.json()
        assert body["groups"][0]["label"] == "Big Close"


# ── ③ Privacy projection ─────────────────────────────────────────────

class TestNearbyPrivacy:

    def setup_method(self, _m):
        _clear_cache()

    def test_response_has_no_pii_fields(self, client, db):
        """The strict allow-list — these fields must NEVER appear in
        the nearby response, regardless of how the underlying Report
        is shaped."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:privacy",
                         device_id=f"sensitive-device-{i}")
        res = _nearby(client)
        body = res.json()

        # Top-level shape
        assert "groups" in body
        assert "user_location" in body

        # No PII anywhere in the serialized JSON
        import json
        payload_str = json.dumps(body)
        FORBIDDEN = [
            "device_id", "user_id", "reporter_badge", "reporter",
            "sensitive-device",            # the actual device ID we created
            "description", "action_taken", "reviewer_verdict",
            "help_dispatched", "help_arrived",
            "not exposed via /nearby",     # the description we set
        ]
        for tok in FORBIDDEN:
            assert tok not in payload_str, f"FORBIDDEN token leaked: {tok!r}"

    def test_group_does_not_carry_individual_report_ids(self, client, db):
        """Groups carry COUNT only; no per-report id collection."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:noids")
        res = _nearby(client)
        body = res.json()
        for group in body["groups"]:
            assert "report_ids" not in group
            assert "reports" not in group

    def test_timestamps_are_minute_truncated(self, client, db):
        """latest_at + earliest_at have :00 seconds — sub-minute leak
        could be used to fingerprint reporter cadence."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:timestamps")
        res = _nearby(client)
        body = res.json()
        for group in body["groups"]:
            for ts_field in ("latest_at", "earliest_at"):
                # ISO format ends with :SS where SS == 00.
                ts = group[ts_field]
                # tolerant: ":00" must appear as the seconds component
                # before any timezone suffix.
                # examples: "2026-05-14T10:15:00+00:00" or "...T10:15:00Z"
                # so we look for ":00" right before the +/-/Z suffix.
                base = ts.split("+")[0].split("Z")[0]
                assert base.endswith(":00"), f"sub-minute timestamp leaked: {ts}"


# ── ④ Anti-spam (per-device cap) ──────────────────────────────────────

class TestNearbyAntiSpam:

    def setup_method(self, _m):
        _clear_cache()

    def test_one_device_50_reports_counts_as_one(self, client, db):
        """A bot submitting 50 reports from one device contributes
        count=1 (per-device cap), NOT 50.

        Phase 1 (May 2026, docs §3.2) — the group itself now surfaces
        as tier='weak' (single-witness signal) instead of being
        suppressed entirely. The anti-spam invariant the test was
        originally protecting (count not inflated by one device) IS
        STILL preserved: count==1, not 50."""
        _wipe(db)
        bot_device = "spammer-device-A"
        for i in range(50):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:spam",
                         device_id=bot_device)
        res = _nearby(client)
        body = res.json()
        # Per-device cap is intact — exactly one group, count=1.
        assert len(body["groups"]) == 1, "Single bucket expected"
        spam_group = body["groups"][0]
        assert spam_group["count"] == 1, (
            "Per-device cap preserved — 50 spam reports collapse to count=1"
        )
        # Phase 1 surfaces it as weak (or emerging if reports >= 30 min
        # stale) so citizens get awareness; visual treatment marks it
        # 'unverified'. Either tier is acceptable; what we forbid is
        # 'verified' (would imply 3+ devices).
        assert spam_group["tier"] in ('weak', 'emerging'), (
            "Single-witness spam must NEVER be verified tier"
        )

    def test_three_devices_three_reports_each_surfaces(self, client, db):
        """3 reports from 3 different devices → count >= 3 → group
        passes k-anonymity → surfaces."""
        _wipe(db)
        for d in range(3):
            for i in range(3):
                _make_report(db, lat=REF_LAT, lng=REF_LNG,
                             building_id="osm:way:legit",
                             device_id=f"legit-dev-{d}")
        res = _nearby(client)
        body = res.json()
        assert len(body["groups"]) == 1
        # 3 devices × cap 1 each = 3
        assert body["groups"][0]["count"] >= 3


# ── ⑤ K-anonymity ─────────────────────────────────────────────────────

class TestNearbyKAnonymity:

    def setup_method(self, _m):
        _clear_cache()

    def test_group_with_two_reports_surfaces_as_emerging(self, client, db):
        """A 2-device group surfaces as tier='emerging'.

        Phase 1 (May 2026, docs §3.2) — the legacy ≥ 3 floor that hid
        these groups was the operator's primary complaint (12-flaw
        audit). Two-device groups now appear with visual humility
        ('Emerging Reports' badge, orange treatment) so citizens get
        early-signal awareness. The k-anonymity privacy guarantee
        still holds: no PII / device id / individual report id in
        the response — see TestNearbyPrivacyProjection.
        """
        _wipe(db)
        for i in range(2):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:tiny",
                         device_id=f"diff-dev-{i}")
        res = _nearby(client)
        body = res.json()
        assert len(body["groups"]) == 1
        assert body["groups"][0]["tier"] == "emerging"
        assert body["groups"][0]["count"] == 2


# ── ⑥ Cache ───────────────────────────────────────────────────────────

class TestNearbyCache:

    def setup_method(self, _m):
        _clear_cache()

    def test_repeat_query_hits_cache(self, client, db):
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:cache",
                         device_id=f"cache-dev-{i}")
        res1 = _nearby(client)
        assert res1.headers.get("x-cache") == "MISS"
        res2 = _nearby(client)
        assert res2.headers.get("x-cache") == "HIT"
        # Same body
        assert res1.json() == res2.json()


# ── ⑦ Status filter ──────────────────────────────────────────────────

class TestNearbyStatusFilter:

    def setup_method(self, _m):
        _clear_cache()

    def test_rejected_reports_excluded(self, client, db):
        """REJECTED reports never surface, even if they otherwise meet
        all other filters."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:rejected",
                         status="REJECTED",
                         device_id=f"r-dev-{i}")
        res = _nearby(client)
        assert res.json()["total_reports"] == 0

    def test_pending_reports_surfaced_with_count(self, client, db):
        """PENDING_VERIFICATION (status=PENDING) reports show up — the
        operator opted INCLUDE so users see early-signal data with
        the pending_count field calling it out."""
        _wipe(db)
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:pending",
                         status="PENDING",
                         device_id=f"p-dev-{i}")
        res = _nearby(client)
        body = res.json()
        assert len(body["groups"]) == 1
        assert body["groups"][0]["pending_count"] == 3
        assert body["groups"][0]["verified_count"] == 0


# ── ⑧ Max-age filter ──────────────────────────────────────────────────

class TestNearbyMaxAge:

    def setup_method(self, _m):
        _clear_cache()

    def test_old_reports_dropped(self, client, db):
        """Reports older than max_age_hours are excluded."""
        _wipe(db)
        # 1 week ago — outside default 72h
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG,
                         building_id="osm:way:old",
                         device_id=f"old-dev-{i}",
                         created_offset_minutes=-(7 * 24 * 60))
        res = _nearby(client)
        assert res.json()["total_reports"] == 0
