"""
Nearby Reports Pipeline — Phase 5.1 (May 2026) regression tests.

Phase 5.1 covers the deferred Phase-5 follow-ups:

  ① Real emulator fingerprinting — telemetry capture + scored detector
     (replaces the UA-substring scaffold).
  ② Real MinHash-based narrative_similar (covered in test_nearby_phase5.py
     since we extended that file with the new ML tests).

See docs/NEARBY_REPORTS_PIPELINE.md §6.2 + §17.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.report import Device
from app.services.fraud_batch import BatchSignal, _detect_emulator_farm


@pytest.fixture(autouse=True)
def _isolate(db: Session):
    db.query(Device).filter(Device.id.like("p51-%")).delete()
    db.query(Device).filter(Device.device_hash.like("p51-%")).delete()
    db.commit()
    yield
    db.query(Device).filter(Device.id.like("p51-%")).delete()
    db.query(Device).filter(Device.device_hash.like("p51-%")).delete()
    db.commit()


# ── ① Telemetry capture endpoint ──────────────────────────────────

class TestTelemetryEndpoint:
    def _client(self) -> TestClient:
        return TestClient(app)

    def test_post_creates_new_device(self, db):
        """First-contact post creates the Device row + stores the
        sanitised summary. Anonymous registration is OK per UNDP
        must-have #9."""
        c = self._client()
        res = c.post("/api/v1/devices/telemetry", json={
            "device_hash": "p51-new-device",
            "summary": {
                "accel_active": True,
                "battery_present": True,
                "battery_level": 73,
                "screen_dpr": 3.0,
                "screen_w": 390,
                "screen_h": 844,
                "webgl_renderer": "Apple GPU",
                "timezone": "Asia/Kolkata",
                "locale": "en-IN",
                "platform_ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3)",
            },
        })
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ok"] is True
        dev = db.query(Device).filter(
            Device.device_hash == "p51-new-device"
        ).first()
        assert dev is not None
        # Battery level coarsened to the 70 bucket.
        assert dev.telemetry_summary["battery_level"] == 70
        assert dev.telemetry_summary["webgl_renderer"] == "Apple GPU"
        # Server timestamp is always added.
        assert "server_received_at" in dev.telemetry_summary

    def test_post_upserts_existing_device(self, db):
        """Second post for the same device_hash overwrites the
        summary instead of creating a duplicate row."""
        c = self._client()
        c.post("/api/v1/devices/telemetry", json={
            "device_hash": "p51-existing", "summary": {"accel_active": True}
        })
        c.post("/api/v1/devices/telemetry", json={
            "device_hash": "p51-existing", "summary": {"accel_active": False}
        })
        rows = db.query(Device).filter(
            Device.device_hash == "p51-existing"
        ).all()
        assert len(rows) == 1
        assert rows[0].telemetry_summary["accel_active"] is False

    def test_post_drops_unknown_keys(self, db):
        """Anything outside the allow-list is silently dropped. Future
        client roll-outs can't accidentally start storing PII."""
        c = self._client()
        c.post("/api/v1/devices/telemetry", json={
            "device_hash": "p51-allowlist",
            "summary": {
                "accel_active": True,
                # The following keys are NOT on the allow-list and must
                # be dropped at storage time:
                "user_email": "spy@evil.example",
                "imei": "352099001761481",
                "lat": 12.97,
                "lng": 77.59,
            },
        })
        dev = db.query(Device).filter(
            Device.device_hash == "p51-allowlist"
        ).first()
        assert "user_email" not in dev.telemetry_summary
        assert "imei" not in dev.telemetry_summary
        assert "lat" not in dev.telemetry_summary
        assert "lng" not in dev.telemetry_summary
        assert dev.telemetry_summary["accel_active"] is True

    def test_post_truncates_over_long_strings(self, db):
        """webgl_renderer / platform_ua / timezone / locale are
        truncated. Real strings are short; over-long values usually
        mean someone tried to abuse the column for PII smuggling."""
        long_ua = "A" * 5000
        long_renderer = "B" * 200
        c = self._client()
        c.post("/api/v1/devices/telemetry", json={
            "device_hash": "p51-truncate",
            "summary": {
                "platform_ua": long_ua,
                "webgl_renderer": long_renderer,
                "timezone": "X" * 200,
                "locale": "Y" * 200,
            },
        })
        dev = db.query(Device).filter(
            Device.device_hash == "p51-truncate"
        ).first()
        assert len(dev.telemetry_summary["platform_ua"]) == 200
        assert len(dev.telemetry_summary["webgl_renderer"]) == 64
        assert len(dev.telemetry_summary["timezone"]) == 64
        assert len(dev.telemetry_summary["locale"]) == 16


