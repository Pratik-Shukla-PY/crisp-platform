"""GET /api/v1/analytics/summary — dashboard situational-awareness aggregate.

Verifies auth gating, response shape, and that counts/distributions reflect
REAL report data (no hardcoded values). Powers the Crisis Intelligence
dashboard landing (web-dashboard/docs/crisis-intelligence-dashboard-spec.md).
"""


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def test_summary_requires_auth(client):
    # require_viewer must gate operational data.
    assert client.get("/api/v1/analytics/summary").status_code == 401


def test_summary_shape(client, viewer_token):
    r = client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token))
    assert r.status_code == 200
    b = r.json()
    for k in ("generated_at", "window_hours", "stale_hours", "total_reports",
              "counts", "distributions", "timings", "impact", "deltas"):
        assert k in b, f"missing top-level key: {k}"
    for k in ("active", "critical", "pending_verification", "awaiting_triage",
              "open_dispatch", "resolved_in_window", "active_ops", "escalating", "stale",
              "sla_at_risk"):
        assert isinstance(b["counts"][k], int), f"counts.{k} not int"
    assert isinstance(b["distributions"]["by_severity"], dict)
    assert isinstance(b["distributions"]["by_crisis_type"], dict)
    assert isinstance(b["distributions"]["by_status"], dict)
    assert isinstance(b["distributions"]["verified"], int)
    assert isinstance(b["distributions"]["unverified"], int)
    assert isinstance(b["impact"]["critical_infrastructure"], int)
    assert isinstance(b["impact"]["lives_impacted_sum"], int)
    assert isinstance(b["impact"]["responders_active"], int)
    # service_disruptions is a nullable int (None if the JSON dialect query fails).
    assert b["impact"]["service_disruptions"] is None or isinstance(b["impact"]["service_disruptions"], int)
    # timings are nullable floats.
    for k in ("avg_verification_seconds", "avg_response_seconds"):
        v = b["timings"][k]
        assert v is None or isinstance(v, (int, float)), f"timings.{k} bad type"
    for k in ("reports_24h", "reports_prev_24h", "reports_7d", "reports_prev_7d"):
        assert isinstance(b["deltas"][k], int)


def test_summary_reflects_live_data(client, viewer_token, sample_report):
    # sample_report creates one PENDING / NOT_REVIEWED report just now.
    # Bypass the 30s in-process cache so the new row is counted.
    from app.api.endpoints.analytics import _summary_cache
    _summary_cache.clear()
    b = client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token)).json()
    assert b["total_reports"] >= 1
    assert b["counts"]["active"] >= 1                 # PENDING counts as active
    assert b["counts"]["pending_verification"] >= 1   # default reviewer_verdict NOT_REVIEWED
    assert b["counts"]["awaiting_triage"] >= 1        # PENDING + NOT_REVIEWED
    assert b["distributions"]["by_status"].get("PENDING", 0) >= 1
    assert b["deltas"]["reports_24h"] >= 1            # created within the last 24h


def test_summary_incidents_is_the_real_incident_entity(client, viewer_token, sample_report, db):
    # counts.incidents now reflects the first-class Incident entity (distinct
    # incident_id + each incident-less report as its own singleton), NOT the old
    # duplicate-resolver count. Recompute the same formula independently on the SAME
    # DB and assert the endpoint matches it (robust to whatever else is seeded).
    from sqlalchemy import func
    from app.models.report import Report
    from app.api.endpoints.analytics import _summary_cache
    _summary_cache.clear()
    b = client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token)).json()
    nd = Report.deletion_requested_at.is_(None)
    distinct_inc = int(db.query(func.count(func.distinct(Report.incident_id)))
                       .filter(nd, Report.incident_id.isnot(None)).scalar() or 0)
    null_singletons = int(db.query(func.count(Report.id))
                          .filter(nd, Report.incident_id.is_(None)).scalar() or 0)
    assert b["counts"]["incidents"] == distinct_inc + null_singletons
    # an incident aggregates ≥1 reports, so the unit count never exceeds report volume.
    assert b["counts"]["reports"] >= b["counts"]["incidents"]


def test_summary_params_validated(client, viewer_token):
    # Out-of-range window/stale must be rejected by FastAPI validation.
    assert client.get("/api/v1/analytics/summary?window_hours=0",
                      headers=_hdr(viewer_token)).status_code == 422
    assert client.get("/api/v1/analytics/summary?stale_hours=99999",
                      headers=_hdr(viewer_token)).status_code == 422


