"""End-to-end ingestion tests for Dynamic Crisis Forms on /reports/meta.
Proves: (1) the default no-crisis path is unchanged (parity), (2) crisis answers
validate + route to canonical columns + form_data, (3) invalid answers → 422 with
NO orphan row, (4) an unknown pack is fail-safe (stored as a standard report),
(5) crisis_event_id is DERIVED server-side (verify client echo, else re-resolve
from location), never blind-trusted — incl. the shared-pack regression."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.report import Report, CrisisEvent

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


# ── crisis_event_id server-side derivation (Operations Phase 1) ─────────────

ZONE_A = (12.97, 77.59)   # Bengaluru
ZONE_B = (50.00, 8.00)    # Frankfurt — far enough that A's point is outside B's circle


@pytest.fixture
def make_event(db):
    """Factory for active CrisisEvents that auto-cleans afterwards. Leftover
    ACTIVE events would pollute /active + intake for unrelated tests, so each
    created event is deleted on teardown (ondelete=SET NULL nulls any report
    that referenced it — leaving inert standalone reports, no FK violation)."""
    created = []

    def _factory(pack_id, lat, lng, radius=30.0, age_minutes=0):
        now = datetime.now(timezone.utc)
        ev = CrisisEvent(
            name="evt-" + uuid.uuid4().hex[:8], crisis_type="WILDFIRE",
            status="LIVE", is_active=True, form_pack_id=pack_id,
            center_lat=lat, center_lng=lng, radius_km=radius,
            started_at=now - timedelta(days=1),
            # explicit created_at controls the newest-first match order
            created_at=now - timedelta(minutes=age_minutes),
        )
        db.add(ev); db.commit(); db.refresh(ev)
        created.append(ev.id)
        return ev

    yield _factory
    for eid in created:
        db.query(CrisisEvent).filter(CrisisEvent.id == eid).delete()
    db.commit()


def _crisis_body(pid, lat, lng, **over):
    body = _meta(form_pack_id=pid, form_pack_version=1,
                 form_data={"flames_visible": True},
                 location={"latitude": lat, "longitude": lng})
    body.update(over)
    return body


def test_event_id_derived_from_verified_client_echo(client, db, admin_token, make_event):
    """Client echoes the event_id it got from /active; the server verifies that
    event actually owns the answered pack, then stamps it."""
    pid = _publish_pack(client, admin_token)
    ev = make_event(pid, *ZONE_A)
    body = _crisis_body(pid, *ZONE_A, crisis_event_id=ev.id)
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id == ev.id


def test_mismatched_client_event_is_ignored_then_rederived_from_location(
        client, db, admin_token, make_event):
    """A client-sent event_id that does NOT own the answered pack is discarded;
    the server re-resolves from the submitted location to the event that does."""
    pid_a = _publish_pack(client, admin_token)   # the answered pack
    pid_b = _publish_pack(client, admin_token)   # an unrelated pack
    ev_a = make_event(pid_a, *ZONE_A)             # owns pid_a, contains the report
    ev_b = make_event(pid_b, *ZONE_B)            # owns pid_b, far away
    # Client lies: answers pid_a but echoes ev_b (which owns pid_b).
    body = _crisis_body(pid_a, *ZONE_A, crisis_event_id=ev_b.id)
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id == ev_a.id, \
        "mismatched echo must be ignored and re-derived from location"


def test_shared_pack_stamps_local_event_not_newest(client, db, admin_token, make_event):
    """THE shared-pack regression: two events reuse ONE pack (allowed — no
    uniqueness on CrisisEvent.form_pack_id). A report physically inside zone A
    must be stamped with A, NOT the newest event (B), even though B also owns
    the pack. Proves location wins over recency — the bug 'derive from
    form_pack_id alone' would have produced."""
    pid = _publish_pack(client, admin_token)
    ev_a = make_event(pid, *ZONE_A, radius=10.0, age_minutes=120)   # older
    ev_b = make_event(pid, *ZONE_B, radius=10.0, age_minutes=60)    # newer (matched first)
    # Report in zone A, no client event_id (e.g. a GPS chat channel).
    body = _crisis_body(pid, *ZONE_A)
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id == ev_a.id, \
        "must stamp the event whose zone contains the report, not the newest"
    assert row.crisis_event_id != ev_b.id


def test_validated_form_with_no_active_owner_is_null(client, db, admin_token, make_event):
    """A valid pack submission with NO active event owning it (anywhere near the
    report) degrades to a standard report: form fields kept, crisis_event_id NULL."""
    pid = _publish_pack(client, admin_token)
    make_event(pid, *ZONE_B)   # owner exists but is FAR from the report
    body = _crisis_body(pid, *ZONE_A)   # report in zone A — outside the owner's circle
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id is None
    assert row.form_pack_id == pid and row.form_pack_version == 1   # form still linked


def test_chat_channel_links_to_operation_without_form_pack(
        client, db, admin_token, make_event):
    """GPS chat channels (Telegram/WhatsApp) echo the event id from /active but
    send NO form_pack_id — they don't render the dynamic Stage 2/3 pack. The
    server links the report to its operation by RE-DERIVING from the submitted
    location: no form validation runs, no pack is attached."""
    pid = _publish_pack(client, admin_token)
    ev = make_event(pid, *ZONE_A)
    body = _meta(crisis_event_id=ev.id,
                 location={"latitude": ZONE_A[0], "longitude": ZONE_A[1]})
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id == ev.id
    assert row.form_pack_id is None and row.form_data is None   # no pack attached


def test_location_in_zone_without_event_hint_stays_global(
        client, db, admin_token, make_event):
    """SMS/IVR parity at the API: a report located inside an active zone but
    with NO event-id hint and NO pack (the non-GPS channel shape) is NOT
    auto-linked. Linkage requires the explicit opt-in hint, so coarse-geocoded
    channels stay GLOBAL — no fake-matching."""
    pid = _publish_pack(client, admin_token)
    make_event(pid, *ZONE_A)   # an active zone DOES cover the point …
    body = _meta(location={"latitude": ZONE_A[0], "longitude": ZONE_A[1]})  # … but no hint
    r = client.post("/api/v1/reports/meta", json=body)
    assert r.status_code in (200, 201), r.text
    row = db.query(Report).filter(Report.client_report_id == body["client_report_id"]).first()
    assert row.crisis_event_id is None
