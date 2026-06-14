"""Endpoint tests for Dynamic Crisis Forms — admin CRUD + publish/rollback +
the public geo-matched /active endpoint. Uses the conftest client + admin_token."""
import pytest

VALID_SCHEMA = {
    "key": "wildfire-default",
    "title": "Forest Fire — rapid assessment",
    "sections": [
        {"id": "classify", "stage": 2, "title": "Assess", "fields": [
            {"key": "flames_visible", "type": "yes_no", "label": "Flames visible?", "required": True},
            {"key": "damage_classification", "type": "single_select", "label": "Damage?",
             "maps_to": "damage_classification",
             "options": [{"value": "MINIMAL", "label": "Minimal"}, {"value": "COMPLETE", "label": "Complete"}]},
        ]},
    ],
}
# Bandipur-ish center; "inside" == the center itself, "outside" == null island.
CENTER = (11.6680, 76.6340)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


# ── auth gating ─────────────────────────────────────────────────────────────
def test_admin_endpoints_require_auth(client):
    assert client.get("/api/v1/admin/crisis-forms/events").status_code == 401


def test_admin_endpoints_reject_viewer(client, viewer_token):
    r = client.get("/api/v1/admin/crisis-forms/events", headers=_h(viewer_token))
    assert r.status_code == 403


def test_admin_list_ok_for_admin(client, admin_token):
    assert client.get("/api/v1/admin/crisis-forms/events", headers=_h(admin_token)).status_code == 200


# ── pack lifecycle + geo activation ─────────────────────────────────────────
def _publish_pack(client, admin_token, key="wildfire-default"):
    schema = dict(VALID_SCHEMA, key=key)
    p = client.post("/api/v1/admin/crisis-forms/packs",
                    json={"key": key, "title": "Forest Fire", "crisis_type": "WILDFIRE"},
                    headers=_h(admin_token))
    assert p.status_code == 201, p.text
    pid = p.json()["id"]
    v = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/versions",
                    json={"schema_json": schema}, headers=_h(admin_token))
    assert v.status_code == 201, v.text
    pub = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/publish",
                      json={"version": 1}, headers=_h(admin_token))
    assert pub.status_code == 200, pub.text
    assert pub.json()["active_version"] == 1
    return pid


def _make_event(client, admin_token, pid, **over):
    body = {"name": "Forest Fire — Bandipur", "crisis_type": "WILDFIRE",
            "center_lat": CENTER[0], "center_lng": CENTER[1], "radius_km": 30.0,
            "is_active": True, "form_pack_id": pid}
    body.update(over)
    r = client.post("/api/v1/admin/crisis-forms/events", json=body, headers=_h(admin_token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_invalid_schema_rejected_on_version_create(client, admin_token):
    p = client.post("/api/v1/admin/crisis-forms/packs",
                    json={"key": "bad-pack", "title": "Bad"}, headers=_h(admin_token))
    pid = p.json()["id"]
    bad = {"key": "bad-pack", "title": "Bad", "sections": [
        {"id": "s", "fields": [{"key": "x", "type": "rating_stars", "label": "x"}]}]}
    r = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/versions",
                    json={"schema_json": bad}, headers=_h(admin_token))
    assert r.status_code == 400
    assert "schema_errors" in str(r.json())


def test_lint_endpoint(client, admin_token):
    r = client.post("/api/v1/admin/crisis-forms/packs/validate",
                    json={"schema_json": VALID_SCHEMA}, headers=_h(admin_token))
    assert r.status_code == 200 and r.json()["valid"] is True and r.json()["errors"] == []


# Each geo test uses its OWN center (>1° apart, far beyond the 30 km radius) so
# rows persisted by sibling tests in the shared session DB can't cross-match.
def test_active_inside_zone_returns_pack(client, admin_token):
    c = (10.0, 70.0)
    pid = _publish_pack(client, admin_token, key="wf-inside")
    _make_event(client, admin_token, pid, center_lat=c[0], center_lng=c[1])
    r = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}")
    assert r.status_code == 200
    body = r.json()
    assert body["active"] is True
    assert body["pack_version"] == 1
    assert body["schema_json"]["sections"][0]["fields"][0]["key"] == "flames_visible"
    assert "max-age" in r.headers.get("cache-control", "")  # public endpoint is cacheable


def test_active_outside_zone_is_inactive(client, admin_token):
    pid = _publish_pack(client, admin_token, key="wf-outside")
    _make_event(client, admin_token, pid, center_lat=15.0, center_lng=75.0)
    r = client.get("/api/v1/crisis-forms/active?lat=-40&lng=-40")  # far from every test's zone
    assert r.status_code == 200 and r.json()["active"] is False


def test_active_expired_window_is_inactive(client, admin_token):
    c = (20.0, 50.0)  # unique center, only this (expired) event covers it
    pid = _publish_pack(client, admin_token, key="wf-expired")
    _make_event(client, admin_token, pid, center_lat=c[0], center_lng=c[1],
                started_at="2020-01-01T00:00:00+00:00", ended_at="2020-02-01T00:00:00+00:00")
    r = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}")
    assert r.status_code == 200 and r.json()["active"] is False  # expired → not matched


def test_active_etag_304(client, admin_token):
    c = (30.0, 60.0)
    pid = _publish_pack(client, admin_token, key="wf-etag")
    _make_event(client, admin_token, pid, center_lat=c[0], center_lng=c[1])
    r1 = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}")
    etag = r1.headers.get("etag")
    assert etag
    r2 = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}",
                    headers={"If-None-Match": etag})
    assert r2.status_code == 304


def test_ended_event_not_matched_then_relaunched(client, admin_token):
    # Two-state model (redesign v2): is_active is a strict function of status,
    # so "not matching" means status=ENDED and "matching" means status=LIVE.
    # The server ignores any client-supplied is_active and derives it from status.
    c = (40.0, 65.0)  # unique center, only this event covers it
    pid = _publish_pack(client, admin_token, key="wf-toggle")
    eid = _make_event(client, admin_token, pid, center_lat=c[0], center_lng=c[1], status="ENDED")
    r = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}")
    assert r.json()["active"] is False  # ENDED event → inactive → not matched inside the circle
    client.patch(f"/api/v1/admin/crisis-forms/events/{eid}",
                 json={"status": "LIVE"}, headers=_h(admin_token))  # re-launch
    r2 = client.get(f"/api/v1/crisis-forms/active?lat={c[0]}&lng={c[1]}")
    assert r2.json()["active"] is True  # back to LIVE → now matched


def test_rollback_repoints_active_version(client, admin_token):
    pid = _publish_pack(client, admin_token, key="wf-rollback")
    # publish a v2
    v2 = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/versions",
                     json={"schema_json": dict(VALID_SCHEMA, key="wf-rollback", title="v2")},
                     headers=_h(admin_token))
    assert v2.status_code == 201 and v2.json()["version"] == 2
    client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/publish",
                json={"version": 2}, headers=_h(admin_token))
    rb = client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/rollback",
                     json={"version": 1}, headers=_h(admin_token))
    assert rb.status_code == 200 and rb.json()["active_version"] == 1
