"""Exports must NOT leak analyst-rejected reports (data-integrity + must-have #11).

A rejected report keeps status=PENDING (rejection is verdict-based: reviewer_verdict
=REJECTED). The live feed hides it; the shared GIS exports must hide it too. An admin
audit view can still pull them with an explicit ?reviewer_verdict=REJECTED.
"""
import csv
import io
from tests.conftest import auth_header


def _seed(client, *, cid, building_id=None):
    body = {
        "device_hash": f"DH-{cid}",
        "client_report_id": cid,
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    }
    if building_id:
        body["building_id"] = building_id
    res = client.post("/api/v1/reports/meta", json=body)
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _csv_ids(text):
    rows = list(csv.DictReader(io.StringIO(text)))
    # HXL hashtag row (starts with '#') is not a data row.
    return {r["id"] for r in rows if r.get("id") and not r["id"].startswith("#")}


def test_default_export_excludes_rejected(client, viewer_token, analyst_token):
    keep = _seed(client, cid="exp-keep-1")
    rej = _seed(client, cid="exp-rej-1")
    # Reject one report (verdict-based; status stays PENDING).
    r = client.patch(f"/api/v1/reports/{rej}/review", headers=auth_header(analyst_token),
                     json={"verdict": "REJECTED", "action_taken": "duplicate"})
    assert r.status_code == 200, r.text

    res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
    assert res.status_code == 200
    ids = _csv_ids(res.text)
    assert keep in ids
    assert rej not in ids, "rejected report leaked into the default CSV export"

    # GeoJSON parity.
    gj = client.get("/api/v1/exports/geojson", headers=auth_header(viewer_token))
    gids = {f["properties"]["id"] for f in gj.json()["features"]}
    assert keep in gids and rej not in gids


def test_explicit_verdict_param_includes_rejected(client, viewer_token, analyst_token):
    rej = _seed(client, cid="exp-rej-2")
    client.patch(f"/api/v1/reports/{rej}/review", headers=auth_header(analyst_token),
                 json={"verdict": "REJECTED", "action_taken": "spam"})
    res = client.get("/api/v1/exports/csv?reviewer_verdict=REJECTED",
                     headers=auth_header(viewer_token))
    assert res.status_code == 200
    assert rej in _csv_ids(res.text), "explicit verdict=REJECTED audit export should include rejected"


def test_single_report_export_includes_rejected(client, viewer_token, analyst_token):
    """Regression: an explicit by-id export (report_id=...) is a deliberate pull of the
    one report the operator is viewing - even when REJECTED. The default REJECTED
    exclusion is for unscoped/bulk datasets; a by-id pull must not silently return an
    empty file. (The bulk export still excludes it - see test_default_export_excludes_rejected.)"""
    rej = _seed(client, cid="exp-rej-byid")
    r = client.patch(f"/api/v1/reports/{rej}/review", headers=auth_header(analyst_token),
                     json={"verdict": "REJECTED", "action_taken": "duplicate"})
    assert r.status_code == 200, r.text
    # Bulk export hides it ...
    bulk = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
    assert rej not in _csv_ids(bulk.text)
    # ... but the explicit single-report export returns it (CSV + GeoJSON).
    one = client.get(f"/api/v1/exports/csv?report_id={rej}", headers=auth_header(viewer_token))
    assert one.status_code == 200
    assert rej in _csv_ids(one.text), "by-id export of a rejected report must not be empty"
    gj = client.get(f"/api/v1/exports/geojson?report_id={rej}", headers=auth_header(viewer_token))
    gids = {f["properties"]["id"] for f in gj.json()["features"]}
    assert rej in gids


def test_building_id_scopes_export(client, viewer_token):
    a = _seed(client, cid="exp-bld-a", building_id="osm:way:111")
    b = _seed(client, cid="exp-bld-b", building_id="osm:way:222")
    res = client.get("/api/v1/exports/csv?building_id=osm:way:111",
                     headers=auth_header(viewer_token))
    assert res.status_code == 200
    ids = _csv_ids(res.text)
    assert a in ids and b not in ids