# ── ② Upgraded emulator detector ──────────────────────────────────

class TestEmulatorDetector:
    def _mk_device(self, db, name: str, *, platform: str = "",
                   telemetry: dict | None = None) -> Device:
        dev = Device(
            id=f"p51-emu-{name}",
            device_hash=f"p51-emu-{name}",
            platform=platform,
            telemetry_summary=telemetry,
        )
        db.add(dev); db.commit()
        return dev

    def test_ua_substring_still_fires_no_telemetry(self, db):
        """Backward-compat: a device with the old UA substring pattern
        and NO telemetry must still be caught (score 1.0 from rule 1)."""
        dev = self._mk_device(db, "ua-only",
                              platform="Genymotion-Emulator-Pixel-7")
        assert BatchSignal.EMULATOR_FARM in _detect_emulator_farm(db, dev, [])

    def test_software_webgl_renderer_fires(self, db):
        """A clean-looking UA + a software WebGL renderer = emulator.
        SwiftShader is the BlueStacks default."""
        dev = self._mk_device(db, "webgl-sw",
                              platform="iOS 17.2 iPhone 14",
                              telemetry={
                                  "webgl_renderer": "Google Inc. (Google) "
                                                    "ANGLE / SwiftShader",
                                  "platform_ua": "iPhone; iOS 17_3",
                                  "accel_active": True,
                                  "battery_present": True,
                              })
        assert BatchSignal.EMULATOR_FARM in _detect_emulator_farm(db, dev, [])

    def test_multi_signal_compound_score_fires(self, db):
        """No single signal hits 1.0 but the compound score does:
        no-accel (0.6) + no-battery (0.4) = 1.0."""
        dev = self._mk_device(db, "compound",
                              platform="iOS",
                              telemetry={
                                  "platform_ua": "Mozilla iPhone iOS 17_3",
                                  "accel_active": False,
                                  "battery_present": False,
                                  "webgl_renderer": "Apple GPU",
                              })
        assert BatchSignal.EMULATOR_FARM in _detect_emulator_farm(db, dev, [])

    def test_emulator_screen_preset_alone_does_not_fire(self, db):
        """Single rule 0.4 score must NOT fire — too false-positive
        prone (real iPhone 8s exist). Need at least one other signal."""
        dev = self._mk_device(db, "screen-only",
                              platform="iOS",
                              telemetry={
                                  "platform_ua": "iPhone iOS 17_3",
                                  "accel_active": True,
                                  "battery_present": True,
                                  "screen_w": 375, "screen_h": 667,
                                  "screen_dpr": 2.0,
                                  "webgl_renderer": "Apple GPU",
                                  "timezone": "Asia/Kolkata",
                                  "locale": "en-IN",
                              })
        assert _detect_emulator_farm(db, dev, []) == []

    def test_real_device_telemetry_does_not_fire(self, db):
        """False-positive control: a fully-populated REAL-DEVICE
        summary (iPhone 14 in Bangalore) must NOT trip the detector.
        If this fires we'd be punishing real users."""
        dev = self._mk_device(db, "real-iphone",
                              platform="iOS 17.3 iPhone 14",
                              telemetry={
                                  "platform_ua": "Mozilla/5.0 (iPhone; "
                                                 "CPU iPhone OS 17_3)",
                                  "accel_active": True,
                                  "battery_present": True,
                                  "battery_level": 70,
                                  "screen_w": 390, "screen_h": 844,
                                  "screen_dpr": 3.0,
                                  "webgl_renderer": "Apple GPU",
                                  "timezone": "Asia/Kolkata",
                                  "locale": "en-IN",
                              })
        assert _detect_emulator_farm(db, dev, []) == []

    def test_utc_en_us_default_emulator_combo(self, db):
        """Default emulator config (UTC + en-US) plus one other signal
        (no-accel) should fire: 0.4 + 0.6 = 1.0."""
        dev = self._mk_device(db, "default-emu",
                              platform="Android",
                              telemetry={
                                  "platform_ua": "Mozilla Android Linux",
                                  "accel_active": False,
                                  "battery_present": True,
                                  "timezone": "UTC",
                                  "locale": "en-US",
                                  "webgl_renderer": "Mali-G78",
                              })
        assert BatchSignal.EMULATOR_FARM in _detect_emulator_farm(db, dev, [])

    def test_no_telemetry_no_ua_substring_no_fire(self, db):
        """The detector must NOT fire on a device with neither
        telemetry nor an emulator-pattern platform string. This is the
        "we have no signal" case — bias toward not flagging."""
        dev = self._mk_device(db, "no-data",
                              platform="iOS 17.2 iPhone 14")
        assert _detect_emulator_farm(db, dev, []) == []


