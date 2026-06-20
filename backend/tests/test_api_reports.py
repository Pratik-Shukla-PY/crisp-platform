"""API integration tests for report endpoints."""
import pytest
from tests.conftest import auth_header


class TestReportSubmission:
    """Report submission must work WITHOUT authentication."""

    def test_create_report_meta_no_auth(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-NO-AUTH",
            "client_report_id": "no-auth-001",
            "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
            "description": "Road damage", "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        })
        assert res.status_code == 201
        assert res.json()["source"] == "APP"

    def test_create_report_idempotent(self, client):
        payload = {
            "device_hash": "TEST-IDEMP", "client_report_id": "idemp-001",
            "source": "APP", "severity": "MINOR", "infrastructure_type": "HOUSE",
            "expected_media": 0, "location": {"latitude": 10, "longitude": 20},
        }
        r1 = client.post("/api/v1/reports/meta", json=payload)
        r2 = client.post("/api/v1/reports/meta", json=payload)
        assert r1.json()["id"] == r2.json()["id"]

    def test_undp_fields_in_response(self, client):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-UNDP", "client_report_id": "undp-001",
            "source": "TELEGRAM", "severity": "SEVERE", "infrastructure_type": "HOSPITAL",
            "crisis_type": "EARTHQUAKE", "damage_classification": "COMPLETE",
            "infrastructure_name": "City Hospital", "debris_clearing_needed": True,
            "expected_media": 0, "location": {"latitude": 28, "longitude": 84},
        })
        assert res.status_code == 201
        data = res.json()
        assert data["crisis_type"] == "EARTHQUAKE"
        assert data["damage_classification"] == "COMPLETE"
        assert data["infrastructure_name"] == "City Hospital"
        assert data["debris_clearing_needed"] is True

    def test_reporter_profile_auto_created(self, client):
        client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-BADGE", "client_report_id": "badge-001",
            "source": "APP", "expected_media": 0,
            # infrastructure_type explicit — defaults to OTHER which
            # the UNDP "please specify" validator rejects without
            # infrastructure_name. We just want a profile auto-created
            # here, not to exercise the OTHER rule.
            "infrastructure_type": "ROAD",
            "location": {"latitude": 10, "longitude": 20},
        })
        res = client.get("/api/v1/reports/profile/TEST-BADGE")
        assert res.status_code == 200
        body = res.json()
        # May 2026 — submitting a report promotes from T1_SCOUT to
        # T2_SIGNAL. Legacy 3-tier alias still maps to NEWCOMER until
        # the v1 → v2 PWA shell rollout completes.
        assert body["badge_level"] == "T2_SIGNAL"
        assert body["badge_legacy"] == "NEWCOMER"
        assert body["report_count"] >= 1


class TestReportDashboard:
    """Dashboard endpoints require authentication."""

    def test_get_reports_requires_auth(self, client):
        res = client.get("/api/v1/reports/")
        assert res.status_code == 401

    def test_get_reports_viewer_allowed(self, client, viewer_token):
        res = client.get("/api/v1/reports/", headers=auth_header(viewer_token))
        assert res.status_code == 200

    def test_dispatch_requires_analyst(self, client, sample_report, viewer_token, analyst_token):
        rid = sample_report["id"]
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(viewer_token))
        assert res.status_code == 403
        res = client.patch(f"/api/v1/reports/{rid}/dispatch", headers=auth_header(analyst_token))
        assert res.status_code == 200

    def test_delete_requires_admin(self, client, sample_report, analyst_token, admin_token):
        rid = sample_report["id"]
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(analyst_token))
        assert res.status_code == 403
        res = client.delete(f"/api/v1/reports/{rid}", headers=auth_header(admin_token))
        assert res.status_code == 200


class TestMediaChunk:
    def test_chunk_upload(self, client, sample_report):
        rid = sample_report["id"]
        res = client.post(f"/api/v1/reports/{rid}/media/chunk", json={
            "media_id": "m-test-001", "type": "IMAGE", "seq_num": 0,
            "total_chunks": 1, "data": "aGVsbG8=", "checksum": None,
        })
        assert res.status_code == 200

    def test_chunk_checksum_mismatch(self, client, sample_report):
        rid = sample_report["id"]
        res = client.post(f"/api/v1/reports/{rid}/media/chunk", json={
            "media_id": "m-test-002", "type": "IMAGE", "seq_num": 0,
            "total_chunks": 1, "data": "dGVzdA==", "checksum": "00000000",
        })
        assert res.status_code == 400


