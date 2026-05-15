"""Backend tests for the 4-tier reward ladder (May 2026 redesign).

The legacy 3-tier ladder (NEWCOMER / CONTRIBUTOR / TRUSTED) was
keyed purely off ``verified_count``. The new 4-tier ladder is
identity-forward + driven by THREE distinct impact signals:

  * T1 SCOUT        — default (no reports submitted)
  * T2 SIGNAL       — ≥1 report submitted (any status)
  * T3 CHANGEMAKER  — ≥1 report dispatched (RESPONDING/RESOLVED)
  * T4 LIFEKEEPER   — sum(lives_impacted) ≥ 1 across device's reports

These tests pin the transitions + the new ``/profile`` response
shape (tier object, lives_saved_total, responded_count, badge_legacy)
so the PWA's contract on the rendering side stays stable.

Companion specs on the PWA side:
  * e2e/tests/pwa/63-tier-rendering.spec.ts
  * e2e/tests/pwa/64-tier-promotion-celebration.spec.ts
"""
import pytest
from tests.conftest import auth_header


def _seed_report(client, device_hash, cid_suffix):
    """Helper — submit a minimal valid report and return its id."""
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": f"tier-{cid_suffix}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert r.status_code == 201, r.text
    return r.json()["id"]


class TestTierTransitions:
    """Each promotion is triggered by a specific event — never by
    raw volume alone (UNDP incentive rule)."""

    def test_t1_scout_default_for_fresh_profile(self, client):
        """A device that has never submitted reads as T1_SCOUT.

        The /profile endpoint auto-creates a ReporterProfile on first
        read; the freshly-created row must default to T1_SCOUT (the
        new name), with a legacy alias of NEWCOMER for old PWA shells.
        """
        res = client.get("/api/v1/reports/profile/FRESH-DEVICE-T1")
        assert res.status_code == 200
        body = res.json()
        assert body["badge_level"] == "T1_SCOUT"
        assert body["badge_legacy"] == "NEWCOMER"
        assert body["report_count"] == 0
        assert body["verified_count"] == 0
        assert body["responded_count"] == 0
        assert body["lives_saved_total"] == 0

    def test_t2_signal_on_first_submit(self, client, db):
        """Submitting the first report promotes T1 → T2 SIGNAL.

        This is the easiest "first win" in the ladder — every
        reporter who taps Submit sees the chip flip on next home
        load. No analyst action required.
        """
        _seed_report(client, "DEVICE-T2-PROMOTE", "first-submit")
        res = client.get("/api/v1/reports/profile/DEVICE-T2-PROMOTE")
        body = res.json()
        assert body["badge_level"] == "T2_SIGNAL"
        assert body["badge_legacy"] == "NEWCOMER", \
            "T2 SIGNAL maps to legacy NEWCOMER for old PWA shells"
        assert body["report_count"] == 1
        assert body["responded_count"] == 0  # not yet dispatched

    def test_t3_changemaker_on_first_dispatch(self, client, db, analyst_token):
        """Dispatching help on a PENDING report promotes T2 → T3
        CHANGEMAKER. The first dispatch is enough; no volume gate.
        """
        rid = _seed_report(client, "DEVICE-T3-PROMOTE", "for-dispatch")
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        res = client.get("/api/v1/reports/profile/DEVICE-T3-PROMOTE")
        body = res.json()
        assert body["badge_level"] == "T3_CHANGEMAKER"
        assert body["badge_legacy"] == "CONTRIBUTOR", \
            "T3 maps to legacy CONTRIBUTOR for old PWA shells"
        assert body["responded_count"] == 1
        assert body["lives_saved_total"] == 0  # not yet impacted

    def test_t4_lifekeeper_on_first_life_saved(self, client, db, analyst_token):
        """Setting lives_impacted ≥ 1 on any of the user's reports
        promotes to T4 LIFEKEEPER. This is the only tier that
        requires an analyst to actively quantify impact (via
        PATCH /reports/{id}/impact).
        """
        rid = _seed_report(client, "DEVICE-T4-PROMOTE", "for-lives")
        # Dispatch first so the report is in a credible state.
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        # Analyst quantifies impact.
        res = client.patch(
            f"/api/v1/reports/{rid}/impact",
            headers=auth_header(analyst_token),
            json={"lives_impacted": 3},
        )
        assert res.status_code == 200, res.text
        profile_res = client.get("/api/v1/reports/profile/DEVICE-T4-PROMOTE")
        body = profile_res.json()
        assert body["badge_level"] == "T4_LIFEKEEPER"
        assert body["badge_legacy"] == "TRUSTED", \
            "T4 maps to legacy TRUSTED for old PWA shells"
        assert body["lives_saved_total"] == 3
        assert body["responded_count"] == 1

    def test_volume_never_skips_to_t3_or_t4(self, client, db):
        """Critical invariant — 10 submissions WITHOUT any dispatch
        must stay at T2_SIGNAL. Raw count alone unlocks NOTHING beyond
        T2. Codifies the UNDP incentive rule.
        """
        for i in range(10):
            _seed_report(client, "DEVICE-VOLUME", f"vol-{i}")
        res = client.get("/api/v1/reports/profile/DEVICE-VOLUME")
        body = res.json()
        assert body["badge_level"] == "T2_SIGNAL", \
            "10 unverified submissions must NEVER unlock T3+"
        assert body["responded_count"] == 0
        assert body["lives_saved_total"] == 0