# ── ③ ST_DWithin aggregator path-selection ─────────────────────────

class TestPostGisPathSelection:
    """Docs §9.3 — when locations.geom is populated, the /nearby query
    switches from bbox + Python-haversine to ST_DWithin on the geography
    column. These tests cover the detection logic + the no-PostGIS
    fallback. The actual ST_DWithin SQL is exercised by Phase 5.2
    integration tests on a PostGIS-enabled CI runner (gated)."""

    def test_geom_detector_false_without_postgis(self, db):
        """On a Postgres cluster without PostGIS the migration logs
        + skips creating the geom column. The detector must return
        False so the endpoint stays on the bbox + haversine path —
        Phase 5's graceful-degradation contract."""
        from app.api.endpoints.reports import (
            _has_populated_geom_column, _reset_geom_cache_for_tests,
        )
        _reset_geom_cache_for_tests()
        # On the Homebrew dev cluster PostGIS isn't installed → no geom
        # column exists. Detector caches False and returns False.
        assert _has_populated_geom_column(db) is False
        # Idempotency: a second call returns the same cached value
        # without re-querying.
        assert _has_populated_geom_column(db) is False
        _reset_geom_cache_for_tests()

    def test_geom_detector_caches_result(self, db):
        """The detector's result is cached process-wide; flipping
        the cache to True via the test hook must change the next
        return value without touching the schema."""
        from app.api.endpoints.reports import (
            _has_populated_geom_column, _reset_geom_cache_for_tests,
        )
        import app.api.endpoints.reports as _rmod
        _reset_geom_cache_for_tests()
        _rmod._POSTGIS_GEOM_AVAILABLE = True
        assert _has_populated_geom_column(db) is True
        _reset_geom_cache_for_tests()
        assert _has_populated_geom_column(db) is False


# ── ④ H3 helper + scaffold ─────────────────────────────────────────

class TestH3Helper:
    """Docs §9.4 — H3 helper sanity checks. The integration with
    /nearby (CRISP_NEARBY_H3_MODE flag flipped + verifying query path
    selection) is exercised by the path-selection test below."""

    def test_compute_cell_returns_h3_string(self):
        from app.services.h3_helper import compute_cell, is_available
        if not is_available():
            pytest.skip("h3 wheel not installed on this runner")
        cell = compute_cell(12.9716, 77.5946)
        assert isinstance(cell, str)
        # H3 v4 cell strings are 15 chars at res 9.
        assert len(cell) == 15
        # Same lat/lng → same cell (idempotent).
        assert compute_cell(12.9716, 77.5946) == cell

    def test_compute_cell_rejects_out_of_range(self):
        from app.services.h3_helper import compute_cell, is_available
        if not is_available():
            pytest.skip("h3 wheel not installed")
        assert compute_cell(91.0, 0.0) is None   # lat > 90
        assert compute_cell(0.0, 181.0) is None  # lng > 180
        assert compute_cell(float("nan"), 0.0) is None

    def test_cells_within_radius_covers_centre(self):
        from app.services.h3_helper import (
            compute_cell, cells_within_radius, is_available,
        )
        if not is_available():
            pytest.skip("h3 wheel not installed")
        centre = compute_cell(12.9716, 77.5946)
        cells = cells_within_radius(12.9716, 77.5946, radius_km=1.0)
        assert centre in cells
        # 1 km at res 9 → ring k=7-ish → at least 60 cells
        assert len(cells) >= 30

    def test_cells_within_radius_caps_k(self):
        """Very large radii must not blow the cell-set up unbounded."""
        from app.services.h3_helper import cells_within_radius, is_available
        if not is_available():
            pytest.skip("h3 wheel not installed")
        cells = cells_within_radius(12.9716, 77.5946, radius_km=1000.0)
        # _MAX_RING_K = 60 → at most ~3 * 60 * 61 + 1 = ~10980 cells
        assert len(cells) <= 12000


