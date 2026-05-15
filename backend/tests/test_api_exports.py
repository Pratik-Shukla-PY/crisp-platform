"""API tests for data export endpoints."""
import json
import zipfile
import io
import pytest
from tests.conftest import auth_header


def _seed_v4_report(client, *, device_hash, cid, service_status):
    """Helper — POST /reports/meta with V4 service_status and return id."""
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": cid,
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "crisis_type": "EARTHQUAKE",
        "damage_classification": "PARTIAL",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
        "service_status": service_status,
        "debris_clearing_needed": True,
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


class TestExports:
    def test_csv_requires_auth(self, client):
        res = client.get("/api/v1/exports/csv")
        assert res.status_code == 401

    def test_csv_export(self, client, viewer_token, sample_report):
        res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        assert res.status_code == 200
        lines = res.text.strip().split("\n")
        assert len(lines) >= 2  # Header + at least 1 data row
        headers = lines[0]
        assert "crisis_type" in headers
        assert "damage_classification" in headers
        assert "building_id" in headers

    def test_geojson_export(self, client, viewer_token, sample_report):
        res = client.get("/api/v1/exports/geojson", headers=auth_header(viewer_token))
        assert res.status_code == 200
        data = res.json()
        assert data["type"] == "FeatureCollection"
        assert len(data["features"]) >= 1
        props = data["features"][0]["properties"]
        assert "crisis_type" in props
        assert "infrastructure_name" in props

    def test_shapefile_export(self, client, viewer_token, sample_report):
        res = client.get("/api/v1/exports/shapefile", headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert "application/zip" in res.headers.get("content-type", "")
        z = zipfile.ZipFile(io.BytesIO(res.content))
        names = z.namelist()
        assert any(n.endswith(".shp") for n in names)
        assert any(n.endswith(".dbf") for n in names)
        assert any(n.endswith(".prj") for n in names)

    def test_kml_export(self, client, viewer_token, sample_report):
        res = client.get("/api/v1/exports/kml", headers=auth_header(viewer_token))
        assert res.status_code == 200
        assert "kml" in res.text[:200].lower()

    def test_pdf_export(self, client, viewer_token, sample_report):
        res = client.get("/api/v1/exports/pdf", headers=auth_header(viewer_token))
        assert res.status_code == 200
        # Content-type is application/pdf
        assert "pdf" in res.headers.get("content-type", "").lower()
        # PDF files start with the magic %PDF- marker
        assert res.content[:5] == b"%PDF-", \
            f"response body is not a PDF: starts with {res.content[:10]!r}"
        # Dossier should be non-trivially sized — at least a few KB for a
        # single report with the UNDP header.
        assert len(res.content) > 1000

    def test_pdf_export_requires_auth(self, client):
        res = client.get("/api/v1/exports/pdf")
        assert res.status_code == 401

    def test_pdf_export_empty_result(self, client, viewer_token):
        """No matching reports should still return a valid PDF, not a 500."""
        res = client.get(
            "/api/v1/exports/pdf?crisis_type=TSUNAMI",
            headers=auth_header(viewer_token),
        )
        assert res.status_code == 200
        assert res.content[:5] == b"%PDF-"


class TestV4FieldParity:
    """Phase 2.1 (May 2026) — UNDP analyst-friendly flat V4 columns.

    The dashboard surfaces ``service_status`` as separate badges per
    signal (power / water / health / pressing_needs). Exports MUST
    keep parity so a humanitarian-needs-assessment workflow in
    Excel / QGIS / R can rely on the same field names.

    UNDP must-have #11 (export columns) hinges on this. If a single
    format drops a V4 column, downstream analytics get holes.
    """

    @pytest.fixture
    def v4_report_id(self, client):
        return _seed_v4_report(
            client,
            device_hash="DEVICE-EXPORT-V4",
            cid=f"v4-export-{__name__}",
            service_status={
                "electricity": "LOAD_SHEDDING",
                "water": "DISRUPTED",
                "health": "PARTIALLY_OPERATIONAL",
                "pressing_needs": ["food_water", "medical"],
            },
        )

    def test_csv_includes_flat_v4_columns(self, client, viewer_token, v4_report_id):
        res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
        assert res.status_code == 200
        lines = res.text.strip().split("\n")
        assert len(lines) >= 2
        header_line = lines[0]
        # Every flat V4 column must be present in the header row.
        for col in (
            "electricity_status", "water_status", "health_status",
            "pressing_needs", "reporter_tier",
        ):
            assert col in header_line, f"CSV header missing '{col}': {header_line}"
        # The seeded row's values must appear in some data line.
        body = "\n".join(lines[1:])
        assert "LOAD_SHEDDING" in body
        assert "DISRUPTED" in body
        assert "PARTIALLY_OPERATIONAL" in body
        # pressing_needs are joined with semicolons (CSV-safe).
        assert "food_water;medical" in body

    def test_geojson_features_include_v4_properties(self, client, viewer_token, v4_report_id):
        res = client.get("/api/v1/exports/geojson", headers=auth_header(viewer_token))
        assert res.status_code == 200
        data = res.json()
        assert data["type"] == "FeatureCollection"
        assert data["features"], "GeoJSON has no features"
        # Find our seeded report by infrastructure_type + crisis_type.
        ours = [
            f for f in data["features"]
            if f["properties"].get("crisis_type") == "EARTHQUAKE"
            and f["properties"].get("infrastructure_sub_type") == "ROAD"
        ]
        assert ours, "seeded V4 report not in GeoJSON output"
        # Every V4 property must be present + carry the right value
        # on at least one feature.
        v4_values = [
            (f["properties"].get("electricity_status"),
             f["properties"].get("water_status"),
             f["properties"].get("health_status"),
             f["properties"].get("pressing_needs"))
            for f in ours
        ]
        assert ("LOAD_SHEDDING", "DISRUPTED", "PARTIALLY_OPERATIONAL", "food_water;medical") in v4_values, (
            f"GeoJSON V4 props don't carry seeded values; got: {v4_values}"
        )

    def test_shapefile_dbf_has_v4_columns(self, client, viewer_token, v4_report_id):
        res = client.get("/api/v1/exports/shapefile", headers=auth_header(viewer_token))
        assert res.status_code == 200
        z = zipfile.ZipFile(io.BytesIO(res.content))
        dbf_name = next(n for n in z.namelist() if n.endswith(".dbf"))
        dbf_blob = z.read(dbf_name)
        # The DBF file header carries the field names verbatim in
        # bytes 32+ (one record per field, 32 bytes each). We don't
        # need to parse the full struct — just check the names land
        # in the raw blob. ESRI 10-char limit means we abbreviated.
        for needle in (b"ELEC_STAT", b"WATER_STAT", b"HEALTH_ST", b"NEEDS", b"REPRT_TIER"):
            assert needle in dbf_blob, f"Shapefile DBF missing column header {needle!r}"

    def test_kml_extended_data_carries_v4_fields(self, client, viewer_token, v4_report_id):
        res = client.get("/api/v1/exports/kml", headers=auth_header(viewer_token))
        assert res.status_code == 200
        body = res.text
        # ExtendedData / Data name=... elements must carry the V4
        # field names so QGIS + Google Earth can surface them as
        # queryable attributes.
        for needle in (
            'name="electricity_status"',
            'name="water_status"',
            'name="health_status"',
            'name="pressing_needs"',
            'name="reporter_tier"',
        ):
            assert needle in body, f"KML missing ExtendedData {needle!r}"
        # And the seeded values must appear somewhere in the body.
        assert "LOAD_SHEDDING" in body
        assert "PARTIALLY_OPERATIONAL" in body

    def test_pdf_dossier_renders_v4_fields(self, client, viewer_token, v4_report_id):
        res = client.get("/api/v1/exports/pdf", headers=auth_header(viewer_token))
        assert res.status_code == 200
        body = res.content
        # ReportLab compresses the content streams (Flate + a font
        # encoding pass that drops ASCII bytes). Use pypdf to extract
        # the actual rendered text, then assert the V4 labels are in
        # there. Skip the assertion gracefully if pypdf isn't
        # installed in the dev env — the CSV/GeoJSON/Shapefile/KML
        # tests above already pin the wire contract.
        try:
            import pypdf
        except ImportError:
            pytest.skip("pypdf not installed; PDF text extraction unavailable")

        reader = pypdf.PdfReader(io.BytesIO(body))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        for label in ("Power Status", "Water Status", "Health Status",
                      "Pressing Needs", "Reporter Tier"):
            assert label in text, f"PDF rendered text missing label {label!r}"
        # And the actual seeded values landed.
        assert "LOAD_SHEDDING" in text or "load_shedding" in text.lower()
        assert "DISRUPTED" in text or "disrupted" in text.lower()