class TestProfileResponseShape:
    """Pins the /profile response contract so the PWA renderer
    (home-screen.js) doesn't drift from the backend."""

    def test_tier_object_present_with_progress(self, client):
        """The /profile response must carry a `tier` object with
        current / next / progress fields. The PWA reads this
        directly to paint the progress sub-line on the badge chip.
        """
        res = client.get("/api/v1/reports/profile/SHAPE-CHECK")
        body = res.json()
        assert "tier" in body
        tier = body["tier"]
        assert tier["current"] == "T1_SCOUT"
        assert tier["next"] == "T2_SIGNAL"
        progress = tier["progress"]
        assert progress["needs"] == "submitted"
        assert progress["needed"] == 1
        assert progress["have"] == 0
        assert progress["label_key"] == "tier_progress_first_report"

    def test_top_tier_progress_block(self, client, db, analyst_token):
        """At T4 there's no `next` tier; progress block points the
        user to share their badge instead."""
        rid = _seed_report(client, "TOP-TIER-DEVICE", "top")
        client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        client.patch(f"/api/v1/reports/{rid}/impact",
                     headers=auth_header(analyst_token),
                     json={"lives_impacted": 1})
        body = client.get("/api/v1/reports/profile/TOP-TIER-DEVICE").json()
        assert body["tier"]["current"] == "T4_LIFEKEEPER"
        assert body["tier"]["next"] is None
        assert body["tier"]["progress"]["label_key"] == "tier_progress_top_share"

    def test_legacy_alias_field_present(self, client):
        """`badge_legacy` must surface in every /profile response
        so a pre-v145 PWA shell can fall back to the old 3-tier
        names without crashing on the unknown new strings."""
        res = client.get("/api/v1/reports/profile/LEGACY-CHECK")
        body = res.json()
        assert "badge_legacy" in body
        assert body["badge_legacy"] in ("NEWCOMER", "CONTRIBUTOR", "TRUSTED")

    def test_lives_saved_total_and_responded_count_present(self, client):
        """New fields the PWA reads for the home-stat aggregate +
        the progress sub-line."""
        res = client.get("/api/v1/reports/profile/AGG-CHECK")
        body = res.json()
        assert "lives_saved_total" in body
        assert "responded_count" in body
        assert isinstance(body["lives_saved_total"], int)
        assert isinstance(body["responded_count"], int)


