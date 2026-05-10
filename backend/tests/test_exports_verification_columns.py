"""
Phase C.1 (May 2026, UNDP-grade rebuild) — verification columns in
CSV / GeoJSON exports.

UNDP judges and downstream analysts pulling bulk data should see truth
scores alongside the report data — not just in the dashboard. This
module pins the contract:

  • CSV header includes 6 satellite_* columns
  • CSV body emits values when a SatelliteVerification row exists
  • GeoJSON properties include the same 6 keys
  • Reports without a verification still serialise (blank columns,
    not missing — keeps schema stable for spreadsheet pipelines)
"""
from __future__ import annotations

import csv
import io
import json
import uuid
import pytest

from app.models.report import SatelliteVerification


def _create_report(client) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"TEST-EXPORT-{uuid.uuid4().hex[:8]}",
        "client_report_id": f"export-{uuid.uuid4().hex[:12]}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "export columns test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _attach_verification(db, report_id: str, **overrides):
    existing = db.query(SatelliteVerification).filter(
        SatelliteVerification.report_id == report_id
    ).first()
    if existing:
        db.delete(existing)
        db.flush()
    defaults = dict(
        id=f"ver-{uuid.uuid4().hex[:8]}",
        report_id=report_id,
        total_score=78,
        verdict="LIKELY_AUTHENTIC",
        satellite_source="AWS Sentinel-2",
        satellite_acquisition_date="2026-05-08T00:00:00Z",
        satellite_cloud_cover_pct=12.5,
        satellite_days_gap=2,
    )
    defaults.update(overrides)
    v = SatelliteVerification(**defaults)
    db.add(v)
    db.commit()
    return v


class TestCSVVerificationColumns:
    """The 6 satellite_* columns must appear in the CSV header + body."""

    def test_csv_header_includes_6_satellite_columns(self, client, viewer_token):
        res = client.get(
            "/api/v1/exports/csv",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        # First line is the header row.
        header_line = res.text.splitlines()[0]
        for col in (
            "satellite_verdict",
            "satellite_total_score",
            "satellite_acquisition_date",
            "satellite_days_gap",
            "satellite_cloud_cover_pct",
            "satellite_source",
        ):
            assert col in header_line, f"missing column {col} in CSV header: {header_line}"

    def test_csv_body_populates_verification_values(
        self, client, db, viewer_token
    ):
        rid = _create_report(client)
        _attach_verification(db, rid)

        res = client.get(
            "/api/v1/exports/csv",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        rows = list(csv.DictReader(io.StringIO(res.text)))
        row = next((r for r in rows if r["id"] == rid), None)
        assert row is not None, f"report {rid} not in CSV"
        assert row["satellite_verdict"] == "LIKELY_AUTHENTIC"
        assert row["satellite_total_score"] == "78"
        assert row["satellite_source"] == "AWS Sentinel-2"
        # cloud_cover_pct formatted to 1 decimal — matches the dashboard
        # display so cross-checks line up between exports and the UI.
        assert row["satellite_cloud_cover_pct"] == "12.5"
        assert row["satellite_days_gap"] == "2"

    def test_csv_body_blank_columns_when_no_verification(
        self, client, viewer_token
    ):
        """Reports that haven't been verified still serialise — empty
        strings for the satellite_* columns rather than missing keys.
        Keeps spreadsheet pipelines stable."""
        rid = _create_report(client)
        # No verification attached.
        res = client.get(
            "/api/v1/exports/csv",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        rows = list(csv.DictReader(io.StringIO(res.text)))
        row = next((r for r in rows if r["id"] == rid), None)
        assert row is not None
        assert row["satellite_verdict"] == ""
        assert row["satellite_total_score"] == ""
        assert row["satellite_cloud_cover_pct"] == ""


class TestGeoJSONVerificationProperties:
    """The same satellite_* fields surface as `properties` on each Feature."""

    def test_geojson_properties_include_verification_fields(
        self, client, db, viewer_token
    ):
        rid = _create_report(client)
        _attach_verification(db, rid)

        res = client.get(
            "/api/v1/exports/geojson",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        body = json.loads(res.text)
        features = body["features"]
        feat = next((f for f in features if f["properties"]["id"] == rid), None)
        assert feat is not None, f"report {rid} not in GeoJSON"
        props = feat["properties"]
        assert props["satellite_verdict"] == "LIKELY_AUTHENTIC"
        assert props["satellite_total_score"] == "78"
        assert props["satellite_cloud_cover_pct"] == "12.5"

    def test_geojson_unverified_reports_have_blank_sat_fields(
        self, client, viewer_token
    ):
        rid = _create_report(client)
        res = client.get(
            "/api/v1/exports/geojson",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        body = json.loads(res.text)
        feat = next((f for f in body["features"] if f["properties"]["id"] == rid), None)
        assert feat is not None
        props = feat["properties"]
        assert props["satellite_verdict"] == ""
        assert props["satellite_total_score"] == ""