def test_summary_critical_excludes_rejected(client, viewer_token, db):
    """CONSISTENCY CONTRACT: a REJECTED report is set aside — it is counted ONLY in
    counts.rejected, never as an open 'critical' (nor in pending/active). This is what
    makes the home Command Centre, the incidents-page tabs and the rendered feed agree;
    pre-fix a rejected CRITICAL inflated counts.critical so the tile said N but the
    'critical' queue (which excludes rejected) rendered fewer/none. Delta-based so it is
    robust to whatever else the suite has seeded."""
    import time
    from app.models.report import Report
    from app.api.endpoints.analytics import _summary_cache

    def _counts():
        _summary_cache.clear()
        return client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token)).json()["counts"]

    def _mk_critical(cid):
        r = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-DEVICE-CRIT", "client_report_id": cid, "source": "APP",
            "severity": "CRITICAL", "infrastructure_type": "HOSPITAL",
            "description": "critical consistency probe", "expected_media": 0,
            "crisis_type": "EARTHQUAKE", "damage_classification": "COMPLETE",
            "location": {"latitude": 12.9, "longitude": 77.5},
        })
        assert r.status_code == 201
        return r.json()["id"]

    base = _counts()
    # An OPEN, non-rejected critical DOES count as critical + pending.
    _mk_critical(f"crit-keep-{time.time()}")
    after_keep = _counts()
    assert after_keep["critical"] == base["critical"] + 1
    assert after_keep["pending"] == base["pending"] + 1

    # A REJECTED critical must NOT move critical/pending — it lands in rejected only.
    rid = _mk_critical(f"crit-rej-{time.time()}")
    row = db.query(Report).filter(Report.id == rid).first()
    row.reviewer_verdict = "REJECTED"
    db.commit()
    after_rej = _counts()
    assert after_rej["critical"] == after_keep["critical"], "rejected critical leaked into counts.critical"
    assert after_rej["pending"] == after_keep["pending"], "rejected report leaked into counts.pending"
    assert after_rej["rejected"] == after_keep["rejected"] + 1, "rejected report not counted in counts.rejected"


def test_summary_excludes_confirmed_duplicates(client, viewer_token, db):
    """CONSISTENCY CONTRACT: the incident feed COLLAPSES confirmed-duplicate reports under
    their primary (only the primary is visible). The summary counts MUST exclude the same
    hidden duplicates, or the home Command Centre over-counts vs the feed — the operator's
    "home shows Critical 1, the global feed shows Critical 0" (the 1 critical was a
    collapsed duplicate). Delta-based, robust to other seeded data."""
    import time
    from app.models.report import Report, ReportDuplicateDecision
    from app.api.endpoints.analytics import _summary_cache

    def _counts():
        _summary_cache.clear()
        return client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token)).json()["counts"]

    def _mk(cid, sev):
        r = client.post("/api/v1/reports/meta", json={
            "device_hash": "TEST-DEVICE-DUP", "client_report_id": cid, "source": "APP",
            "severity": sev, "infrastructure_type": "HOSPITAL", "description": "dup probe",
            "expected_media": 0, "crisis_type": "EARTHQUAKE", "damage_classification": "COMPLETE",
            "location": {"latitude": 12.9, "longitude": 77.5},
        })
        assert r.status_code == 201
        return r.json()["id"]

    base = _counts()
    primary = _mk(f"dup-primary-{time.time()}", "MODERATE")
    dup_crit = _mk(f"dup-crit-{time.time()}", "CRITICAL")
    after = _counts()
    # Before the merge: the critical + both reports count.
    assert after["critical"] == base["critical"] + 1
    assert after["reports"] == base["reports"] + 2

    # Mark the CRITICAL as a CONFIRMED duplicate of the (non-critical) primary — the feed
    # now collapses it under the primary.
    db.add(ReportDuplicateDecision(
        cluster_key="h3:test-dup", primary_report_id=primary,
        related_report_id=dup_crit, decision="CONFIRMED_DUP"))
    db.commit()

    deduped = _counts()
    assert deduped["critical"] == base["critical"], "a collapsed-duplicate critical leaked into counts.critical"
    assert deduped["reports"] == base["reports"] + 1, "the hidden duplicate was still counted in counts.reports"
    assert deduped["duplicate_reports"] >= 1, "the collapsed duplicate is not reflected in counts.duplicate_reports"


def test_summary_resolved_excludes_rejected(client, viewer_token, db):
    """CONSISTENCY CONTRACT: counts.resolved is the CLOSED/handled bucket (RESOLVED or
    FALSE_ALARM) but a REJECTED report is SET ASIDE — it belongs ONLY to counts.rejected,
    even if its status is RESOLVED. Without this, a resolved-then-rejected report would be
    double-counted (in both resolved and rejected) and the home tile would disagree with the
    feed's Resolved tab (which drops verdict==REJECTED). Delta-based, robust to other data."""
    import time
    from app.models.report import Report
    from app.api.endpoints.analytics import _summary_cache

    def _counts():
        _summary_cache.clear()
        return client.get("/api/v1/analytics/summary", headers=_hdr(viewer_token)).json()["counts"]

    r = client.post("/api/v1/reports/meta", json={
        "device_hash": "TEST-DEVICE-RESOLVED", "client_report_id": f"res-rej-{time.time()}",
        "source": "APP", "severity": "MODERATE", "infrastructure_type": "ROAD",
        "description": "resolved-then-rejected probe", "expected_media": 0,
        "crisis_type": "FLOOD", "damage_classification": "PARTIAL",
        "location": {"latitude": 12.9, "longitude": 77.5},
    })
    assert r.status_code == 201
    rid = r.json()["id"]
    row = db.query(Report).filter(Report.id == rid).first()

    base = _counts()
    # Mark it RESOLVED → it joins the resolved bucket.
    row.status = "RESOLVED"
    db.commit()
    after_res = _counts()
    assert after_res["resolved"] == base["resolved"] + 1

    # Now REJECT it → it leaves resolved entirely and lands in rejected only.
    row.reviewer_verdict = "REJECTED"
    db.commit()
    after_rej = _counts()
    assert after_rej["resolved"] == base["resolved"], "a rejected report leaked into counts.resolved"
    assert after_rej["rejected"] == after_res["rejected"] + 1, "the rejected report is missing from counts.rejected"
