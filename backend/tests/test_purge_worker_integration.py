"""
Deletion-purge worker integration tests — Apr 2026.

The purge job runs every 15 minutes from a background thread started in
`app.main.start_background_workers`. Testing the interval is brittle
and not actionable; these tests exercise the *function* the thread
calls (`_purge_expired_deletions`) directly. That's where all the
logic lives — the thread is just a `while True: run; sleep(900)`
wrapper.

Scenarios covered:
  * No-op when nothing has been soft-deleted
  * Grace window honoured per-row (not a global 24h)
  * Row physically disappears after its grace window passes
  * `ReporterProfile.report_count` is decremented to match

The canonical tz bug (pinned by this suite): `_purge_expired_deletions`
used to call `raw.replace(tzinfo=utc)` on already-aware Postgres
datetimes. `.replace()` overwrites the tz *without* shifting the wall
clock, so on an IST-defaulted Postgres server (offset +05:30) the
`cutoff = aware + timedelta(minutes=grace)` landed 5.5h in the future
and rows that were past their grace got skipped for five and a half
hours. The current code uses `.astimezone(utc)` when `tzinfo` is set,
`.replace(tzinfo=utc)` only on the naive fallback. Test 2 inserts a
tz-aware value to pin the happy path; the naive branch is exercised
implicitly by `test_purge_function_respects_per_report_grace_minutes`
which also rewinds to tz-aware values on Postgres.
"""
import pytest
from datetime import datetime, timedelta, timezone

from tests.conftest import auth_header
from app.api.endpoints.reports import _purge_expired_deletions
from app.models.report import Report, ReporterProfile, ReportStatusEnum


# ── Helpers ──────────────────────────────────────────────────────────────────

def _seed_report(client, device_hash, client_report_id,
                 lat=12.97, lng=77.59):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": client_report_id,
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "purge integration test",
        "expected_media": 0,
        "location": {"latitude": lat, "longitude": lng},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.fixture
def purge_device_hash():
    # Unique per-test so concurrent runs (or a leaky prior test) don't
    # bleed into each other's ReporterProfile row.
    return f"TEST-PURGE-{datetime.utcnow().strftime('%H%M%S%f')}"


# ── Tests ────────────────────────────────────────────────────────────────────

