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


def test_pack_archive_blocked_while_live_operation_uses_it(client, admin_token):
    """Stream D guardrail: a form pack bound to a LIVE operation cannot be archived —
    the operator must end/reassign the operation first. Archiving succeeds once no live
    operation references the pack."""
    pid = _publish_pack(client, admin_token, key="guard-pack")
    eid = _make_event(client, admin_token, pid)
    # Archiving while a LIVE op uses it → 409 with the blocking operation named.
    r = client.patch(f"/api/v1/admin/crisis-forms/packs/{pid}",
                     json={"is_archived": True}, headers=_h(admin_token))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "pack_in_use"
    assert any(o["id"] == eid for o in detail["operations"])
    # End the operation, then archiving the now-unused pack succeeds.
    end = client.patch(f"/api/v1/admin/crisis-forms/events/{eid}",
                       json={"status": "ENDED"}, headers=_h(admin_token))
    assert end.status_code == 200, end.text
    ok = client.patch(f"/api/v1/admin/crisis-forms/packs/{pid}",
                      json={"is_archived": True}, headers=_h(admin_token))
    assert ok.status_code == 200, ok.text


# ── M7 (Phase-2): a LIVE operation must have a form pack bound ────────────────
def test_live_event_without_pack_rejected(client, admin_token):
    """A LIVE op with no form pack is skipped by resolve_active_event, so reports
    in its circle stay GLOBAL. The API must reject activating a pack-less op."""
    body = {"name": "Packless Op", "crisis_type": "WILDFIRE",
            "center_lat": CENTER[0], "center_lng": CENTER[1], "radius_km": 30.0,
            "is_active": True}   # status defaults LIVE; NO form_pack_id
    r = client.post("/api/v1/admin/crisis-forms/events", json=body, headers=_h(admin_token))
    assert r.status_code == 400, r.text
    assert "pack" in r.text.lower()


def test_draft_event_without_pack_ok_but_activation_blocked(client, admin_token):
    # A non-LIVE (ENDED/draft) event with no pack is allowed...
    body = {"name": "Draft Op", "crisis_type": "WILDFIRE",
            "center_lat": CENTER[0], "center_lng": CENTER[1], "radius_km": 30.0,
            "status": "ENDED"}
    r = client.post("/api/v1/admin/crisis-forms/events", json=body, headers=_h(admin_token))
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    # ...but flipping it LIVE without binding a pack is rejected.
    r2 = client.patch(f"/api/v1/admin/crisis-forms/events/{eid}",
                      json={"status": "LIVE"}, headers=_h(admin_token))
    assert r2.status_code == 400, r2.text
    assert "pack" in r2.text.lower()


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


# ── Operations redesign v2 — atomic launch-with-form (wizard publish) ──────────
def _wizard_schema():
    """A valid schema_json as the Start-New-Operation wizard's buildSchema emits it
    (the server fills key/title)."""
    return {"schema_version": 1, "sections": [
        {"id": "classify", "stage": 2, "title": "Assessment", "fields": [
            {"key": "crisis_type", "type": "single_select", "label": "What caused it?",
             "required": True, "maps_to": "crisis_type", "options": [{"value": "FLOOD", "label": "Flood"}]},
            {"key": "water_rising", "type": "yes_no", "label": "Is the water still rising?", "required": False}]}]}


def test_launch_with_form_creates_live_op_and_published_pack(client, admin_token):
    r = client.post("/api/v1/operations/launch-with-form", headers=_h(admin_token), json={
        "name": "Atomic Launch Op", "crisis_type": "FLOOD",
        "center_lat": 19.0, "center_lng": 72.8, "radius_km": 15,
        "form_title": "Atomic test form", "schema_json": _wizard_schema(), "from_cluster": False})
    assert r.status_code == 201, r.text
    op_id = r.json()["operation_id"]
    try:
        # The operation is LIVE + active (so it matches reporters).
        ops = client.get("/api/v1/operations", headers=_h(admin_token)).json()
        op = next(o for o in ops if o.get("id") == op_id)
        assert op["status"] == "LIVE" and op["is_active"] is True
        # A pack was created AND published in the same call.
        packs = client.get("/api/v1/admin/crisis-forms/packs", headers=_h(admin_token)).json()
        pk = next(p for p in packs if p["title"] == "Atomic test form")
        assert pk["active_version"] == 1
    finally:
        client.delete(f"/api/v1/admin/crisis-forms/events/{op_id}", headers=_h(admin_token))


def test_launch_with_form_bad_schema_persists_nothing(client, admin_token):
    """No-draft-persistence: a rejected publish must leave ZERO pack/version/event
    rows — the whole thing is one transaction."""
    packs_before = len(client.get("/api/v1/admin/crisis-forms/packs", headers=_h(admin_token)).json())
    ops_before = len(client.get("/api/v1/operations", headers=_h(admin_token)).json())
    # single_select with no options → the schema linter rejects it.
    bad = {"schema_version": 1, "sections": [{"id": "classify", "stage": 2, "title": "x", "fields": [
        {"key": "q", "type": "single_select", "label": "Q?", "required": False}]}]}
    r = client.post("/api/v1/operations/launch-with-form", headers=_h(admin_token), json={
        "name": "Should Not Persist", "center_lat": 1.0, "center_lng": 1.0, "radius_km": 10,
        "schema_json": bad, "from_cluster": False})
    assert r.status_code == 400, r.text
    assert len(client.get("/api/v1/admin/crisis-forms/packs", headers=_h(admin_token)).json()) == packs_before
    assert len(client.get("/api/v1/operations", headers=_h(admin_token)).json()) == ops_before


def test_form_templates_returns_published_with_schema(client, admin_token):
    _publish_pack(client, admin_token, key="tpl-listed")
    tpls = client.get("/api/v1/operations/form-templates", headers=_h(admin_token)).json()
    row = next((t for t in tpls if t["key"] == "tpl-listed"), None)
    assert row is not None, "published pack missing from /operations/form-templates"
    assert row.get("schema_json"), "template must carry its active published schema"
