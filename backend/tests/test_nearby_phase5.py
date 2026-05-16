"""
Nearby Reports Pipeline — Phase 5 (May 2026) regression tests.

Phase 5 adds:
  ① Async batch fraud worker (fraud_batch.py) with 3 scaffolded
     detectors: emulator_farm, narrative_similar, cross_device_ring.
  ② Outbound webhook emission on appeal decisions (best-effort, no-op
     when CRISP_APPEAL_WEBHOOK_URLS unset).
  ③ Geospatial scaling — PostGIS extension migration (graceful
     degradation when extension unavailable).

See docs/NEARBY_REPORTS_PIPELINE.md §6.2 + §6.4 + §9.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.report import Device, Report, Appeal, AppealEvent
from app.services.fraud_batch import (
    BatchSignal, DETECTORS,
    _detect_emulator_farm, _detect_narrative_similar,
    _detect_cross_device_ring,
    emit_webhook, run_batch_scan,
)

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
    db.query(Device).filter(Device.id.like("p5-%")).delete()
    db.commit()
    yield
    _wipe_reports_near(db)
    _clear_cache()
    db.query(AppealEvent).delete()
    db.query(Appeal).delete()
    db.query(Device).filter(Device.id.like("p5-%")).delete()
    db.commit()


# ── ① Async batch detectors ────────────────────────────────────────

class TestBatchDetectors:
    def test_emulator_farm_fires_on_known_platform(self, db):
        dev = Device(id="p5-emu-1", device_hash="p5-emu-1",
                     platform="Android-Emulator-Pixel-7")
        db.add(dev); db.commit()
        fired = _detect_emulator_farm(db, dev, [])
        assert BatchSignal.EMULATOR_FARM in fired

    def test_emulator_farm_clean_platform(self, db):
        dev = Device(id="p5-emu-2", device_hash="p5-emu-2",
                     platform="iOS 17.2 iPhone 14")
        db.add(dev); db.commit()
        assert _detect_emulator_farm(db, dev, []) == []

    def test_narrative_similar_fires_on_identical_descriptions(self, db):
        dev = Device(id="p5-narr-1", device_hash="p5-narr-1", platform="iOS")
        db.add(dev); db.commit()
        for i in range(3):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="b1", device_id="p5-narr-1",
                         created_offset_minutes=-(i * 2))
        # Backfill identical descriptions on those reports
        for r in db.query(Report).filter(Report.device_id == "p5-narr-1").all():
            r.description = "Building collapsed — water everywhere"
        db.commit()
        recent = db.query(Report).filter(Report.device_id == "p5-narr-1").all()
        fired = _detect_narrative_similar(db, dev, recent)
        assert BatchSignal.NARRATIVE_SIMILAR in fired

    def test_narrative_similar_no_op_under_threshold(self, db):
        dev = Device(id="p5-narr-2", device_hash="p5-narr-2", platform="iOS")
        db.add(dev); db.commit()
        # Only 2 reports — under threshold of 3 for narrative.
        for i in range(2):
            _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                         building_id="b1", device_id="p5-narr-2")
        for r in db.query(Report).filter(Report.device_id == "p5-narr-2").all():
            r.description = "Identical"
        db.commit()
        recent = db.query(Report).filter(Report.device_id == "p5-narr-2").all()
        assert _detect_narrative_similar(db, dev, recent) == []


# ── ② Batch worker end-to-end ──────────────────────────────────────

class TestBatchScan:
    def test_run_batch_scan_flags_emulator_device(self, db):
        # Seed an emulator-pattern device with a recent report so it
        # falls into the scanner's "recently active" set.
        dev = Device(id="p5-scan-emu", device_hash="p5-scan-emu",
                     platform="Genymotion-Emulator")
        db.add(dev); db.commit()
        _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                     building_id="b1", device_id="p5-scan-emu",
                     created_offset_minutes=-1)
        summary = run_batch_scan(db=db, lookback_minutes=30)
        flagged = {d["device_id"] for d in summary["devices_flagged"]}
        assert "p5-scan-emu" in flagged
        db.refresh(dev)
        assert BatchSignal.EMULATOR_FARM in (dev.spam_signals or [])
        assert dev.spam_score > 0.0

    def test_run_batch_scan_idempotent_signal_union(self, db):
        """Re-running the scan doesn't duplicate signals."""
        dev = Device(id="p5-scan-idemp", device_hash="p5-scan-idemp",
                     platform="BlueStacks-Emulator")
        db.add(dev); db.commit()
        _make_report(db, lat=REF_LAT, lng=REF_LNG, status="PENDING",
                     building_id="b1", device_id="p5-scan-idemp",
                     created_offset_minutes=-1)
        run_batch_scan(db=db, lookback_minutes=30)
        run_batch_scan(db=db, lookback_minutes=30)
        db.refresh(dev)
        # Signal appears EXACTLY once even after 2 scans.
        assert dev.spam_signals.count(BatchSignal.EMULATOR_FARM) == 1