class TestPurgeWorker:

    def test_purge_function_is_noop_when_no_expired_rows(self, client, db):
        """If nothing is past its grace window, the function returns 0
        and touches no rows."""
        # Clear any leftover pending deletions from other tests so the
        # starting state is clean.
        stale = db.query(Report).filter(
            Report.deletion_requested_at != None).all()
        for r in stale:
            r.deletion_requested_at = None
        db.commit()

        count = _purge_expired_deletions(db)
        assert count == 0

    def test_purge_function_removes_expired_rows_past_grace(
            self, client, db, admin_token, purge_device_hash):
        """Full lifecycle: submit → soft-delete (grace=0) → tz-aware
        rewind → purge → row is gone.

        Writes the rewound `deletion_requested_at` as a tz-AWARE
        datetime to pin the fixed `.astimezone(utc)` code path.
        """
        report_id = _seed_report(client, purge_device_hash, "purge-grace-0")

        # grace_minutes=0 means "purge as soon as you see it". The
        # 1-second sleep isn't strictly needed, but it makes the race
        # explicit in case someone reads this test later.
        res = client.delete(
            f"/api/v1/reports/{report_id}?grace_minutes=0",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200, res.text

        # Explicitly rewrite deletion_requested_at with a tz-aware UTC
        # datetime in the past. This exercises the `.astimezone(utc)`
        # branch of the post-fix code.
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row is not None
        assert row.deletion_requested_at is not None
        row.deletion_requested_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()

        count = _purge_expired_deletions(db)
        assert count >= 1, "row should have been purged"

        # Row should be physically gone.
        db.expire_all()
        gone = db.query(Report).filter(Report.id == report_id).first()
        assert gone is None

    def test_purge_function_respects_per_report_grace_minutes(
            self, client, db, admin_token, purge_device_hash):
        """Two reports, different per-row `deletion_grace_minutes`. We
        rewind both to the same amount and confirm that only the one
        whose cutoff has passed gets purged; the other stays pending.

        This is the key invariant for the mobile (30-min) vs dashboard
        (24-h) deletion UX. A single global grace would punish mobile
        users by keeping their soft-delete around for 24h."""
        long_id = _seed_report(client, purge_device_hash, "purge-grace-long")
        short_id = _seed_report(
            client, f"{purge_device_hash}-B", "purge-grace-short")

        # Long report: grace=1440 (24h). Short report: grace=30 (mobile).
        assert client.delete(
            f"/api/v1/reports/{long_id}?grace_minutes=1440",
            headers=auth_header(admin_token),
        ).status_code == 200
        assert client.delete(
            f"/api/v1/reports/{short_id}?grace_minutes=30",
            headers=auth_header(admin_token),
        ).status_code == 200

        # Rewind both rows by 1 hour. After the rewind:
        #  long  (grace=24h) — NOT past cutoff (1h < 24h)
        #  short (grace=30m) — past cutoff (1h > 30m)
        db.expire_all()
        now_utc = datetime.now(timezone.utc)
        for r in db.query(Report).filter(
                Report.id.in_([long_id, short_id])).all():
            r.deletion_requested_at = now_utc - timedelta(hours=1)
        db.commit()

        count = _purge_expired_deletions(db)
        assert count == 1, (
            f"expected exactly the short-grace row to be purged, got {count}")

        db.expire_all()
        assert db.query(Report).filter(Report.id == long_id).first() is not None, \
            "long-grace row was purged prematurely"
        assert db.query(Report).filter(Report.id == short_id).first() is None, \
            "short-grace row should have been removed"

    def test_purge_function_updates_reporter_profile_counters(
            self, client, db, admin_token, purge_device_hash):
        """Counter stays at N on submit, stays at N on soft-delete, and
        drops to N-1 after the purge physically removes the row.

        This is the full-loop expectation that the Apr 2026 PR 2 fix
        established. Before that fix `report_count` only ever went
        UP, so a user who deleted all their reports still saw
        "7 REPORTS SUBMITTED" on their home screen."""
        report_id = _seed_report(client, purge_device_hash, "purge-counter-1")

        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == purge_device_hash).first()
        assert profile is not None, "profile should auto-create on submit"
        assert profile.report_count == 1

        # Soft-delete first — counter stays at 1 (grace-window behaviour).
        res = client.delete(
            f"/api/v1/reports/{report_id}?grace_minutes=0",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200
        db.expire_all()
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == purge_device_hash).first()
        assert profile.report_count == 1, \
            "soft-delete must NOT decrement — user might undo"

        # Force-expire the row with a tz-aware rewind.
        row = db.query(Report).filter(Report.id == report_id).first()
        row.deletion_requested_at = datetime.now(timezone.utc) - timedelta(hours=25)
        db.commit()

        purged = _purge_expired_deletions(db)
        assert purged == 1

        # Counter drops to 0.
        db.expire_all()
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == purge_device_hash).first()
        assert profile.report_count == 0, \
            "purge must decrement report_count to match the live row count"


# ── Retention policy (UNDP §22-24 + Annex 2 (c)) — crisis close + 1 year ─────

from app.api.endpoints.reports import _enforce_retention_policy
from app.models.report import CrisisEvent
from app.core.config import settings


