"""
Nearby Reports Pipeline — Phase 3 (May 2026) regression tests.

Phase 3 adds:
  ① Device trust schema (devices.spam_score / reports_count /
     spam_signals) + a fraud_detector service with 3 hot signals
     (GPS spoof, impossible movement, rate burst)
  ② Trust-weighted contribution wired into aggregate_nearby —
     suspicious-device reports (trust_weight==0) are dropped from
     the group BEFORE count/tier calculation
  ③ Phase 3 trust proxy in the endpoint: account-linked civilian
     reports bump trust_weight to 1.5 (used by §3.5 acute grading
     downstream)

See docs/NEARBY_REPORTS_PIPELINE.md §6.1, §6.2, §6.3, §4.4.

Smart-prefill flow (§4.4) is frontend-only (nearby.js writes
sessionStorage['crisp_prefill_v1']; v4-flow.js consumes it). Lives
in the PWA Playwright spec suite, not here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.report import Device, Report, Location, ReportStatusEnum
from app.services.fraud_detector import (
    SUSPICIOUS_SCORE_FLOOR,
    SIGNAL_WEIGHTS,
    device_trust_weight,
    evaluate_submission,
    increment_reports_count,
    _detect_gps_spoof,
    _detect_impossible_movement,
    _detect_rate_burst,
)
from app.services.nearby_aggregator import (
    NearbyReportInput, _summarize_bucket,
)

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
    db.query(Device).filter(Device.id.like("trust-%")).delete()
    db.commit()
    yield
    _wipe_reports_near(db)
    _clear_cache()
    db.query(Device).filter(Device.id.like("trust-%")).delete()
    db.commit()


# ── ① Trust schema + device_trust_weight() ──────────────────────────

class TestDeviceTrustWeight:
    def test_none_device_returns_1(self):
        assert device_trust_weight(None) == 1.0

    def test_fresh_device_returns_1(self, db):
        dev = Device(id="trust-fresh", device_hash="trust-fresh",
                     platform="TEST")
        db.add(dev); db.commit(); db.refresh(dev)
        assert device_trust_weight(dev) == 1.0

    def test_trusted_anonymous_returns_1_2(self, db):
        """≥ 5 reports + spam_score == 0 → 1.2 (trusted anonymous tier)."""
        dev = Device(id="trust-anon", device_hash="trust-anon",
                     platform="TEST", spam_score=0.0, reports_count=8)
        db.add(dev); db.commit(); db.refresh(dev)
        assert device_trust_weight(dev) == 1.2

    def test_suspicious_device_returns_0(self, db):
        """spam_score >= SUSPICIOUS_SCORE_FLOOR → 0.0 (drop)."""
        dev = Device(id="trust-bad", device_hash="trust-bad",
                     platform="TEST", spam_score=SUSPICIOUS_SCORE_FLOOR + 0.1,
                     reports_count=10)
        db.add(dev); db.commit(); db.refresh(dev)
        assert device_trust_weight(dev) == 0.0


# ── ② Hot abuse signals ─────────────────────────────────────────────

class TestRateBurstDetector:
    def test_under_threshold_returns_false(self, db):
        dev = Device(id="trust-rate-clean", device_hash="trust-rate-clean",
                     platform="TEST")
        db.add(dev); db.commit()
        ts = datetime.now(timezone.utc)
        # 2 reports — under threshold
        for i in range(2):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="b1", device_id="trust-rate-clean",
                         created_offset_minutes=-(i * 5))
        assert _detect_rate_burst(db, device_id="trust-rate-clean", ts=ts) is False

    def test_threshold_fires(self, db):
        dev = Device(id="trust-rate-bad", device_hash="trust-rate-bad",
                     platform="TEST")
        db.add(dev); db.commit()
        # 5 reports inside 60s — capture `ts` AFTER creation so the
        # detector's `server_created_at <= ts` filter doesn't exclude
        # reports whose timestamp landed microseconds after `ts`.
        for i in range(5):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="b1", device_id="trust-rate-bad",
                         created_offset_minutes=0)
        ts = datetime.now(timezone.utc) + timedelta(seconds=1)
        assert _detect_rate_burst(db, device_id="trust-rate-bad", ts=ts) is True


class TestImpossibleMovementDetector:
    def test_no_prior_returns_false(self, db):
        dev = Device(id="trust-jump-1", device_hash="trust-jump-1",
                     platform="TEST")
        db.add(dev); db.commit()
        ts = datetime.now(timezone.utc)
        assert _detect_impossible_movement(
            db, device_id="trust-jump-1",
            lat=REF_LAT, lng=REF_LNG, ts=ts) is False

    def test_far_jump_within_window_fires(self, db):
        dev = Device(id="trust-jump-2", device_hash="trust-jump-2",
                     platform="TEST")
        db.add(dev); db.commit()
        # First report at REF location, 15s ago
        _make_report(
            db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
            building_id="b1", device_id="trust-jump-2",
            created_offset_minutes=0,
        )
        ts = datetime.now(timezone.utc)
        # Now claim a NEW submission ~50 km away — impossible in 15s
        assert _detect_impossible_movement(
            db, device_id="trust-jump-2",
            lat=REF_LAT + 0.5, lng=REF_LNG,    # ~55 km north
            ts=ts) is True


class TestGpsSpoofDetector:
    def test_alone_returns_false(self, db):
        dev = Device(id="trust-spoof-1", device_hash="trust-spoof-1",
                     platform="TEST")
        db.add(dev); db.commit()
        ts = datetime.now(timezone.utc)
        assert _detect_gps_spoof(
            db, lat=REF_LAT, lng=REF_LNG, ts=ts,
            own_device_id="trust-spoof-1") is False

    def test_three_devices_at_same_point_fires(self, db):
        """3 distinct devices reporting at the same coords within 60s
        → gps_spoof. (We add 2 pre-existing reports; the function's
        threshold is 'distinct devices including the caller' which
        is GPS_SPOOF_DISTINCT_DEVICES - 1 for pre-existing.)"""
        for i in range(2):
            dev_id = f"trust-spoof-other-{i}"
            db.add(Device(id=dev_id, device_hash=dev_id, platform="TEST"))
            db.commit()
            _make_report(
                db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                building_id="b1", device_id=dev_id,
                created_offset_minutes=0,
            )
        ts = datetime.now(timezone.utc)
        # New caller at the exact same coords within 60s
        assert _detect_gps_spoof(
            db, lat=REF_LAT, lng=REF_LNG, ts=ts,
            own_device_id="trust-spoof-new") is True


# ── ③ evaluate_submission bumps spam_score + spam_signals ───────────

class TestEvaluateSubmission:
    def test_rate_burst_bumps_score_and_signals(self, db):
        dev = Device(id="trust-eval-1", device_hash="trust-eval-1",
                     platform="TEST")
        db.add(dev); db.commit()
        # Seed 5 reports so the burst detector fires
        for _ in range(5):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="b1", device_id="trust-eval-1",
                         created_offset_minutes=0)
        fired = evaluate_submission(
            db, device_id="trust-eval-1",
            lat=REF_LAT, lng=REF_LNG,
            ts=datetime.now(timezone.utc),
        )
        assert "rate_burst" in fired
        db.refresh(dev)
        assert dev.spam_score >= SIGNAL_WEIGHTS["rate_burst"]
        assert "rate_burst" in (dev.spam_signals or [])

    def test_clean_submission_leaves_device_alone(self, db):
        dev = Device(id="trust-eval-clean", device_hash="trust-eval-clean",
                     platform="TEST")
        db.add(dev); db.commit()
        fired = evaluate_submission(
            db, device_id="trust-eval-clean",
            lat=REF_LAT, lng=REF_LNG,
        )
        assert fired == []
        db.refresh(dev)
        assert dev.spam_score == 0.0
        assert dev.spam_signals == []


# ── ④ increment_reports_count ───────────────────────────────────────

class TestReportsCountIncrement:
    def test_increments_on_call(self, db):
        dev = Device(id="trust-count-1", device_hash="trust-count-1",
                     platform="TEST")
        db.add(dev); db.commit()
        for i in range(3):
            increment_reports_count(db, "trust-count-1")
        db.refresh(dev)
        assert dev.reports_count == 3

    def test_no_op_on_null_device_id(self, db):
        # Just ensure it doesn't raise.
        increment_reports_count(db, None)


# ── ⑤ Trust weighting in the aggregator ────────────────────────────

class TestAggregatorTrustWeighting:
    def _input(self, *, device_id: str, trust: float = 1.0,
               user_id: str | None = None,
               lat: float | None = None, lng: float | None = None):
        return NearbyReportInput(
            report_id=str(uuid.uuid4()),
            device_id=device_id,
            status="PENDING", severity="MODERATE",
            crisis_type="FLOOD", damage_class="PARTIAL",
            building_id="b-trust", infrastructure_name="",
            infrastructure_name_from_osm=True,
            latitude=lat or REF_LAT, longitude=lng or REF_LNG,
            server_created_at=datetime.now(timezone.utc),
            user_id=user_id,
            trust_weight=trust,
        )

    def test_suspicious_reports_dropped_from_bucket(self, db):
        """Reports with trust_weight==0 don't count toward the group."""
        bucket = [
            self._input(device_id="d1", trust=1.0),
            self._input(device_id="d2", trust=0.0),   # SUSPICIOUS
            self._input(device_id="d3", trust=1.0),
        ]
        g = _summarize_bucket(bucket, kind="building",
                              user_lat=REF_LAT, user_lng=REF_LNG,
                              group_id="g_test")
        # d2 dropped → count = 2 unique non-suspicious devices.
        assert g.count == 2

    def test_all_suspicious_returns_zero_group(self, db):
        """If every report is suspicious, returns a count=0 stub that
        the caller's k-anonymity floor will reject."""
        bucket = [
            self._input(device_id="d1", trust=0.0),
            self._input(device_id="d2", trust=0.0),
        ]
        g = _summarize_bucket(bucket, kind="building",
                              user_lat=REF_LAT, user_lng=REF_LNG,
                              group_id="g_test")
        assert g.count == 0