class TestBuildingVersioning:
    def test_nearby_reports_get_same_building_id(self, client):
        r1 = client.post("/api/v1/reports/meta", json={
            "device_hash": "BLD-1", "client_report_id": "bld-001",
            "source": "APP", "expected_media": 0,
            "location": {"latitude": 40.7128, "longitude": -74.0060},
        })
        r2 = client.post("/api/v1/reports/meta", json={
            "device_hash": "BLD-2", "client_report_id": "bld-002",
            "source": "TELEGRAM", "expected_media": 0,
            "location": {"latitude": 40.7128, "longitude": -74.0060},  # Same location
        })
        # Both should share a building_id
        id1 = r1.json().get("building_id")
        id2 = r2.json().get("building_id")
        if id1 and id2:
            assert id1 == id2


class TestPurgeEndpoints:
    """Hard-purge endpoints are gated by SUPER_ADMIN JWT + a FRESH step-up token
    (X-Step-Up header; see POST /auth/step-up), replacing the old shared static
    X-Admin-Key. We mint a step-up token directly here to exercise the gate; the
    step-up endpoint's TOTP/password verification is covered separately."""

    @staticmethod
    def _step_up_header(admin_token):
        from app.core.security import decode_token, create_step_up_token
        uid = decode_token(admin_token).get("sub")
        return {"Authorization": f"Bearer {admin_token}", "X-Step-Up": create_step_up_token(uid)}

    def test_purge_all_pending_requires_super_admin_and_step_up(
        self, client, sample_report, admin_token,
    ):
        rid = sample_report["id"]

        # Soft-delete via admin dashboard endpoint.
        del_res = client.delete(
            f"/api/v1/reports/{rid}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert del_res.status_code == 200

        # No auth at all → 401 (role gate).
        assert client.post("/api/v1/reports/purge-all-pending").status_code == 401

        # SUPER_ADMIN JWT but NO step-up → 401 (step-up required).
        no_step = client.post(
            "/api/v1/reports/purge-all-pending",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert no_step.status_code == 401

        # SUPER_ADMIN JWT + a fresh step-up → success + row gone.
        ok = client.post("/api/v1/reports/purge-all-pending",
                         headers=self._step_up_header(admin_token))
        assert ok.status_code == 200
        assert ok.json()["purged"] >= 1

        # Row is hard-deleted — confirm at the DB level (no GET-by-id detail route).
        from tests.conftest import TestSessionLocal
        from app.models.report import Report
        s = TestSessionLocal()
        try:
            assert s.query(Report).filter(Report.id == rid).first() is None
        finally:
            s.close()

    def test_purge_rejects_step_up_minted_for_another_user(self, client, admin_token):
        from app.core.security import create_step_up_token
        bad = create_step_up_token("some-other-user-id")
        res = client.post(
            "/api/v1/reports/purge-all-pending",
            headers={"Authorization": f"Bearer {admin_token}", "X-Step-Up": bad},
        )
        assert res.status_code == 401

    def test_purge_expired_returns_count(self, client, admin_token):
        """POST /purge-expired → {"purged": <n>}, gated by SUPER_ADMIN + step-up.
        Returns 0 on a clean DB and counts rows past the grace window (we
        back-date one Report to force that branch)."""
        hdr = self._step_up_header(admin_token)

        # Empty-state path.
        res = client.post("/api/v1/reports/purge-expired", headers=hdr)
        assert res.status_code == 200
        assert res.json() == {"purged": 0}

        # Seed one report, mark it deleted, back-date requested_at past the grace window.
        from datetime import datetime, timezone, timedelta
        from tests.conftest import TestSessionLocal
        from app.models.report import Report

        meta = client.post("/api/v1/reports/meta", json={
            "device_hash": "PURGE-DEV-001",
            "client_report_id": f"purge-{datetime.now().timestamp()}",
            "source": "APP", "severity": "MODERATE",
            "infrastructure_type": "ROAD", "expected_media": 0,
            "location": {"latitude": 11.0, "longitude": 22.0},
        })
        assert meta.status_code == 201
        rid = meta.json()["id"]

        s = TestSessionLocal()
        try:
            r = s.query(Report).filter(Report.id == rid).first()
            r.deletion_requested_at = datetime.now(timezone.utc) - timedelta(days=2)
            r.deletion_grace_minutes = 1440  # 24h — expired 24h ago
            s.commit()
        finally:
            s.close()

        res = client.post("/api/v1/reports/purge-expired", headers=hdr)
        assert res.status_code == 200
        assert res.json()["purged"] >= 1


class TestStepUp:
    """POST /auth/step-up — re-confirm identity (TOTP or password) for the
    irreversible purge, replacing the shared CRISP_ADMIN_KEY. The test admin has
    no MFA enrolled, so this exercises the password fallback path."""

    def test_step_up_with_correct_password_issues_a_working_token(self, client, admin_token):
        res = client.post("/api/v1/auth/step-up", json={"code": "Admin@1234"},
                          headers={"Authorization": f"Bearer {admin_token}"})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("step_up_token")
        assert body.get("expires_in") == 600
        # The issued token actually authorizes a purge.
        ok = client.post("/api/v1/reports/purge-expired",
                         headers={"Authorization": f"Bearer {admin_token}",
                                  "X-Step-Up": body["step_up_token"]})
        assert ok.status_code == 200

    def test_step_up_with_wrong_password_rejected(self, client, admin_token):
        res = client.post("/api/v1/auth/step-up", json={"code": "not-the-password"},
                          headers={"Authorization": f"Bearer {admin_token}"})
        assert res.status_code == 401

    def test_step_up_requires_authentication(self, client):
        res = client.post("/api/v1/auth/step-up", json={"code": "Admin@1234"})
        assert res.status_code == 401


class TestDuplicateDecisions:
    """Incident Intelligence P3 - within-cluster duplicate surfacing + reversible
    analyst decisions (CONFIRMED_DUP / NOT_DUP / SET_PRIMARY / UNDO)."""

    def _mk(self, client, cid, desc="Flooded hospital ground floor", lat=12.97, lng=77.59):
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "DUP-DEV", "client_report_id": cid,
            "source": "APP", "severity": "SEVERE", "infrastructure_type": "HOSPITAL",
            "crisis_type": "FLOOD", "description": desc, "expected_media": 0,
            "location": {"latitude": lat, "longitude": lng},
        })
        assert res.status_code == 201, res.text
        return res.json()

    def test_within_cluster_duplicates_and_decisions(self, client, analyst_token, viewer_token):
        a = self._mk(client, "dup-a")
        b = self._mk(client, "dup-b", desc="Flooded hospital ground floor please help")
        # The first report at a fresh spot has no peer yet; the second's arrival
        # proximity-assigns BOTH to one building. Re-fetch for the settled state.
        a = client.get(f"/api/v1/reports/{a['id']}", headers=auth_header(viewer_token)).json()
        b = client.get(f"/api/v1/reports/{b['id']}", headers=auth_header(viewer_token)).json()
        # Same location → proximity auto-assign puts both in the SAME building (cluster).
        assert a.get("building_id") and a["building_id"] == b["building_id"]

        # a's within-cluster duplicates include b.
        res = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert any(c["report_id"] == b["id"] for c in res.json()["candidates"])

        # Viewer cannot record decisions (analyst action).
        bad = client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                          json={"decision": "NOT_DUP", "related_report_id": b["id"]},
                          headers=auth_header(viewer_token))
        assert bad.status_code == 403

        # Analyst marks NOT_DUP → b is suppressed (decision honored).
        nd = client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                         json={"decision": "NOT_DUP", "related_report_id": b["id"]},
                         headers=auth_header(analyst_token))
        assert nd.status_code == 200
        res = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(analyst_token))
        assert not any(c["report_id"] == b["id"] for c in res.json()["candidates"])

        # UNDO → b resurfaces.
        client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                    json={"decision": "UNDO", "related_report_id": b["id"]},
                    headers=auth_header(analyst_token))
        res = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(analyst_token))
        assert any(c["report_id"] == b["id"] for c in res.json()["candidates"])

        # CONFIRMED_DUP → b is pinned HIGH + confirmed.
        client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                    json={"decision": "CONFIRMED_DUP", "related_report_id": b["id"]},
                    headers=auth_header(analyst_token))
        res = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(analyst_token))
        bc = [c for c in res.json()["candidates"] if c["report_id"] == b["id"]]
        assert bc and bc[0]["confirmed"] is True and bc[0]["confidence"] == "HIGH"

        # SET_PRIMARY on b → reflected in the cluster payload.
        sp = client.post(f"/api/v1/reports/{b['id']}/duplicate-decision",
                         json={"decision": "SET_PRIMARY"}, headers=auth_header(analyst_token))
        assert sp.status_code == 200
        res = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(analyst_token))
        assert res.json()["primary_report_id"] == b["id"]

    def test_confirmed_duplicate_collapses_from_feed(self, client, analyst_token, viewer_token):
        """Confirming a duplicate collapses it UNDER its primary: gone from the feed +
        map, still reachable by id + via include_duplicates, badge count on the primary,
        dual incidents/reports counts, and fully reversible via UNDO."""
        from app.api.endpoints import analytics as _an
        a = self._mk(client, "col-a", lat=12.555, lng=77.111)
        b = self._mk(client, "col-b", lat=12.555, lng=77.111, desc="Flooded hospital ground floor help")
        a = client.get(f"/api/v1/reports/{a['id']}", headers=auth_header(viewer_token)).json()
        b = client.get(f"/api/v1/reports/{b['id']}", headers=auth_header(viewer_token)).json()
        assert a.get("building_id") and a["building_id"] == b["building_id"]

        # White-box "why": the candidate carries a per-factor reasons breakdown + a
        # masked reporter label for the review panel.
        dres = client.get(f"/api/v1/reports/{a['id']}/duplicates", headers=auth_header(viewer_token))
        cand = [c for c in dres.json()["candidates"] if c["report_id"] == b["id"]][0]
        assert any(x["factor"] == "same_building" for x in cand["reasons"])
        assert "reporter" in cand

        def feed(**params):
            res = client.get("/api/v1/reports/", params={"limit": 500, **params}, headers=auth_header(viewer_token))
            assert res.status_code == 200
            return res, {r["id"] for r in res.json()}

        res0, ids0 = feed()
        assert a["id"] in ids0 and b["id"] in ids0
        total0 = int(res0.headers["X-Total-Count"])

        # Baseline the dual counts BEFORE the merge so the assertion measures only
        # the delta this merge causes (other tests may leave state in the shared DB).
        _an._summary_cache.clear()
        c_before = client.get("/api/v1/analytics/summary", headers=auth_header(viewer_token)).json()["counts"]

        # Confirm b as a duplicate of a → b collapses under a.
        cd = client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                         json={"decision": "CONFIRMED_DUP", "related_report_id": b["id"]},
                         headers=auth_header(analyst_token))
        assert cd.status_code == 200

        # Feed: b hidden, a visible carrying duplicate_count=1, X-Total-Count -1.
        res1, ids1 = feed()
        assert b["id"] not in ids1 and a["id"] in ids1
        prim = next(r for r in res1.json() if r["id"] == a["id"])
        assert prim["duplicate_count"] == 1
        assert int(res1.headers["X-Total-Count"]) == total0 - 1

        # include_duplicates=true → b returns; by-id stays reachable.
        _r2, ids2 = feed(include_duplicates="true")
        assert b["id"] in ids2
        assert client.get(f"/api/v1/reports/{b['id']}", headers=auth_header(viewer_token)).status_code == 200

        # Map: b excluded; a's marker carries the count for the "N reports" pin.
        markers = {m["id"]: m for m in client.get("/api/v1/reports/markers", headers=auth_header(viewer_token)).json()}
        assert b["id"] not in markers and markers[a["id"]]["duplicate_count"] == 1

        # Analytics: total reports unchanged (corroboration kept), incidents -1.
        _an._summary_cache.clear()
        c_after = client.get("/api/v1/analytics/summary", headers=auth_header(viewer_token)).json()["counts"]
        assert c_after["reports"] == c_before["reports"]
        assert c_after["incidents"] == c_before["incidents"] - 1

        # UNDO → b restored to the feed; the badge resets.
        client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                    json={"decision": "UNDO", "related_report_id": b["id"]},
                    headers=auth_header(analyst_token))
        res3, ids3 = feed()
        assert b["id"] in ids3
        assert next(r for r in res3.json() if r["id"] == a["id"])["duplicate_count"] == 0

    def test_set_primary_flips_which_report_is_visible(self, client, analyst_token, viewer_token):
        """SET_PRIMARY re-points the group: the new primary shows in the feed, the old
        one collapses. Membership is the relationship, not a container."""
        a = self._mk(client, "sp-a", lat=13.201, lng=77.701)
        b = self._mk(client, "sp-b", lat=13.201, lng=77.701, desc="Same hospital flooding reported again")
        a = client.get(f"/api/v1/reports/{a['id']}", headers=auth_header(viewer_token)).json()
        b = client.get(f"/api/v1/reports/{b['id']}", headers=auth_header(viewer_token)).json()
        assert a["building_id"] == b["building_id"]
        client.post(f"/api/v1/reports/{a['id']}/duplicate-decision",
                    json={"decision": "CONFIRMED_DUP", "related_report_id": b["id"]},
                    headers=auth_header(analyst_token))

        def visible():
            return {r["id"] for r in client.get("/api/v1/reports/", params={"limit": 500},
                                                headers=auth_header(viewer_token)).json()}
        # a is primary (visible), b collapsed.
        v = visible()
        assert a["id"] in v and b["id"] not in v
        # Make b the primary → b visible, a collapsed.
        client.post(f"/api/v1/reports/{b['id']}/duplicate-decision",
                    json={"decision": "SET_PRIMARY"}, headers=auth_header(analyst_token))
        v = visible()
        assert b["id"] in v and a["id"] not in v

    def test_duplicate_summary_and_bulk_merge(self, client, analyst_token, viewer_token):
        """The review panels' summary counts unconfirmed pairs by confidence; the bulk
        merge confirms them all at one level (analyst-only) and they collapse."""
        a = self._mk(client, "bm-a", lat=14.011, lng=78.022)
        b = self._mk(client, "bm-b", lat=14.011, lng=78.022, desc="Flooded hospital ground floor please")
        a = client.get(f"/api/v1/reports/{a['id']}", headers=auth_header(viewer_token)).json()
        b = client.get(f"/api/v1/reports/{b['id']}", headers=auth_header(viewer_token)).json()
        assert a["building_id"] == b["building_id"]

        summ = client.get("/api/v1/reports/duplicate-summary", headers=auth_header(viewer_token)).json()
        assert summ["total"] >= 1
        cand = next(c for c in client.get(f"/api/v1/reports/{a['id']}/duplicates",
                                          headers=auth_header(viewer_token)).json()["candidates"]
                    if c["report_id"] == b["id"])
        level = cand["confidence"]

        # Viewer cannot bulk-merge (analyst action).
        assert client.post("/api/v1/reports/duplicate-merge", json={"confidence": level},
                           headers=auth_header(viewer_token)).status_code == 403
        res = client.post("/api/v1/reports/duplicate-merge", json={"confidence": level},
                          headers=auth_header(analyst_token))
        assert res.status_code == 200 and res.json()["merged"] >= 1

        # b collapsed from the feed; the pair drops out of the summary.
        ids = {r["id"] for r in client.get("/api/v1/reports/", params={"limit": 500},
                                           headers=auth_header(viewer_token)).json()}
        assert b["id"] not in ids and a["id"] in ids
        summ2 = client.get("/api/v1/reports/duplicate-summary", headers=auth_header(viewer_token)).json()
        assert summ2["total"] <= summ["total"] - 1

    def test_merge_all_collapses_whole_cluster_in_one_call(self, client, analyst_token, viewer_token):
        """confidence=ALL collapses an ENTIRE duplicate cluster under ONE primary
        (the earliest) in a single group-aware call - not pair-by-pair, no
        stragglers left needing another click."""
        a = self._mk(client, "ma-a", lat=15.512, lng=79.521)
        b = self._mk(client, "ma-b", lat=15.512, lng=79.521)
        c = self._mk(client, "ma-c", lat=15.512, lng=79.521)
        # ONE click, every level.
        res = client.post("/api/v1/reports/duplicate-merge", json={"confidence": "ALL"},
                          headers=auth_header(analyst_token))
        assert res.status_code == 200, res.text
        assert res.json()["merged"] >= 2   # b + c collapse under a (2 merges, one cluster)

        ids = {r["id"] for r in client.get("/api/v1/reports/", params={"limit": 500},
                                           headers=auth_header(viewer_token)).json()}
        # The earliest report (a) survives as the primary; b + c collapse out of the feed.
        assert a["id"] in ids
        assert b["id"] not in ids and c["id"] not in ids

    def test_lone_report_has_no_within_cluster_duplicates(self, client, viewer_token):
        r = self._mk(client, "dup-solo", lat=1.234, lng=2.345)
        res = client.get(f"/api/v1/reports/{r['id']}/duplicates", headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert res.json()["candidates"] == []
