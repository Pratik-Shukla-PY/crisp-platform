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
              "open_dispatch", "resolved_in_window", "active_ops", "escalating", "stale"):
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


def test_summary_params_validated(client, viewer_token):
    # Out-of-range window/stale must be rejected by FastAPI validation.
    assert client.get("/api/v1/analytics/summary?window_hours=0",
                      headers=_hdr(viewer_token)).status_code == 422
    assert client.get("/api/v1/analytics/summary?stale_hours=99999",
                      headers=_hdr(viewer_token)).status_code == 422
