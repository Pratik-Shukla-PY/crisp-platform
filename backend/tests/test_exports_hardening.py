"""
Export hardening + capability tests — Jun 2026 export audit.

Covers the P0 fixes (RFC-4180 CSV quoting, formula-injection guard, loud 422
on bad date filters, satellite columns in Shapefile DBF + KML ExtendedData,
visible PDF truncation) and the P2 additions (HXL row, count, data
dictionary, recent-exports audit trail, analytics summary CSV, sitrep PDF,
evidence bundle ZIP, appended metadata columns).
"""
import csv
import io
import json
import time
import zipfile

import pytest

from tests.conftest import auth_header


def _seed(client, token, **overrides):
    payload = {
        "device_hash": f"EXP-HARD-{time.time_ns()}",
        "client_report_id": f"exp-hard-{time.time_ns()}",
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "description": 'flooded, "north" bank — =SUM(A1) risk & <test>',
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59, "accuracy_meters": 12.5},
    }
    payload.update(overrides)
    res = client.post("/api/v1/reports/meta", json=payload)
    assert res.status_code == 201, res.text
    return res.json()["id"]


class TestCsvHardening:
    def test_embedded_quotes_and_commas_survive_roundtrip(self, client, viewer_token):
        rid = _seed(client, viewer_token)
        res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        assert res.status_code == 200
        rows = list(csv.DictReader(io.StringIO(res.text)))
        row = next((r for r in rows if r["id"] == rid), None)
        assert row is not None
        # The old hand-rolled writer corrupted rows on embedded quotes and
        # mangled commas to ';'. Both must survive the csv-module writer.
        assert '"north"' in row["description"]
        assert "," in row["description"]

    def test_formula_injection_guarded_but_negatives_numeric(self, client, viewer_token):
        rid = _seed(client, viewer_token,
                    description="=HYPERLINK(evil)",
                    location={"latitude": -12.5, "longitude": -77.1})
        res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        rows = list(csv.DictReader(io.StringIO(res.text)))
        row = next((r for r in rows if r["id"] == rid), None)
        assert row is not None
        assert row["description"].startswith("'="), "formula must be quote-prefixed"
        assert row["latitude"] == "-12.5", "negative coordinates must stay numeric"

    def test_hxl_row_present_by_default_and_omittable(self, client, viewer_token):
        _seed(client, viewer_token)
        res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        lines = res.text.splitlines()
        assert "#geo+lat" in lines[1] and "#date+reported" in lines[1], \
            "HXL hashtag row expected on row 2"
        res2 = client.get("/api/v1/exports/csv?hxl=false", headers=auth_header(viewer_token))
        assert "#geo+lat" not in res2.text.splitlines()[1]

    def test_new_metadata_columns_present(self, client, viewer_token):
        rid = _seed(client, viewer_token)
        res = client.get("/api/v1/exports/csv?hxl=false", headers=auth_header(viewer_token))
        rows = list(csv.DictReader(io.StringIO(res.text)))
        row = next((r for r in rows if r["id"] == rid), None)
        assert row is not None
        for col in ("accuracy_m", "location_source", "client_created_at",
                    "reviewer_verdict", "media_count", "first_photo_url",
                    "crisis_event_id", "detected_language"):
            assert col in row, f"missing appended column {col}"
        assert row["accuracy_m"] == "12.5"
        assert row["location_source"] == "device_gps"
        assert row["media_count"] == "0"

    def test_bad_since_is_422_not_silent(self, client, viewer_token):
        res = client.get("/api/v1/exports/csv?since=not-a-date",
                         headers=auth_header(viewer_token))
        assert res.status_code == 422
        assert "since" in res.json()["detail"]


