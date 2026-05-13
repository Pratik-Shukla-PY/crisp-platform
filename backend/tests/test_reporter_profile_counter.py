"""
Reporter-profile counter regression tests — Apr 2026 PR 2.

Guards two closely-related bugs:

1. `ReporterProfile.report_count` was incremented on submit but NEVER
   decremented on any delete path. Users who deleted reports kept
   seeing the pre-delete count on the home screen ("7 REPORTS
   SUBMITTED" after deleting all 7).
2. `GET /reports/profile/{device_hash}` returned the stored counter
   verbatim. If the purge job hadn't run yet, the UI showed a stale
   high-water mark.

Fix (verified here):
- `_purge_expired_deletions` decrements `report_count` + `verified_count`
  on each row it hard-deletes (NOT on soft-delete — user might undo
  within the grace window, and the counter shouldn't drop prematurely).
- `GET /profile/{device_hash}` returns `min(stored_counter, live_count)`
  as defense-in-depth.
"""
import pytest
from datetime import datetime, timedelta, timezone

from app.api.endpoints.reports import _purge_expired_deletions
from app.models.report import Report, Device, ReporterProfile, ReportStatusEnum


@pytest.fixture
def device_hash():
    return f"TEST-COUNTER-{datetime.utcnow().strftime('%H%M%S%f')}"


def _seed_report(client, device_hash, client_report_id):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": client_report_id,
        "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
        "description": "counter test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201
    return res.json()["id"]


class TestReporterProfileCounter:
    """The counter must stay consistent with the actual report rows
    through the full lifecycle: submit, soft-delete (grace window),
    hard-purge."""

    def test_submit_increments_counter(self, client, db, device_hash):
        _seed_report(client, device_hash, "counter-1")
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        assert profile is not None, "profile not auto-created"
        assert profile.report_count == 1

    def test_soft_delete_keeps_counter(self, client, db, admin_token, device_hash):
        """Per the 24-hour grace window, the counter should NOT drop on
        soft-delete — the user might undo. It only drops when the row
        physically disappears."""
        report_id = _seed_report(client, device_hash, "counter-soft")
        res = client.delete(
            f"/api/v1/reports/{report_id}",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200, res.text
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        # Counter unchanged — this is the grace-window behaviour.
        assert profile.report_count == 1

    def test_purge_decrements_counter(self, client, db, admin_token, device_hash):
        """After `_purge_expired_deletions` runs, the counter decrements
        by the number of rows actually removed."""
        r1 = _seed_report(client, device_hash, "counter-p1")
        r2 = _seed_report(client, device_hash, "counter-p2")
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        assert profile.report_count == 2

        # Soft-delete both, then force the grace window to expire by
        # rewinding deletion_requested_at.
        for rid in (r1, r2):
            res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(admin_token))
            assert res.status_code == 200
        # Rewind both rows so the purge picks them up. `expire_all()`
        # forces the test session to re-read from DB — on Postgres the
        # API's soft-delete commits live in a separate transaction and
        # aren't visible from the test session's existing snapshot
        # without an explicit refresh. SQLite's file-based transactions
        # don't have this isolation, which is why this wasn't needed
        # before the full-Postgres switch (Apr 2026).
        db.expire_all()
        for r in db.query(Report).filter(Report.id.in_([r1, r2])).all():
            r.deletion_requested_at = datetime.now(timezone.utc) - timedelta(hours=25)
        db.commit()

        purged = _purge_expired_deletions(db)
        assert purged == 2

        db.refresh(profile)
        # Both reports removed → counter drops to 0.
        assert profile.report_count == 0

    def test_profile_endpoint_clamps_to_live_count(self, client, db, device_hash):
        """Defense-in-depth: even if `report_count` somehow goes
        stale/high (e.g. purge job never ran), the endpoint returns
        `min(stored, live)` so the UI never sees a count that exceeds
        the actual visible rows."""
        _seed_report(client, device_hash, "counter-clamp")
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        # Simulate drift: bump the stored counter by hand.
        profile.report_count = 99
        db.commit()

        res = client.get(f"/api/v1/reports/profile/{device_hash}")
        assert res.status_code == 200
        body = res.json()
        # Live count is 1 (the seeded row), so the clamp kicks in.
        assert body["report_count"] == 1

    def test_purge_decrements_verified_count(self, client, db, admin_token, device_hash):
        """Verified-status reports (VERIFIED / RESPONDING / RESOLVED)
        also decrement `verified_count` on purge."""
        report_id = _seed_report(client, device_hash, "counter-verified")
        # Promote to RESPONDING manually so the purge path counts it as verified.
        r = db.query(Report).filter(Report.id == report_id).first()
        r.status = ReportStatusEnum.RESPONDING
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        profile.verified_count = 1
        db.commit()

        client.delete(f"/api/v1/reports/{report_id}", headers=auth_header(admin_token))
        db.refresh(r)
        r.deletion_requested_at = datetime.now(timezone.utc) - timedelta(hours=25)
        db.commit()

        _purge_expired_deletions(db)
        db.refresh(profile)
        assert profile.report_count == 0
        assert profile.verified_count == 0