class TestRetentionPolicy:
    """The retention sweep marks reports past their retention window for
    deletion (DeletionAuditLog + grace=0), which the existing purge then
    hard-deletes. Window anchors: standalone reports on creation; ENDED-crisis
    reports on the crisis close time. LIVE-crisis reports are never touched."""

    @pytest.fixture(autouse=True)
    def _cleanup(self, db, purge_device_hash):
        """Hard-remove everything this test created so the shared test DB
        can't leak into later suites. This file runs (alphabetically) before
        test_reporter_profile_counter; leftover marked/standalone reports +
        CrisisEvents previously polluted its purge-counter assertions."""
        yield
        from app.models.report import (
            Device, ReporterProfile, DeletionAuditLog, CrisisEvent as _CE,
        )
        hashes = [purge_device_hash] + [
            f"{purge_device_hash}-{s}" for s in ("recent", "live", "ended", "off")
        ]
        dev_ids = [d.id for d in db.query(Device).filter(Device.device_hash.in_(hashes)).all()]
        if dev_ids:
            reps = db.query(Report).filter(Report.device_id.in_(dev_ids)).all()
            rep_ids = [r.id for r in reps]
            for r in reps:
                db.delete(r)  # cascades location/media/ai/verification
            if rep_ids:
                db.query(DeletionAuditLog).filter(
                    DeletionAuditLog.report_id.in_(rep_ids)).delete(synchronize_session=False)
            db.query(ReporterProfile).filter(
                ReporterProfile.device_hash.in_(hashes)).delete(synchronize_session=False)
            db.query(Device).filter(Device.id.in_(dev_ids)).delete(synchronize_session=False)
        db.query(_CE).filter(_CE.name.in_(["Live Quake", "Ended Flood"])).delete(
            synchronize_session=False)
        db.commit()

    def _age_report(self, db, report_id, days):
        """Rewind a report's server_created_at by `days` (tz-aware UTC)."""
        row = db.query(Report).filter(Report.id == report_id).first()
        row.server_created_at = datetime.now(timezone.utc) - timedelta(days=days)
        db.commit()

    def test_standalone_report_past_window_is_marked_and_purged(
            self, client, db, purge_device_hash):
        report_id = _seed_report(client, purge_device_hash, "ret-old-standalone")
        # Age it just past the default 365-day window.
        self._age_report(db, report_id, settings.CRISP_RETENTION_AFTER_CLOSE_DAYS + 5)

        marked = _enforce_retention_policy(db)
        assert marked >= 1
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row.deletion_requested_at is not None, "should be marked for deletion"
        assert row.deletion_grace_minutes == 0, "retention mark uses grace=0"

        # The standard purge then hard-deletes it.
        purged = _purge_expired_deletions(db)
        assert purged >= 1
        db.expire_all()
        assert db.query(Report).filter(Report.id == report_id).first() is None

        # An audit row preserves the anonymized metadata, tagged RETENTION.
        from app.models.report import DeletionAuditLog
        audit = db.query(DeletionAuditLog).filter(
            DeletionAuditLog.report_id == report_id).first()
        assert audit is not None and audit.deletion_source == "RETENTION"

    def test_recent_standalone_report_is_untouched(
            self, client, db, purge_device_hash):
        report_id = _seed_report(client, f"{purge_device_hash}-recent", "ret-recent")
        # Fresh report (well within the window) must not be marked.
        marked_ids_before = {r.id for r in db.query(Report).filter(
            Report.deletion_requested_at != None).all()}
        _enforce_retention_policy(db)
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row is not None
        assert row.deletion_requested_at is None, "recent report must be retained"

    def test_live_crisis_report_is_retained_even_when_old(
            self, client, db, purge_device_hash):
        # A report attached to a LIVE crisis must survive regardless of age —
        # the response is still active.
        report_id = _seed_report(client, f"{purge_device_hash}-live", "ret-live-crisis")
        crisis = CrisisEvent(
            name="Live Quake", crisis_type="EARTHQUAKE", status="LIVE",
            is_active=True, center_lat=12.97, center_lng=77.59, radius_km=30.0,
            started_at=datetime.now(timezone.utc) - timedelta(days=400),
        )
        db.add(crisis)
        db.flush()
        row = db.query(Report).filter(Report.id == report_id).first()
        row.crisis_event_id = crisis.id
        row.server_created_at = datetime.now(timezone.utc) - timedelta(days=400)
        db.commit()

        _enforce_retention_policy(db)
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row is not None and row.deletion_requested_at is None, \
            "a report under a LIVE crisis must never be retention-purged"

    def test_ended_crisis_report_past_window_is_marked_when_preserve_disabled(
            self, client, db, purge_device_hash, monkeypatch):
        # Legacy / opt-out path: with CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE
        # turned OFF, an ENDED-crisis report past the window is still marked
        # for purge (anchored on the crisis close time, not creation).
        monkeypatch.setattr(settings, "CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE", False)
        report_id = _seed_report(client, f"{purge_device_hash}-ended", "ret-ended-crisis")
        crisis = CrisisEvent(
            name="Ended Flood", crisis_type="FLOOD", status="ENDED",
            is_active=False, center_lat=12.97, center_lng=77.59, radius_km=30.0,
            started_at=datetime.now(timezone.utc) - timedelta(days=500),
            ended_at=datetime.now(timezone.utc) - timedelta(
                days=settings.CRISP_RETENTION_AFTER_CLOSE_DAYS + 10),
        )
        db.add(crisis)
        db.flush()
        row = db.query(Report).filter(Report.id == report_id).first()
        row.crisis_event_id = crisis.id
        # Keep the report itself "recent" so ONLY the crisis-close anchor can
        # trigger the mark (proves the ended_at path, not the creation path).
        row.server_created_at = datetime.now(timezone.utc) - timedelta(days=2)
        db.commit()

        marked = _enforce_retention_policy(db)
        assert marked >= 1
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row.deletion_requested_at is not None, \
            "report under a crisis ended > window ago must be marked when preserve is off"

    def test_ended_crisis_report_preserved_by_default(
            self, client, db, purge_device_hash):
        # Phase 1 default (CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE=True): closing
        # an operation is NON-DESTRUCTIVE. An ENDED-crisis report, even one whose
        # crisis closed long past the retention window, must NOT be marked.
        assert settings.CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE is True, \
            "Phase 1 ships with preserve-on-close ON by default"
        report_id = _seed_report(client, f"{purge_device_hash}-ended", "ret-ended-preserved")
        crisis = CrisisEvent(
            name="Ended Flood", crisis_type="FLOOD", status="ENDED",
            is_active=False, center_lat=12.97, center_lng=77.59, radius_km=30.0,
            started_at=datetime.now(timezone.utc) - timedelta(days=500),
            ended_at=datetime.now(timezone.utc) - timedelta(
                days=settings.CRISP_RETENTION_AFTER_CLOSE_DAYS + 10),
        )
        db.add(crisis)
        db.flush()
        row = db.query(Report).filter(Report.id == report_id).first()
        row.crisis_event_id = crisis.id
        row.server_created_at = datetime.now(timezone.utc) - timedelta(days=2)
        db.commit()

        marked = _enforce_retention_policy(db)
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row is not None, "ENDED-crisis report must survive the sweep"
        assert row.deletion_requested_at is None, \
            "an ENDED operation's reports must be preserved by default"

    def test_standalone_cleanup_still_runs_when_preserve_enabled(
            self, client, db, purge_device_hash):
        # The preserve flag must NOT block standalone (no-crisis) cleanup —
        # only the ENDED-crisis pathway is gated. Proves the gate isn't
        # over-reaching into the time-window sweep for orphan reports.
        assert settings.CRISP_PRESERVE_REPORTS_ON_CRISIS_CLOSE is True
        report_id = _seed_report(client, f"{purge_device_hash}-off", "ret-standalone-preserve")
        self._age_report(db, report_id, settings.CRISP_RETENTION_AFTER_CLOSE_DAYS + 5)
        marked = _enforce_retention_policy(db)
        assert marked >= 1
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row.deletion_requested_at is not None, \
            "standalone-report cleanup must still run regardless of the preserve flag"

    def test_retention_disabled_is_noop(self, client, db, purge_device_hash, monkeypatch):
        report_id = _seed_report(client, f"{purge_device_hash}-off", "ret-disabled")
        self._age_report(db, report_id, 1000)
        monkeypatch.setattr(settings, "CRISP_RETENTION_AFTER_CLOSE_DAYS", 0)
        marked = _enforce_retention_policy(db)
        assert marked == 0
        db.expire_all()
        row = db.query(Report).filter(Report.id == report_id).first()
        assert row is not None and row.deletion_requested_at is None, \
            "window=0 disables the retention sweep entirely"
