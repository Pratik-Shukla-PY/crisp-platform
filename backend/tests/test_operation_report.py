"""Operation Summary PDF — multi-section report (one operation = one CrisisEvent).

Service generates a valid multi-section PDF; the endpoint is viewer-gated, returns
application/pdf for an existing operation, and 404 for a missing one.
"""
from app.models.report import CrisisEvent


def _mk_op(db, admin_user, **kw):
    ev = CrisisEvent(name=kw.get("name", "Test Flood Op"),
                     crisis_type=kw.get("crisis_type", "FLOOD"),
                     status="LIVE", is_active=True,
                     center_lat=12.97, center_lng=77.59, radius_km=30,
                     place_name="Test Region", created_by=admin_user.id)
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


def test_service_generates_a_valid_multi_section_pdf(db, admin_user):
    from app.services.operation_report import build_operation_report_pdf
    ev = _mk_op(db, admin_user)
    pdf = build_operation_report_pdf(db, ev)
    assert isinstance(pdf, (bytes, bytearray))
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 1500   # multi-section → non-trivial size even when empty


def test_endpoint_returns_pdf_for_viewer(client, db, admin_user, viewer_token):
    ev = _mk_op(db, admin_user, name="Endpoint Op", crisis_type="EARTHQUAKE")
    r = client.get(f"/api/v1/operations/{ev.id}/report.pdf",
                   headers={"Authorization": f"Bearer {viewer_token}"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    assert "attachment" in r.headers.get("content-disposition", "")


def test_endpoint_404_for_missing_operation(client, viewer_token):
    r = client.get("/api/v1/operations/does-not-exist/report.pdf",
                   headers={"Authorization": f"Bearer {viewer_token}"})
    assert r.status_code == 404