class TestH3PathSelection:
    """Verify the /nearby query branch logic. The actual SQL execution
    against an H3-populated DB is covered by the regression sweep
    (every Location insert in the test suite now writes h3_idx via
    the SQLAlchemy event listener), so any path-selection bug would
    surface as a Phase 1-5 regression. These tests pin the explicit
    branch contract."""

    def test_h3_mode_off_by_default(self, monkeypatch):
        from app.services.h3_helper import is_h3_mode_enabled
        monkeypatch.delenv("CRISP_NEARBY_H3_MODE", raising=False)
        assert is_h3_mode_enabled() is False

    def test_h3_mode_on_when_env_set(self, monkeypatch):
        from app.services.h3_helper import is_h3_mode_enabled, is_available
        if not is_available():
            pytest.skip("h3 wheel not installed")
        monkeypatch.setenv("CRISP_NEARBY_H3_MODE", "1")
        assert is_h3_mode_enabled() is True

    def test_h3_mode_false_without_wheel(self, monkeypatch):
        """Even if the env flag is set, is_h3_mode_enabled returns
        False when the wheel can't be imported — protects against
        misconfigured deploys."""
        import app.services.h3_helper as _h
        monkeypatch.setenv("CRISP_NEARBY_H3_MODE", "1")
        original = _h._H3_AVAILABLE
        try:
            _h._H3_AVAILABLE = False
            assert _h.is_h3_mode_enabled() is False
        finally:
            _h._H3_AVAILABLE = original

    def test_location_insert_populates_h3_idx(self, db):
        """The SQLAlchemy `before_insert` listener on Location auto-
        populates h3_idx. Pin this so a refactor doesn't accidentally
        drop the listener."""
        from app.services.h3_helper import is_available
        from app.models.report import Location, Report
        from tests.test_nearby_endpoint import _make_report, REF_LAT, REF_LNG
        if not is_available():
            pytest.skip("h3 wheel not installed")
        r = _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="p51-h3-loc", device_id="p51-h3-dev")
        db.commit()
        loc = db.query(Location).filter(Location.report_id == r.id).first()
        assert loc is not None
        assert loc.h3_idx is not None
        assert len(loc.h3_idx) == 15


# ── ⑤ Hot-region snapshots (materialised /nearby pre-cache) ───────

