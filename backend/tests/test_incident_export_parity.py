"""Building-centric Incident-Feed redesign Phase 2F — incident_id in serializer + exports.

Verifies the incident layer is observable end-to-end:
  - the report API response (ReportResponse) carries incident_id;
  - the CSV export carries the incident_id column + value;
  - a no-GPS report (SMS/IVR-style, no location/building) STILL gets an incident
    at intake (must-have #1 multi-channel parity — every channel's report lands
    on an incident, even without a building).
"""
from __future__ import annotations

import uuid

from tests.conftest import auth_header


def _post_meta(client, *, with_location=True):
    body = {
        "device_hash": f"DEV-2F-{uuid.uuid4().hex[:8]}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "SEVERE",
        "infrastructure_type": "HOSPITAL",
        "crisis_type": "EARTHQUAKE",
        "damage_classification": "PARTIAL",
        "description": "incident export parity",
        "expected_media": 0,
    }
    if with_location:
        body["location"] = {"latitude": 41.0082, "longitude": 28.9784}  # Istanbul (unique-ish)
    res = client.post("/api/v1/reports/meta", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def test_report_response_and_csv_carry_incident_id(client, admin_token):
    rep = _post_meta(client, with_location=True)
    # The ReportResponse (the meta response itself) surfaces the incident link.
    assert rep.get("incident_id"), "report response must include the assigned incident_id"
    inc_id = rep["incident_id"]

    csv = client.get("/api/v1/exports/csv", headers=auth_header(admin_token))
    assert csv.status_code == 200, csv.text
    text = csv.text
    header = text.splitlines()[0]
    assert "incident_id" in header, "CSV export must include the incident_id column"
    assert inc_id in text, "the report's incident_id must appear in the CSV"


def test_no_location_report_still_gets_incident(client):
    """SMS/IVR-style report (no GPS → no building) must still be assigned an
    incident at intake — multi-channel parity."""
    rep = _post_meta(client, with_location=False)
    assert rep.get("incident_id"), "a no-location report must still get an incident_id"