class TestTierStaleStateAutoCorrects:
    """The /profile endpoint recomputes the tier on every read. A
    stored badge_level that's stale (e.g. from a missed call site
    during the v1→v2 rollout) must self-correct to match the actual
    activity signals."""

    def test_stale_t1_corrects_to_t2_on_read(self, client, db):
        """Seed a profile with a stale T1_SCOUT badge_level but
        an existing submitted report → /profile read must return
        T2_SIGNAL after recompute, not the stale value."""
        from app.models.report import ReporterProfile
        _seed_report(client, "STALE-T1-CHECK", "stale")
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == "STALE-T1-CHECK").first()
        # Force-corrupt the stored tier to a known stale value.
        profile.badge_level = "T1_SCOUT"
        db.commit()
        # /profile read must self-correct.
        res = client.get("/api/v1/reports/profile/STALE-T1-CHECK")
        body = res.json()
        assert body["badge_level"] == "T2_SIGNAL", \
            "stale stored tier must self-correct on read"


class TestVerifiedCountIdempotency:
    """May 2026 audit fix C-2 — `_mark_report_verified_for_credibility`
    must be idempotent. Calling it twice on the same report (parallel
    dispatch + resolve race) must bump `verified_count` exactly once.

    The guard is two-layered:
      1. ``Report.first_verified_at`` stamp — set on first call, used
         to short-circuit all subsequent calls.
      2. ``SELECT … FOR UPDATE`` row lock — serializes the check-and-
         set across concurrent transactions in Postgres.

    These tests pin the contract at the function-call level. A true
    parallel-transaction test would require multiprocessing + real
    Postgres locking semantics; that lives in the integration suite.
    """

    def test_double_call_does_not_double_bump(self, client, db, analyst_token):
        """Calling the credit function twice on the same report (which
        the parallel-dispatch race would cause) must increment
        verified_count exactly once."""
        from app.api.endpoints.reports import (
            _mark_report_verified_for_credibility,
        )
        from app.models.report import Report, ReporterProfile

        rid = _seed_report(client, "DEVICE-IDEMP-DOUBLE", "for-double")
        # Dispatch once via the endpoint — this fires the credit function.
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )

        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == "DEVICE-IDEMP-DOUBLE"
        ).first()
        count_after_dispatch = profile.verified_count
        assert count_after_dispatch == 1, "first dispatch must bump count"

        # Now invoke the credit function DIRECTLY a second time — this
        # simulates the parallel-race window where two transactions
        # both see was_pending=True.
        report = db.query(Report).filter(Report.id == rid).first()
        _mark_report_verified_for_credibility(report, db)
        db.commit()

        db.refresh(profile)
        assert profile.verified_count == 1, (
            "second call on already-credited report must NOT re-bump count"
        )

    def test_first_verified_at_is_stamped_on_credit(self, client, db, analyst_token):
        """The idempotency stamp must be set on the FIRST credit and
        persist across reads."""
        from app.models.report import Report

        rid = _seed_report(client, "DEVICE-IDEMP-STAMP", "for-stamp")
        # Before dispatch — stamp is null.
        report = db.query(Report).filter(Report.id == rid).first()
        assert report.first_verified_at is None, "fresh report has no stamp"

        # Dispatch → stamp should be set.
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        db.refresh(report)
        assert report.first_verified_at is not None, (
            "first dispatch must stamp first_verified_at"
        )
        stamped_at = report.first_verified_at

        # Resolve after dispatch — stamp is already set, so the
        # credit function should short-circuit without re-stamping.
        client.patch(
            f"/api/v1/reports/{rid}/resolve",
            headers=auth_header(analyst_token),
        )
        db.refresh(report)
        assert report.first_verified_at == stamped_at, (
            "subsequent resolve must not overwrite the stamp"
        )

    def test_dispatch_then_resolve_credits_exactly_once(
        self, client, db, analyst_token,
    ):
        """End-to-end via the actual endpoints: dispatch → resolve on
        the same report. Endpoint-level `was_pending` guard catches
        this case; combined with the new idempotency stamp, total
        bump should be 1."""
        from app.models.report import ReporterProfile

        rid = _seed_report(client, "DEVICE-IDEMP-ENDPOINT", "for-endpoint")
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        client.patch(
            f"/api/v1/reports/{rid}/resolve",
            headers=auth_header(analyst_token),
        )

        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == "DEVICE-IDEMP-ENDPOINT"
        ).first()
        assert profile.verified_count == 1, (
            "dispatch followed by resolve must credit verified_count ONCE, "
            "not twice"
        )