class TestHotRegionSnapshots:
    """Docs §9.5 — per-region pre-aggregated snapshots. Read-path is
    gated by CRISP_NEARBY_HOT_REGIONS; admin CRUD endpoints work
    regardless so operators can seed regions before flipping the
    flag."""

    def _cleanup(self, db):
        from app.models.report import NearbyHotRegion
        db.query(NearbyHotRegion).filter(
            NearbyHotRegion.name.like("p51-hr-%")
        ).delete()
        db.commit()

    def test_find_containing_region_returns_smallest(self, db):
        """When two regions both contain the caller, return the
        smaller one (most-specific match wins)."""
        from app.models.report import NearbyHotRegion
        from app.services.hot_regions import find_containing_region
        self._cleanup(db)
        outer = NearbyHotRegion(
            name="p51-hr-outer", centre_lat=12.97, centre_lng=77.59,
            radius_km=20.0, refresh_interval_min=15, is_enabled=True,
        )
        inner = NearbyHotRegion(
            name="p51-hr-inner", centre_lat=12.97, centre_lng=77.59,
            radius_km=2.0, refresh_interval_min=15, is_enabled=True,
        )
        db.add_all([outer, inner]); db.commit()
        # Caller inside both → smaller wins.
        match = find_containing_region(12.97, 77.59, db)
        assert match is not None and match.name == "p51-hr-inner"
        self._cleanup(db)

    def test_find_containing_region_respects_disabled(self, db):
        """A disabled region must never match even when geometry fits."""
        from app.models.report import NearbyHotRegion
        from app.services.hot_regions import find_containing_region
        self._cleanup(db)
        r = NearbyHotRegion(
            name="p51-hr-off", centre_lat=12.97, centre_lng=77.59,
            radius_km=5.0, refresh_interval_min=15, is_enabled=False,
        )
        db.add(r); db.commit()
        assert find_containing_region(12.97, 77.59, db) is None
        self._cleanup(db)

    def test_find_containing_region_returns_none_outside(self, db):
        """No matching region → None, never the closest-but-outside."""
        from app.models.report import NearbyHotRegion
        from app.services.hot_regions import find_containing_region
        self._cleanup(db)
        r = NearbyHotRegion(
            name="p51-hr-far", centre_lat=12.97, centre_lng=77.59,
            radius_km=1.0, refresh_interval_min=15, is_enabled=True,
        )
        db.add(r); db.commit()
        # 100 km away → no match
        assert find_containing_region(13.97, 78.59, db) is None
        self._cleanup(db)

    def test_is_snapshot_fresh_age_logic(self, db):
        """Refreshed-at < interval → fresh; refreshed-at > interval →
        stale; None → never fresh."""
        from datetime import datetime, timezone, timedelta
        from app.models.report import NearbyHotRegion
        from app.services.hot_regions import is_snapshot_fresh
        self._cleanup(db)
        # No snapshot ever stored
        r = NearbyHotRegion(
            name="p51-hr-fresh", centre_lat=12.97, centre_lng=77.59,
            radius_km=5.0, refresh_interval_min=15, is_enabled=True,
        )
        assert is_snapshot_fresh(r) is False
        # Fresh: just-stored snapshot
        r.snapshot_json = {"groups": []}
        r.refreshed_at = datetime.now(timezone.utc)
        assert is_snapshot_fresh(r) is True
        # Stale: refreshed long ago
        r.refreshed_at = datetime.now(timezone.utc) - timedelta(minutes=30)
        assert is_snapshot_fresh(r) is False
        self._cleanup(db)

    def test_lookup_fresh_snapshot_respects_env_flag(self, db, monkeypatch):
        """The read path is OFF by default — even a perfectly fresh
        snapshot must NOT be returned without CRISP_NEARBY_HOT_REGIONS=1."""
        from datetime import datetime, timezone
        from app.models.report import NearbyHotRegion
        from app.services.hot_regions import lookup_fresh_snapshot
        self._cleanup(db)
        r = NearbyHotRegion(
            name="p51-hr-flag", centre_lat=12.97, centre_lng=77.59,
            radius_km=5.0, refresh_interval_min=15, is_enabled=True,
            snapshot_json={"sentinel": "flag-off"},
            refreshed_at=datetime.now(timezone.utc),
        )
        db.add(r); db.commit()
        monkeypatch.delenv("CRISP_NEARBY_HOT_REGIONS", raising=False)
        assert lookup_fresh_snapshot(12.97, 77.59, db) is None
        monkeypatch.setenv("CRISP_NEARBY_HOT_REGIONS", "1")
        snap = lookup_fresh_snapshot(12.97, 77.59, db)
        assert snap is not None and snap.get("sentinel") == "flag-off"
        self._cleanup(db)

    def test_admin_crud_creates_lists_patches_deletes(self, db):
        """Smoke-test the full CRUD surface."""
        from fastapi.testclient import TestClient
        from app.main import app
        from app.models.report import NearbyHotRegion
        self._cleanup(db)
        c = TestClient(app)
        # Use the e2e-admin login pattern. Skip if not seeded.
        res = c.post("/api/v1/auth/login", json={
            "email": "e2e-admin@crisp-e2e-tests.org",
            "password": "E2eAdmin!2026",
        })
        if res.status_code != 200:
            pytest.skip("e2e-admin not seeded in this test DB")
        token = res.json()["access_token"]
        hdrs = {"Authorization": f"Bearer {token}"}

        # Create
        create = c.post("/api/v1/admin/nearby/hot-regions",
                        headers=hdrs, json={
            "name": "p51-hr-crud",
            "centre_lat": 12.97, "centre_lng": 77.59,
            "radius_km": 5.0, "refresh_interval_min": 15,
        })
        assert create.status_code == 201, create.text
        # List includes the new region
        listed = c.get("/api/v1/admin/nearby/hot-regions", headers=hdrs)
        names = [r["name"] for r in listed.json()]
        assert "p51-hr-crud" in names
        # Patch radius
        patched = c.patch("/api/v1/admin/nearby/hot-regions/p51-hr-crud",
                          headers=hdrs, json={"radius_km": 10.0})
        assert patched.status_code == 200
        assert patched.json()["radius_km"] == 10.0
        # Delete
        deleted = c.delete("/api/v1/admin/nearby/hot-regions/p51-hr-crud",
                           headers=hdrs)
        assert deleted.status_code == 204
        # Re-list — gone
        listed = c.get("/api/v1/admin/nearby/hot-regions", headers=hdrs)
        names = [r["name"] for r in listed.json()]
        assert "p51-hr-crud" not in names
        self._cleanup(db)
