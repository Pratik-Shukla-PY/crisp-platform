"""End-to-end ingestion tests for Dynamic Crisis Forms on /reports/meta.
Proves: (1) the default no-crisis path is unchanged (parity), (2) crisis answers
validate + route to canonical columns + form_data, (3) invalid answers → 422 with
NO orphan row, (4) an unknown pack is fail-safe (stored as a standard report)."""
import uuid

from app.models.report import Report

SCHEMA = {
    "key": "wf-submit",
    "title": "Forest Fire",
    "sections": [{"id": "classify", "stage": 2, "fields": [
        {"key": "flames_visible", "type": "yes_no", "label": "Flames?", "required": True},
        {"key": "damage_classification", "type": "single_select", "label": "Damage?",
         "maps_to": "damage_classification",
         "options": [{"value": "MINIMAL", "label": "Min"}, {"value": "COMPLETE", "label": "Comp"}]},
    ]}],
}


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _publish_pack(client, admin_token, key=None):
    # Unique key per call — rows persist across the session (no per-test rollback),
    # so a reused key would 409.
    key = key or ("wf-submit-" + uuid.uuid4().hex[:8])
    p = client.post("/api/v1/admin/crisis-forms/packs",
                    json={"key": key, "title": "Forest Fire"}, headers=_h(admin_token))
    assert p.status_code == 201, p.text
    pid = p.json()["id"]
    client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/versions",
                json={"schema_json": SCHEMA}, headers=_h(admin_token))
    client.post(f"/api/v1/admin/crisis-forms/packs/{pid}/publish",
                json={"version": 1}, headers=_h(admin_token))
    return pid


def _meta(**over):
    # infrastructure_type must be concrete (not the OTHER default) or the existing
    # UNDP taxonomy validator requires infrastructure_name — unrelated to crisis forms.
    body = {"device_hash": "dh-" + uuid.uuid4().hex[:12],
            "client_report_id": str(uuid.uuid4()),
            "source": "APP", "expected_media": 0,
            "infrastructure_type": "RESIDENTIAL"}
    body.update(over)
    return body


def test_default_submission_has_no_crisis_fields(client, db):
    """A normal report (no crisis pack) is stored exactly as before — parity #1."""
    body = _meta(crisis_type="FLOOD", damage_classification="PARTIAL")
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row is not None
    assert row.form_pack_id is None and row.form_data is None and row.crisis_event_id is None
    assert row.damage_classification == "PARTIAL"   # unchanged


def test_crisis_submission_validates_and_routes(client, db, admin_token):
    pid = _publish_pack(client, admin_token)
    body = _meta(form_pack_id=pid, form_pack_version=1,
                 form_data={"flames_visible": True, "damage_classification": "COMPLETE"})
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.form_pack_id == pid and row.form_pack_version == 1
    assert row.form_data == {"flames_visible": True}          # maps_to value pulled OUT of form_data
    assert row.damage_classification == "COMPLETE"            # routed to the canonical column


def test_crisis_submission_invalid_returns_422_no_row(client, db, admin_token):
    pid = _publish_pack(client, admin_token)
    crid = str(uuid.uuid4())
    body = _meta(form_pack_id=pid, form_pack_version=1, form_data={})  # missing required flames_visible
    body["client_report_id"] = crid
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code == 422
    assert "crisis_form_errors" in str(r.json())
    assert db.query(Report).filter(Report.client_report_id == crid).first() is None  # no orphan


def test_unknown_pack_is_failsafe(client, db):
    """A form_pack_id that doesn't resolve must NOT crash — store as a standard report."""
    body = _meta(form_pack_id="does-not-exist", form_data={"x": 1})
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row is not None and row.form_pack_id is None and row.form_data is None


def test_enum_guard_blocks_tampered_mapped_value(client, db, admin_token):
    """A tampered mapped value that isn't a canonical enum is rejected (422)."""
    pid = _publish_pack(client, admin_token)
    crid = str(uuid.uuid4())
    body = _meta(form_pack_id=pid, form_pack_version=1,
                 form_data={"flames_visible": True, "damage_classification": "WRECKED"})
    body["client_report_id"] = crid
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code == 422
    assert db.query(Report).filter(Report.client_report_id == crid).first() is None