class TestFormatParity:
    def test_shapefile_dbf_has_satellite_fields(self, client, viewer_token):
        _seed(client, viewer_token)
        res = client.get("/api/v1/exports/shapefile", headers=auth_header(viewer_token))
        assert res.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(res.content))
        dbf = zf.read("crisp_reports.dbf")
        # DBF stores field names in the header as fixed 11-byte records.
        for field in (b"SAT_VERD", b"SAT_SCORE", b"SAT_ACQ", b"SAT_GAP",
                      b"SAT_CLOUD", b"SAT_SRC"):
            assert field in dbf, f"Shapefile DBF missing {field} (must-have #11)"

    def test_kml_extendeddata_has_satellite_fields(self, client, viewer_token):
        _seed(client, viewer_token)
        res = client.get("/api/v1/exports/kml", headers=auth_header(viewer_token))
        assert res.status_code == 200
        for name in ("satellite_verdict", "satellite_total_score", "satellite_source"):
            assert name in res.text, f"KML ExtendedData missing {name} (must-have #11)"

    def test_geojson_metadata_member(self, client, viewer_token):
        _seed(client, viewer_token)
        res = client.get("/api/v1/exports/geojson", headers=auth_header(viewer_token))
        data = res.json()
        assert "metadata" in data
        assert data["metadata"]["feature_count"] == len(data["features"])
        assert "dropped_no_location" in data["metadata"]


class TestSupportEndpoints:
    def test_count_matches_filters(self, client, viewer_token):
        _seed(client, viewer_token, crisis_type="EARTHQUAKE")
        res = client.get("/api/v1/exports/count?crisis_type=EARTHQUAKE",
                         headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert res.json()["count"] >= 1
        assert res.json()["filters"] == {"crisis_type": "EARTHQUAKE"}

    def test_export_writes_audit_row_and_recent_lists_it(self, client, viewer_token):
        _seed(client, viewer_token)
        client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        res = client.get("/api/v1/exports/recent", headers=auth_header(viewer_token))
        assert res.status_code == 200
        rows = res.json()
        assert rows, "expected at least one EXPORT audit row"
        assert rows[0]["format"] in ("csv", "geojson", "shapefile", "kml", "pdf",
                                     "analytics-summary", "sitrep", "evidence-bundle")
        assert rows[0]["row_count"] is not None

    def test_data_dictionary_covers_every_column(self, client, viewer_token):
        res = client.get("/api/v1/exports/data-dictionary",
                         headers=auth_header(viewer_token))
        assert res.status_code == 200
        rows = list(csv.DictReader(io.StringIO(res.text)))
        cols = {r["column"] for r in rows}
        csv_res = client.get("/api/v1/exports/csv?hxl=false", headers=auth_header(viewer_token))
        header = csv_res.text.splitlines()[0].split(",")
        missing = [h for h in header if h not in cols]
        assert not missing, f"data dictionary missing: {missing}"
        assert all(r["description"] for r in rows), "every column needs a description"

    def test_analytics_summary_csv(self, client, viewer_token):
        res = client.get("/api/v1/exports/analytics-summary",
                         headers=auth_header(viewer_token))
        assert res.status_code == 200
        rows = list(csv.DictReader(io.StringIO(res.text)))
        sections = {r["section"] for r in rows}
        assert "counts" in sections and "meta" in sections

    def test_sitrep_pdf(self, client, viewer_token):
        res = client.get("/api/v1/exports/sitrep", headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert res.content[:4] == b"%PDF"

    def test_evidence_bundle_zip(self, client, viewer_token):
        rid = _seed(client, viewer_token)
        res = client.get(f"/api/v1/exports/evidence-bundle/{rid}",
                         headers=auth_header(viewer_token))
        assert res.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(res.content))
        names = zf.namelist()
        assert "evidence.json" in names and "README.txt" in names
        ev = json.loads(zf.read("evidence.json"))
        assert ev["report_id"] == rid

    def test_evidence_bundle_404_on_unknown(self, client, viewer_token):
        res = client.get("/api/v1/exports/evidence-bundle/nope",
                         headers=auth_header(viewer_token))
        assert res.status_code == 404