# ── ③ Outbound webhook emission ────────────────────────────────────

class TestWebhookEmission:
    def test_emit_webhook_no_urls_is_noop(self, monkeypatch):
        monkeypatch.delenv("CRISP_APPEAL_WEBHOOK_URLS", raising=False)
        # Should not raise even though there are no URLs.
        emit_webhook({"type": "test"})

    def test_emit_webhook_posts_to_configured_urls(self, monkeypatch):
        captured = {}

        def fake_post(url, *args, **kwargs):
            captured["url"] = url
            captured["body"] = kwargs.get("content")

            class _Resp:
                status_code = 200
            return _Resp()

        monkeypatch.setenv(
            "CRISP_APPEAL_WEBHOOK_URLS",
            "https://example.invalid/hook",
        )
        with patch("app.services.fraud_batch.httpx.post", side_effect=fake_post):
            emit_webhook({"type": "appeal.decided", "appeal_id": "x"})
        assert captured.get("url") == "https://example.invalid/hook"
        decoded = json.loads(captured["body"].decode("utf-8"))
        assert decoded["type"] == "appeal.decided"
        assert decoded["appeal_id"] == "x"

    def test_emit_webhook_failure_does_not_raise(self, monkeypatch):
        monkeypatch.setenv(
            "CRISP_APPEAL_WEBHOOK_URLS",
            "https://example.invalid/hook",
        )
        with patch(
            "app.services.fraud_batch.httpx.post",
            side_effect=Exception("boom"),
        ):
            # Must NOT raise — webhook failures must never disrupt
            # the calling flow.
            emit_webhook({"type": "test"})


# ── ④ Appeal-decision triggers webhook + audit event ───────────────

class TestAppealWebhookIntegration:
    def _auth(self, client) -> dict:
        res = client.post("/api/v1/auth/login", json={
            "email": "e2e-admin@crisp-e2e-tests.org",
            "password": "E2eAdmin!2026",
        })
        if res.status_code != 200:
            pytest.skip("e2e-admin not seeded in this test DB")
        return {"Authorization": f"Bearer {res.json()['access_token']}"}

    def test_decision_emits_webhook_sent_audit_event(self, client, db, monkeypatch):
        # Force webhook URL so emit_webhook runs
        monkeypatch.setenv(
            "CRISP_APPEAL_WEBHOOK_URLS",
            "https://example.invalid/hook",
        )
        # Seed device + open appeal
        dev = Device(id="p5-wh-1", device_hash="p5-wh-1",
                     platform="iOS", spam_score=1.5,
                     spam_signals=["rate_burst"])
        db.add(dev); db.commit()
        headers = self._auth(client)
        opened = client.post("/api/v1/admin/appeals", headers=headers,
                             json={"device_id": "p5-wh-1"})
        appeal_id = opened.json()["id"]
        # Decide — webhook httpx.post is patched to no-op so we don't
        # actually try to hit the network
        with patch("app.services.fraud_batch.httpx.post",
                   return_value=type("R", (), {"status_code": 200})()):
            client.post(f"/api/v1/admin/appeals/{appeal_id}/decide",
                        headers=headers, json={"decision": "upheld"})
        # webhook_sent should be in the appeal's event timeline
        evts = (
            db.query(AppealEvent)
              .filter(AppealEvent.appeal_id == appeal_id)
              .all()
        )
        kinds = {e.event_kind for e in evts}
        assert "webhook_sent" in kinds
        assert "status_change" in kinds


# ── ⑤ PostGIS migration graceful degradation ──────────────────────

class TestPostGisMigrationDegradation:
    def test_locations_table_queryable_after_migration(self, db):
        """The 0023 migration must run cleanly even when PostGIS is
        not installed on the cluster — Homebrew Postgres on a dev
        laptop is the common case. The invariant we check: the
        locations table is still queryable. The geom column may or
        may not exist depending on whether the CI runner has
        PostGIS; both are acceptable.

        Phase 5.1 (separate followup) will add the aggregator-side
        check that switches to ST_DWithin only when geom is
        populated."""
        from sqlalchemy import inspect, text
        bind = db.get_bind()
        # The query itself is the assertion — if the migration broke
        # the schema this fails fast.
        n = db.execute(text("SELECT COUNT(*) FROM locations")).scalar()
        assert isinstance(n, int)
        # `geom` is allowed to be absent (PostGIS not installed) or
        # present (PostGIS available + migration ran fully); both
        # are acceptable for the degradation contract.
        cols = {c["name"] for c in inspect(bind).get_columns("locations")}
        assert "latitude" in cols and "longitude" in cols, (
            "PostGIS migration must NEVER drop the lat/lng fallback columns"
        )
