"""API tests for data export endpoints."""
import json
import zipfile
import io
import pytest
from tests.conftest import auth_header


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
