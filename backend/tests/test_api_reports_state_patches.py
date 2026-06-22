"""State-changing PATCH endpoints on /reports/{id}.

Covers each column-mutating endpoint:

    /classify, /false-alarm, /dispatch, /review (reviewer verdict),
    /undo-delete, /location, /impact, /ai-summary

…and asserts both the column mutation *and* the role-gate (where the code
enforces one). Several of these endpoints are intentionally unauthenticated
— they're called by the Telegram / WhatsApp / IVR / SMS bots — and the
tests document that with explicit comments so a future auth-hardening PR
has an anchor to grep.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from tests.conftest import auth_header


class TestClassifyPatch:
    def test_classify_updates_damage_and_sev_and_requires_analyst(
        self, client, sample_report, db,
    ):
        """PATCH /classify writes severity + damage_classification.

        FINDING — this endpoint is UNAUTHENTICATED in the current code
        because it's called by the messaging bots (Telegram / WhatsApp)
        to update classification after initial creation. We therefore
        assert the mutation works WITHOUT a token rather than assert a
        403 for viewers. See `messaging_bot/ai_extractor.py` for the
        caller side. A hardening PR adding `require_analyst` here MUST
        also expose a per-bot service-token; until that lands, leaving
        the endpoint open is a deliberate design decision.
        """
        rid = sample_report["id"]
        res = client.patch(f"/api/v1/reports/{rid}/classify", json={
            "damage_classification": "COMPLETE",
            "severity": "CRITICAL",
        })
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.severity.value == "CRITICAL"
        assert r.damage_classification == "COMPLETE"


class TestFalseAlarmPatch:
    def test_false_alarm_sets_status_FALSE_ALARM(
        self, client, sample_report, analyst_token, viewer_token, db,
    ):
        rid = sample_report["id"]

        # Role gate — viewer gets 403.
        res_v = client.patch(
            f"/api/v1/reports/{rid}/false-alarm",
            headers=auth_header(viewer_token),
        )
        assert res_v.status_code == 403

        # Analyst succeeds.
        res = client.patch(
            f"/api/v1/reports/{rid}/false-alarm",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.status.value == "FALSE_ALARM"


class TestDispatchPatch:
    def test_dispatch_sets_help_dispatched_at_and_RESPONDING_status(
        self, client, sample_report, analyst_token, db,
    ):
        """The dispatch endpoint flips status → RESPONDING. help_dispatched_at
        is written by the /timestamps endpoint, NOT /dispatch; the two are
        separate in the current model (dispatch = state change, timestamps
        = responder wall-clock). This test pins /dispatch's mutation and
        then uses /timestamps to write help_dispatched_at."""
        rid = sample_report["id"]

        res = client.patch(
            f"/api/v1/reports/{rid}/dispatch",
            headers=auth_header(analyst_token),
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.status.value == "RESPONDING"

        # And the companion /timestamps endpoint stamps the wall-clock.
        res2 = client.patch(
            f"/api/v1/reports/{rid}/timestamps",
            headers=auth_header(analyst_token),
            json={"stamp_dispatched_now": True},
        )
        assert res2.status_code == 200
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.help_dispatched_at is not None


class TestReopenPatch:
    def test_reopen_reverts_responding_to_pending(
        self, client, sample_report, analyst_token, viewer_token, db,
    ):
        """RESPONDING → PENDING via /reopen (the operator's 'undo notify' on the
        incident detail), clearing the dispatch/arrival timestamps. Role-gated."""
        from app.models.report import Report
        rid = sample_report["id"]
        client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        client.patch(f"/api/v1/reports/{rid}/timestamps", headers=auth_header(analyst_token),
                     json={"stamp_dispatched_now": True})
        # viewer cannot reopen
        assert client.patch(f"/api/v1/reports/{rid}/reopen", headers=auth_header(viewer_token)).status_code == 403
        # analyst reopens → PENDING, timestamps cleared
        assert client.patch(f"/api/v1/reports/{rid}/reopen", headers=auth_header(analyst_token)).status_code == 200
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.status.value == "PENDING"
        assert r.help_dispatched_at is None

    def test_reopen_reverts_false_alarm_then_resolved(self, client, sample_report, analyst_token, db):
        from app.models.report import Report
        rid = sample_report["id"]
        client.patch(f"/api/v1/reports/{rid}/false-alarm", headers=auth_header(analyst_token))
        assert client.patch(f"/api/v1/reports/{rid}/reopen", headers=auth_header(analyst_token)).status_code == 200
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().status.value == "PENDING"
        client.patch(f"/api/v1/reports/{rid}/resolve", headers=auth_header(analyst_token))
        assert client.patch(f"/api/v1/reports/{rid}/reopen", headers=auth_header(analyst_token)).status_code == 200
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().status.value == "PENDING"

    def test_revert_rejection_via_review_not_reviewed(self, client, sample_report, analyst_token, db):
        """Reverting a REJECTED verdict is verdict-based: PATCH /review {NOT_REVIEWED}."""
        from app.models.report import Report
        rid = sample_report["id"]
        client.patch(f"/api/v1/reports/{rid}/review", headers=auth_header(analyst_token),
                     json={"verdict": "REJECTED", "action_taken": "duplicate of #123"})
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().reviewer_verdict == "REJECTED"
        assert client.patch(f"/api/v1/reports/{rid}/review", headers=auth_header(analyst_token),
                            json={"verdict": "NOT_REVIEWED"}).status_code == 200
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().reviewer_verdict == "NOT_REVIEWED"


class TestReviewerVerdictPatch:
    def test_verify_sets_reviewer_verdict_VERIFIED(
        self, client, sample_report, analyst_token, db,
    ):
        """PATCH /review with verdict=ACCEPTED stores the analyst's verdict.

        NOTE — the test name says "_VERIFIED" but the enum values are
        NOT_REVIEWED / ACCEPTED / REJECTED (no VERIFIED). `/review`
        is the correct reviewer-verdict endpoint; `/verify` is the
        satellite-truth check (separate feature, calls Sentinel + Claude).
        """
        rid = sample_report["id"]

        res = client.patch(
            f"/api/v1/reports/{rid}/review",
            headers=auth_header(analyst_token),
            json={"verdict": "ACCEPTED"},
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.reviewer_verdict == "ACCEPTED"
        assert r.reviewed_at is not None


class TestUndoDeletePatch:
    def test_undo_delete_requires_ownership_or_admin(
        self, client, sample_report, admin_token, db,
    ):
        """Reversing the privacy soft-delete (must-have #10) requires proof of
        ownership: an owning device_hash OR an admin JWT. An anonymous or
        wrong-device caller is rejected with 403 BEFORE any state changes."""
        rid = sample_report["id"]

        # Soft delete (requires admin).
        res = client.delete(
            f"/api/v1/reports/{rid}",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.deletion_requested_at is not None

        # (1) Anonymous, no device_hash → 403, deletion untouched.
        res = client.post(f"/api/v1/reports/{rid}/undo-delete")
        assert res.status_code == 403
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().deletion_requested_at is not None

        # (2) Wrong device_hash → 403.
        res = client.post(f"/api/v1/reports/{rid}/undo-delete?device_hash=TEST-DEVICE-999")
        assert res.status_code == 403

        # (3) Owning device_hash (the one sample_report enrolled with) → 200, cleared.
        res = client.post(f"/api/v1/reports/{rid}/undo-delete?device_hash=TEST-DEVICE-001")
        assert res.status_code == 200
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().deletion_requested_at is None

    def test_undo_delete_admin_jwt_path(
        self, client, sample_report, admin_token, db,
    ):
        """An admin JWT can undo without a device_hash (mirrors the DELETE gate)."""
        rid = sample_report["id"]
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(admin_token))
        assert res.status_code == 200

        res = client.post(
            f"/api/v1/reports/{rid}/undo-delete",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        assert db.query(Report).filter(Report.id == rid).first().deletion_requested_at is None


class TestLocationPatch:
    def test_location_patch_updates_lat_lng_and_flags_user_corrected(
        self, client, sample_report, db,
    ):
        """Dashboard flow: analyst drops the pin on a new spot. Endpoint
        accepts ``is_user_corrected: true`` as an explicit pass-through so
        the row is attributable to a human (vs bot-authored geocoder
        backfill, which leaves the flag False).

        Bug fix in this change: the `/location` endpoint now honours the
        ``is_user_corrected`` payload field. Previously it was silently
        dropped — the dashboard UI surfaced "manually corrected" pins
        without a matching DB column to filter on.
        """
        rid = sample_report["id"]

        res = client.patch(
            f"/api/v1/reports/{rid}/location",
            json={
                "latitude": 10.0,
                "longitude": 20.0,
                "is_user_corrected": True,
            },
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.location is not None
        assert abs(r.location.latitude - 10.0) < 1e-6
        assert abs(r.location.longitude - 20.0) < 1e-6
        assert r.location.is_user_corrected is True


class TestImpactPatch:
    def test_impact_patch_sets_lives_impacted(
        self, client, sample_report, analyst_token, viewer_token, db,
    ):
        rid = sample_report["id"]

        # Role gate.
        res_v = client.patch(
            f"/api/v1/reports/{rid}/impact",
            headers=auth_header(viewer_token),
            json={"lives_impacted": 42},
        )
        assert res_v.status_code == 403

        # Analyst OK.
        res = client.patch(
            f"/api/v1/reports/{rid}/impact",
            headers=auth_header(analyst_token),
            json={"lives_impacted": 42},
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.lives_impacted == 42


class TestAISummaryPatch:
    def test_ai_summary_patch_updates_ai_analysis_summary(
        self, client, sample_report, db,
    ):
        """PATCH /ai-summary writes to the linked AIAnalysis row (created
        lazily if absent). Endpoint is unauthenticated — called by the
        AI extractor / IVR transcription pipeline.
        """
        rid = sample_report["id"]

        res = client.patch(
            f"/api/v1/reports/{rid}/ai-summary",
            json={"summary": "ignored-alias", "ai_summary": "Real summary text."},
        )
        assert res.status_code == 200

        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.ai_analysis is not None
        assert r.ai_analysis.ai_summary == "Real summary text."


class TestGetSingleReport:
    """C1-d (Phase-0): GET /reports/{id} - the dashboard's lazy by-id fetch for
    reports outside the newest-N working set. Includes a route-ordering guard so
    the catch-all path param can't shadow the single-segment GETs."""

    def test_get_report_by_id_returns_full_report(self, client, sample_report, admin_token):
        rid = sample_report["id"]
        res = client.get(f"/api/v1/reports/{rid}", headers=auth_header(admin_token))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["id"] == rid
        # ReportResponse never embeds reporter PII (must-have #9).
        assert "reporter_email" not in body and "reporter_phone" not in body

    def test_get_report_requires_auth(self, client, sample_report):
        res = client.get(f"/api/v1/reports/{sample_report['id']}")
        assert res.status_code == 401

    def test_get_missing_report_404(self, client, admin_token):
        res = client.get("/api/v1/reports/no-such-report-id", headers=auth_header(admin_token))
        assert res.status_code == 404

    def test_id_catchall_does_not_shadow_markers(self, client, admin_token):
        # Route-ordering guard: GET /{report_id} must NOT swallow GET /markers.
        res = client.get("/api/v1/reports/markers?limit=10", headers=auth_header(admin_token))
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    def test_id_catchall_does_not_shadow_nearby(self, client, admin_token):
        # /nearby requires lat/lng query args; a 200/422 (not a 404 "report not
        # found") proves the /nearby route still resolves, not the /{id} catch-all.
        res = client.get("/api/v1/reports/nearby?lat=12.97&lng=77.59&radius_km=5",
                         headers=auth_header(admin_token))
        assert res.status_code in (200, 422)


def test_pending_deletion_filter_lists_only_deleted(client, sample_report, admin_token):
    """M15 (Phase-4): ?pending_deletion=true returns ONLY reports pending deletion,
    with an accurate X-Total-Count. Replaces the old client-side filter over the
    newest-500 listing slice that silently undercounted the backlog at scale."""
    rid = sample_report["id"]
    # Not pending deletion yet → absent from the pending-deletion listing.
    r0 = client.get("/api/v1/reports/?pending_deletion=true", headers=auth_header(admin_token))
    assert r0.status_code == 200
    assert rid not in [x["id"] for x in r0.json()]
    # Soft-delete it (admin).
    assert client.delete(f"/api/v1/reports/{rid}", headers=auth_header(admin_token)).status_code == 200
    # Now it appears in the pending-deletion listing + X-Total-Count counts it.
    r1 = client.get("/api/v1/reports/?pending_deletion=true", headers=auth_header(admin_token))
    assert r1.status_code == 200
    assert rid in [x["id"] for x in r1.json()]
    assert int(r1.headers.get("X-Total-Count", "0")) >= 1
    # The DEFAULT (non-deleted) listing excludes it.
    r2 = client.get("/api/v1/reports/", headers=auth_header(admin_token))
    assert rid not in [x["id"] for x in r2.json()]