# ── ⑥ End-to-end: suspicious device's reports don't surface ────────

class TestEndToEndSuspicious:
    def test_suspicious_device_reports_excluded_from_response(self, client, db):
        """3 reports from a clean device + 50 from a suspicious device
        at the same building. Endpoint should NOT include the spam
        contributions in the count or tier classification."""
        # Suspicious device
        bad = Device(id="trust-spam", device_hash="trust-spam",
                     platform="TEST", spam_score=2.0, reports_count=100)
        db.add(bad); db.commit()
        # 3 reports from 3 clean devices
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                         building_id="osm:way:trust-end",
                         device_id=f"clean-end-{i}",
                         created_offset_minutes=0)
        # 5 reports from the suspicious device
        for i in range(5):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="VERIFIED",
                         building_id="osm:way:trust-end",
                         device_id="trust-spam",
                         created_offset_minutes=0)
        res = _nearby(client, lat=REF_LAT, lng=REF_LNG, radius_km=5)
        body = res.json()
        g = next((g for g in body["groups"] if "trust-end" in g["id"]), None)
        assert g is not None
        # Count should be 3 (clean devices only). The spam device's
        # 5 reports collapse to 0 contribution because their
        # trust_weight is 0.0 (spam_score above SUSPICIOUS_SCORE_FLOOR).
        assert g["count"] == 3, (
            f"Suspicious device should be excluded; got count={g['count']}"
        )
        assert g["tier"] == "verified"
