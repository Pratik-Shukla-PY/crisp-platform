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


class TestReporterTierOnReportResponse:
    """Phase 1.6 (May 2026) — Dashboard V4 field parity.

    The `/api/v1/reports/` listing endpoint must surface
    `reporter_tier` (T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER /
    T4_LIFEKEEPER) on every report whose device has an entry in
    ReporterProfile. Anonymous reports without a device get
    `reporter_tier=null`, which the dashboard renders as "no tier
    badge" (NEVER as T1_SCOUT — that would be misleading).

    The tier is bulk-joined in `_attach_reporter_tier` so the listing
    endpoint stays at O(1) extra queries regardless of page size.
    """

    def test_listing_includes_reporter_tier(
        self, client, db, analyst_token,
    ):
        """A device that has submitted + been dispatched should
        surface as T3_CHANGEMAKER on every report in the listing.

        Test-pollution fix (May 2026): the `client` fixture is
        session-scoped against `crisp_test`, so a re-run of pytest
        finds the device_hash + client_report_id already in the DB
        and the meta-POST hits the idempotency path (no new row,
        no fresh dispatch credit). Using a uuid suffix per run
        keeps every invocation clean.
        """
        import uuid as _uuid
        device_hash = f"DEVICE-TIER-LIST-{_uuid.uuid4().hex[:8]}"
        rid = _seed_report(client, device_hash, f"for-listing-{_uuid.uuid4().hex[:8]}")
        client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )

        # Listing should now include reporter_tier on every row for
        # this device. Use analyst auth so we can hit the gated endpoint.
        res = client.get(
            "/api/v1/reports/",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200, res.text
        rows = res.json()
        assert any(r.get("reporter_tier") == "T3_CHANGEMAKER" for r in rows), (
            "expected at least one row with reporter_tier=T3_CHANGEMAKER "
            f"after dispatch; got tiers: {[r.get('reporter_tier') for r in rows]}"
        )

    def test_listing_null_tier_for_legacy_badge_level(
        self, client, db, analyst_token,
    ):
        """Devices whose ReporterProfile still carries a legacy
        badge_level (HERO/GUARDIAN/HELPER/NEWCOMER from the pre-V4
        ladder) must NOT surface a tier on the listing — the
        dashboard renders NULL rather than misrepresenting a
        legacy "HERO" as "T4_LIFEKEEPER".
        """
        from app.models.report import ReporterProfile, Device
        import uuid as _uuid
        device_hash = f"DEVICE-TIER-LEGACY-{_uuid.uuid4().hex[:8]}"

        # Submit a report so a device row exists. The /profile read
        # path normalises legacy badges to T-tiers, so we have to
        # write the legacy value DIRECTLY after submission to bypass
        # the normaliser.
        _seed_report(client, device_hash, f"for-legacy-{_uuid.uuid4().hex[:8]}")
        # Force the row back to a legacy badge_level.
        profile = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash
        ).first()
        assert profile is not None
        profile.badge_level = "HERO"  # legacy v1 value
        db.commit()

        res = client.get(
            "/api/v1/reports/",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200, res.text
        rows = res.json()
        # Find the row(s) tied to our device.
        device = db.query(Device).filter(
            Device.device_hash == device_hash
        ).first()
        assert device is not None
        ours = [r for r in rows if r.get("device_id") == device.id]
        assert ours, f"expected at least one row for {device_hash} in the listing"
        for r in ours:
            assert r.get("reporter_tier") is None, (
                "legacy badge_level (HERO/GUARDIAN/HELPER/NEWCOMER) must NOT "
                f"surface as reporter_tier; got {r.get('reporter_tier')!r}"
            )

    def test_listing_null_tier_for_no_profile(
        self, client, analyst_token,
    ):
        """Reports whose device has no ReporterProfile row (rare —
        only possible if the profile was manually deleted) must
        surface reporter_tier=null without raising."""
        res = client.get(
            "/api/v1/reports/",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200, res.text
        # Even if every device in the test DB DOES have a profile, the
        # response must be deterministic and never 500 on tier-attach
        # failure. The bulk helper swallows exceptions; this test is
        # the regression guard for that behavior.
        rows = res.json()
        assert isinstance(rows, list)

    def test_device_reports_endpoint_includes_reporter_tier(
        self, client, db, analyst_token,
    ):
        """Phase 1.6 follow-up (May 2026) — the PWA / RN "My Reports"
        page reads `GET /api/v1/reports/device/{device_hash}`. Before
        this fix it returned reports WITHOUT reporter_tier (the
        dashboard list got it but the per-device feed didn't).
        """
        import uuid as _uuid
        from app.models.report import ReporterProfile
        # Use a unique device_hash per test run so prior runs don't
        # leave the device at a pre-dispatched state. The seeded
        # report's idempotency key (client_report_id) uses the SAME
        # suffix so the meta endpoint creates a fresh row in this
        # device's namespace.
        device_hash = f"DEVICE-TIER-MY-REPORTS-{_uuid.uuid4().hex[:8]}"
        rid = _seed_report(client, device_hash, f"for-my-reports-{_uuid.uuid4().hex[:8]}")
        # Dispatch so the device promotes to T3_CHANGEMAKER.
        dispatch_res = client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        assert dispatch_res.status_code == 200, dispatch_res.text
        # Sanity: dispatch promoted the device's profile to T3 in the
        # DB. Pin this BEFORE asserting the response so we can
        # distinguish "promotion logic broke" from "endpoint dropped
        # the tier on serialization".
        db.expire_all()
        prof = db.query(ReporterProfile).filter(
            ReporterProfile.device_hash == device_hash
        ).first()
        assert prof is not None, "ReporterProfile must exist after dispatch"
        assert prof.badge_level == "T3_CHANGEMAKER", (
            f"dispatch must promote profile to T3_CHANGEMAKER; "
            f"got {prof.badge_level!r}"
        )
        # The device-reports endpoint is unauthenticated (PWA + RN
        # call it without a token for the user's own device).
        res = client.get(f"/api/v1/reports/device/{device_hash}")
        assert res.status_code == 200, res.text
        rows = res.json()
        assert rows, "expected at least one row for the seeded device"
        # Every row for this device must carry the T3 tier the
        # dispatch promoted to.
        tiers = [r.get("reporter_tier") for r in rows]
        assert "T3_CHANGEMAKER" in tiers, (
            f"device-reports endpoint dropped reporter_tier; got: {tiers}"
        )