# Make the conftest helper reachable at module scope for the auth_header calls.
from tests.conftest import auth_header  # noqa: E402


class TestUNDPQualityBasedCredibility:
    """UNDP Problem Statement (Engagement Incentives) explicitly requires
    the rewarding system NOT to reward repeated / over-reporting. The
    badge ladder is therefore keyed off VERIFIED reports — not raw
    ``report_count``. Volume alone never upgrades a badge.

    These tests pin down the new behaviour so an accidental revert to
    the volume-based ladder would fail CI.
    """

    def test_volume_never_upgrades_badge(self, client, db, device_hash):
        """Volume alone (un-verified submissions) must NEVER unlock the
        higher tiers — the old volume-keyed ladder rewarded raw count
        which UNDP explicitly warned against.

        May 2026 (4-tier redesign) — the FIRST submit promotes from T1
        to T2 (SIGNAL); all subsequent submits stay at T2 because
        promotion to T3 requires analyst dispatch. The invariant the
        test guards is: 'no number of submissions alone unlocks
        T3 CHANGEMAKER or T4 LIFEKEEPER'.
        """
        for i in range(4):
            _seed_report(client, device_hash, f"vol-{i}")
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        assert profile.report_count == 4
        assert profile.verified_count == 0
        # 4 submitted reports → T2_SIGNAL only. T3 CHANGEMAKER (dispatched)
        # and T4 LIFEKEEPER (lives saved) remain locked.
        assert profile.badge_level == "T2_SIGNAL", \
            "raw volume must not unlock a higher tier (UNDP incentive rule)"

    def test_dispatch_promotes_first_report_to_verified(self, client, db, admin_token, analyst_token, device_hash):
        """Dispatching an analyst against a PENDING report should bump
        the reporter's verified_count and may upgrade their badge."""
        report_id = _seed_report(client, device_hash, "dispatch-1")
        res = client.patch(
            f"/api/v1/reports/{report_id}/dispatch",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200, res.text
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        db.refresh(profile)
        assert profile.verified_count == 1, \
            f"dispatch should bump verified_count, got {profile.verified_count}"

    def test_3_verified_reports_upgrade_to_contributor(self, client, db, analyst_token, device_hash):
        """May 2026 (4-tier redesign) — under the new ladder, the FIRST
        dispatch already promotes the reporter to T3_CHANGEMAKER (no
        '≥3 verified' gate any more). The 3-verified case is no
        different from the 1-verified case at the tier level; the
        cumulative verified_count is still tracked separately for
        credibility scoring + dashboard fraud-detection.
        """
        ids = []
        for i in range(3):
            rid = _seed_report(client, device_hash, f"qual-{i}")
            ids.append(rid)
            client.patch(
                f"/api/v1/reports/{rid}/dispatch",
                headers=auth_header(analyst_token),
            )
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        db.refresh(profile)
        assert profile.verified_count == 3
        # New 4-tier name. Legacy alias would surface as CONTRIBUTOR
        # for any unupgraded pre-v145 PWA shell.
        assert profile.badge_level == "T3_CHANGEMAKER"

    def test_dispatch_twice_does_not_double_count(self, client, db, analyst_token, device_hash):
        """Idempotency — moving an already-dispatched report to RESOLVED
        should not bump verified_count again."""
        report_id = _seed_report(client, device_hash, "idem-1")
        client.patch(f"/api/v1/reports/{report_id}/dispatch",
                     headers=auth_header(analyst_token))
        client.patch(f"/api/v1/reports/{report_id}/resolve",
                     headers=auth_header(analyst_token))
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash).first()
        db.refresh(profile)
        assert profile.verified_count == 1, \
            f"verified_count double-counted on resolve, got {profile.verified_count}"
