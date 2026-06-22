"""Standalone Building Assessment Report PDF: GET /buildings/{id}/assessment.pdf."""
import io
import pytest
import pypdf
from tests.conftest import auth_header
from app.models.report import Report


def _seed(client, *, cid, building_id):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"DH-{cid}", "client_report_id": cid, "source": "APP",
        "severity": "SEVERE", "infrastructure_type": "HOSPITAL", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL", "expected_media": 0, "building_id": building_id,
        "infrastructure_name": "Apollo Hospital",
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _pdf_text(content: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(content))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def test_assessment_pdf_404_before_any_assessment(client, analyst_token):
    bid = "osm:way:pdfA"
    _seed(client, cid="pdf-1", building_id=bid)
    res = client.get(f"/api/v1/buildings/{bid}/assessment.pdf", headers=auth_header(analyst_token))
    assert res.status_code == 404


def test_assessment_pdf_after_assess(client, analyst_token, db, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    async def fake_assess(report_id, payload=None, user=None, db=None, force=False):
        r = db.query(Report).filter(Report.id == report_id).first()
        r.ai_assessment = {"confidence_score": 80, "summary": "mock"}
        db.commit()
        return dict(r.ai_assessment, _cached=False)
    monkeypatch.setattr("app.api.endpoints.reports.ai_assess_report", fake_assess)

    bid = "osm:way:pdfB"
    _seed(client, cid="pdf-2", building_id=bid)
    assert client.post(f"/api/v1/buildings/{bid}/assess?force=true",
                       headers=auth_header(analyst_token)).status_code == 200

    res = client.get(f"/api/v1/buildings/{bid}/assessment.pdf", headers=auth_header(analyst_token))
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert res.content.startswith(b"%PDF-")
    text = _pdf_text(res.content)
    assert "Building Assessment Report" in text
    assert "Per-incident assessment" in text
    assert "Satellite verification" in text   # must-have #11 section present
