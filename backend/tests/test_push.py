"""Tests for the Web Push reporter-feedback endpoints + service.

We never make real outbound calls to APNs / FCM / Mozilla autopush.
The send path is monkeypatched to capture what *would* have gone out,
which exercises every layer of the application code (model, schemas,
endpoints, service-level subscription lookup, status-change hook)
without flakiness.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import os

import pytest

from app.models.report import (
    Device,
    PushSubscription,
    Report,
    ReportStatusEnum,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _sub_payload(endpoint: str = "https://fcm.googleapis.com/wp/test/abc",
                 device_hash: str = "DEV-PYTEST"):
    """Build a request body shaped like the real PushManager.subscribe()
    output so the endpoint sees the same structure a real browser sends.

    p256dh and auth values are random-ish bytes; the schema enforces
    minimum length but doesn't try to validate them as real ECDH keys
    (that's the provider's job at send time)."""
    return {
        "endpoint": endpoint,
        "keys": {
            "p256dh": _b64u(b"x" * 65),  # 65-byte uncompressed P-256 point
            "auth": _b64u(b"y" * 16),    # 16-byte auth secret
        },
        "device_hash": device_hash,
    }


# ── /vapid-public ────────────────────────────────────────────────────────────

class TestVapidPublic:
    def test_returns_empty_when_unconfigured(self, client, monkeypatch):
        # Clear all three so _vapid_configured() returns False.
        from app.services import push as push_service
        monkeypatch.setattr(push_service.settings, "VAPID_PUBLIC_KEY", "")
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "")
        monkeypatch.setattr(push_service.settings, "VAPID_CONTACT_EMAIL", "")

        res = client.get("/api/v1/push/vapid-public")
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is False
        assert body["key"] == ""

    def test_returns_key_when_configured(self, client, monkeypatch):
        from app.services import push as push_service
        monkeypatch.setattr(push_service.settings, "VAPID_PUBLIC_KEY", "FAKE_PUB_KEY")
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "FAKE_PRIV_KEY")
        monkeypatch.setattr(push_service.settings, "VAPID_CONTACT_EMAIL", "ops@test.example")

        res = client.get("/api/v1/push/vapid-public")
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is True
        assert body["key"] == "FAKE_PUB_KEY"


# ── /subscribe ──────────────────────────────────────────────────────────────

class TestSubscribe:
    def test_anonymous_subscribe_creates_row(self, client, db):
        body = _sub_payload(endpoint="https://fcm.googleapis.com/wp/test/anon-1",
                            device_hash="DEV-ANON-1")
        res = client.post("/api/v1/push/subscribe", json=body)
        assert res.status_code == 201, res.text
        body_out = res.json()
        assert body_out["device_hash"] == "DEV-ANON-1"
        assert body_out["user_id"] is None
        assert body_out["endpoint"] == body["endpoint"]

        row = db.query(PushSubscription).filter(
            PushSubscription.endpoint == body["endpoint"]
        ).first()
        assert row is not None
        assert row.device_hash == "DEV-ANON-1"
        assert row.user_id is None

    def test_repeat_subscribe_is_idempotent(self, client, db):
        body = _sub_payload(endpoint="https://fcm.googleapis.com/wp/test/idem",
                            device_hash="DEV-IDEM")
        r1 = client.post("/api/v1/push/subscribe", json=body)
        r2 = client.post("/api/v1/push/subscribe", json=body)
        assert r1.status_code == 201
        assert r2.status_code == 201

        # Only one row exists.
        rows = db.query(PushSubscription).filter(
            PushSubscription.endpoint == body["endpoint"]
        ).all()
        assert len(rows) == 1

    def test_authenticated_subscribe_attaches_user_id(self, client, db, analyst_user, analyst_token):
        body = _sub_payload(endpoint="https://fcm.googleapis.com/wp/test/auth-1",
                            device_hash="DEV-AUTH-1")
        res = client.post(
            "/api/v1/push/subscribe",
            json=body,
            headers={"Authorization": f"Bearer {analyst_token}"},
        )
        assert res.status_code == 201, res.text
        out = res.json()
        assert out["user_id"] == analyst_user.id
        assert out["device_hash"] == "DEV-AUTH-1"

    def test_rejects_no_identity(self, client):
        body = _sub_payload(endpoint="https://fcm.googleapis.com/wp/test/no-id",
                            device_hash="")
        # Send no auth + empty device_hash → server must 400.
        body["device_hash"] = None
        res = client.post("/api/v1/push/subscribe", json=body)
        assert res.status_code == 400
        assert "no_identity" in res.text

    def test_keys_too_short_is_422(self, client):
        body = {
            "endpoint": "https://fcm.googleapis.com/wp/test/short",
            "keys": {"p256dh": "ab", "auth": "cd"},  # below min_length=4
            "device_hash": "DEV-TOOSHORT",
        }
        res = client.post("/api/v1/push/subscribe", json=body)
        assert res.status_code == 422


# ── /unsubscribe ────────────────────────────────────────────────────────────

class TestUnsubscribe:
    def test_unsubscribe_removes_row(self, client, db):
        # First subscribe.
        body = _sub_payload(endpoint="https://fcm.googleapis.com/wp/test/unsub",
                            device_hash="DEV-UNSUB")
        client.post("/api/v1/push/subscribe", json=body)
        assert db.query(PushSubscription).filter(
            PushSubscription.endpoint == body["endpoint"]
        ).first() is not None

        # Then unsubscribe.
        res = client.post(
            "/api/v1/push/unsubscribe",
            json={"endpoint": body["endpoint"]},
        )
        assert res.status_code == 200
        assert res.json()["deleted"] is True
        assert db.query(PushSubscription).filter(
            PushSubscription.endpoint == body["endpoint"]
        ).first() is None

    def test_unsubscribe_missing_is_idempotent(self, client):
        res = client.post(
            "/api/v1/push/unsubscribe",
            json={"endpoint": "https://fcm.googleapis.com/wp/test/never-subbed"},
        )
        assert res.status_code == 200
        assert res.json()["deleted"] is False


# ── Service: payload + send ─────────────────────────────────────────────────

class TestPushService:
    def test_short_circuits_when_unconfigured(self, db, monkeypatch):
        """When VAPID is not set, push_report_status_change does nothing."""
        from app.services import push as push_service
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "")

        # Build a stub Report so we don't have to set up the whole graph.
        class _StubReport:
            id = "stub-report-id"
            status = ReportStatusEnum.RESPONDING
            user_id = None
            device = None

        n = push_service.push_report_status_change(_StubReport())
        assert n == 0

    def test_payload_shape_for_responding(self):
        """The payload must be small + carry enough for the SW to render."""
        from app.services.push import _build_payload

        class _StubReport:
            id = "abc-123"
            status = ReportStatusEnum.RESPONDING

        p = _build_payload(_StubReport())
        assert "title" in p and isinstance(p["title"], str)
        assert "body" in p and isinstance(p["body"], str)
        assert p["data"]["report_id"] == "abc-123"
        assert p["data"]["status"] == "RESPONDING"
        # Tiny — keep payloads under 1 KB so flaky-link delivery is reliable.
        import json
        assert len(json.dumps(p)) < 1024

    def test_send_dispatches_to_executor(self, db, monkeypatch):
        """When VAPID is configured, status changes enqueue one delivery
        per matching subscription."""
        from app.services import push as push_service

        # Pretend VAPID is set.
        monkeypatch.setattr(push_service.settings, "VAPID_PUBLIC_KEY", "FAKE_PUB")
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "FAKE_PRIV")
        monkeypatch.setattr(push_service.settings, "VAPID_CONTACT_EMAIL", "ops@test")

        # Capture every executor.submit call so we can assert what got queued.
        captured = []

        class _FakeExecutor:
            def submit(self, fn, *a, **kw):
                captured.append((fn, a, kw))

        monkeypatch.setattr(push_service, "_push_executor", _FakeExecutor())

        # Seed: one device-hash subscription.
        sub = PushSubscription(
            id="push-sub-1",
            device_hash="DEV-FANOUT",
            endpoint="https://fcm.googleapis.com/wp/test/fanout-1",
            p256dh_key="x" * 8,
            auth_key="y" * 8,
            failure_count=0,
        )
        db.add(sub)

        # Build a real Device + Report so the service can resolve identity.
        device = Device(
            id="dev-uuid-fanout",
            device_hash="DEV-FANOUT",
        )
        db.add(device)
        rep = Report(
            id="rep-uuid-fanout",
            device_id=device.id,
            status=ReportStatusEnum.RESPONDING,
        )
        db.add(rep)
        db.commit()
        # SQLAlchemy needs the relationship populated for `.device.device_hash`
        db.refresh(rep)

        n = push_service.push_report_status_change(rep)
        assert n == 1
        assert len(captured) == 1
        fn, args, _ = captured[0]
        assert fn is push_service._deliver_one
        # First arg is the subscription id; second is the payload dict.
        assert args[0] == "push-sub-1"
        assert isinstance(args[1], dict)
        assert args[1]["data"]["report_id"] == "rep-uuid-fanout"

    def test_send_410_deletes_subscription(self, db, monkeypatch):
        """A 410 from the provider means the subscription is gone forever
        — the service must drop the row so we don't keep retrying."""
        from app.services import push as push_service

        monkeypatch.setattr(push_service.settings, "VAPID_PUBLIC_KEY", "FAKE_PUB")
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "FAKE_PRIV")
        monkeypatch.setattr(push_service.settings, "VAPID_CONTACT_EMAIL", "ops@test")

        sub = PushSubscription(
            id="push-sub-410",
            device_hash="DEV-410",
            endpoint="https://fcm.googleapis.com/wp/test/410",
            p256dh_key="x" * 8,
            auth_key="y" * 8,
            failure_count=0,
        )
        db.add(sub)
        db.commit()

        # Force _send_one to return 410 ("Gone").
        monkeypatch.setattr(push_service, "_send_one", lambda *a, **kw: 410)

        push_service._deliver_one("push-sub-410", {"title": "x", "body": "y"})
        # Row must be deleted from a fresh DB read (the deliver fn opens its own session).
        assert db.query(PushSubscription).filter(PushSubscription.id == "push-sub-410").first() is None

    def test_send_5xx_increments_failure_count(self, db, monkeypatch):
        from app.services import push as push_service

        monkeypatch.setattr(push_service.settings, "VAPID_PUBLIC_KEY", "FAKE_PUB")
        monkeypatch.setattr(push_service.settings, "VAPID_PRIVATE_KEY", "FAKE_PRIV")
        monkeypatch.setattr(push_service.settings, "VAPID_CONTACT_EMAIL", "ops@test")

        sub = PushSubscription(
            id="push-sub-503",
            device_hash="DEV-503",
            endpoint="https://fcm.googleapis.com/wp/test/503",
            p256dh_key="x" * 8,
            auth_key="y" * 8,
            failure_count=0,
        )
        db.add(sub)
        db.commit()

        monkeypatch.setattr(push_service, "_send_one", lambda *a, **kw: 503)

        push_service._deliver_one("push-sub-503", {"title": "x", "body": "y"})
        # Row still exists; failure_count bumped.
        row = db.query(PushSubscription).filter(PushSubscription.id == "push-sub-503").first()
        assert row is not None
        assert row.failure_count == 1
        assert row.last_failure_at is not None


