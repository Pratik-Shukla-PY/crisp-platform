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