# ── Status-change endpoint integration ──────────────────────────────────────

class TestStatusChangeTriggersPush:
    def test_dispatch_calls_push(self, client, db, analyst_token, monkeypatch):
        """The /dispatch endpoint must call push_report_status_change after commit."""
        from app.api.endpoints import reports as reports_module

        # Capture call.
        called = {"n": 0, "report_id": None, "status": None}

        def _fake_push(report):
            called["n"] += 1
            called["report_id"] = report.id
            called["status"] = report.status.value if hasattr(report.status, "value") else report.status
            return 0

        monkeypatch.setattr(
            reports_module,
            "_push_status_change_safely",
            lambda r: _fake_push(r),
        )

        # Seed minimal Report.
        device = Device(
            id="dev-status-1",
            device_hash="DEV-STATUS-1",
        )
        db.add(device)
        rep = Report(
            id="rep-status-1",
            device_id=device.id,
            status=ReportStatusEnum.PENDING,
        )
        db.add(rep)
        db.commit()

        res = client.patch(
            f"/api/v1/reports/{rep.id}/dispatch",
            headers={"Authorization": f"Bearer {analyst_token}"},
        )
        assert res.status_code == 200, res.text
        assert called["n"] == 1
        assert called["report_id"] == "rep-status-1"
        assert called["status"] == "RESPONDING"

    def test_resolve_calls_push(self, client, db, analyst_token, monkeypatch):
        from app.api.endpoints import reports as reports_module

        called = {"n": 0}
        monkeypatch.setattr(
            reports_module,
            "_push_status_change_safely",
            lambda r: called.update(n=called["n"] + 1),
        )

        device = Device(
            id="dev-status-2",
            device_hash="DEV-STATUS-2",
        )
        db.add(device)
        rep = Report(
            id="rep-status-2",
            device_id=device.id,
            status=ReportStatusEnum.PENDING,
        )
        db.add(rep)
        db.commit()

        res = client.patch(
            f"/api/v1/reports/{rep.id}/resolve",
            headers={"Authorization": f"Bearer {analyst_token}"},
        )
        assert res.status_code == 200
        assert called["n"] == 1

    def test_real_push_failure_does_not_break(self, client, db, analyst_token, monkeypatch):
        """Now the real test: the production helper swallows push errors."""
        from app.services import push as push_service

        # Make push_report_status_change raise. The reports module's
        # _push_status_change_safely (production code) wraps this in
        # try/except, so the status change should still succeed.
        monkeypatch.setattr(
            push_service,
            "push_report_status_change",
            lambda r: (_ for _ in ()).throw(RuntimeError("provider down")),
        )

        device = Device(
            id="dev-status-4",
            device_hash="DEV-STATUS-4",
        )
        db.add(device)
        rep = Report(
            id="rep-status-4",
            device_id=device.id,
            status=ReportStatusEnum.PENDING,
        )
        db.add(rep)
        db.commit()

        res = client.patch(
            f"/api/v1/reports/{rep.id}/dispatch",
            headers={"Authorization": f"Bearer {analyst_token}"},
        )
        # Status change committed despite push provider exploding.
        assert res.status_code == 200, res.text
        db.refresh(rep)
        assert rep.status == ReportStatusEnum.RESPONDING
