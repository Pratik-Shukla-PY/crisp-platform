"""AI assessment endpoint — /reports/{id}/ai-assess.

This endpoint ships the full 8-section intelligence dossier to Claude and
persists the structured verdict onto the report row (ai_assessment JSON +
optional classification overrides). The Anthropic call goes out via
`httpx.AsyncClient.post`, so we mock that to avoid hitting the real API.
"""
import json
import os
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

from tests.conftest import auth_header


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_claude_response(body: dict, status_code: int = 200):
    """Build a MagicMock that quacks like an httpx.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = json.dumps(body)
    # Claude's real wire format: {"content":[{"text":"<json-blob>"}], ...}
    # The endpoint yanks content[0].text then locates the first/last brace.
    resp.json = MagicMock(return_value={
        "content": [{"text": json.dumps(body)}],
    })
    return resp


def _mock_async_client_ctx(response_obj):
    """Return an AsyncMock that behaves like `httpx.AsyncClient(timeout=...)`
    when used in `async with ... as c:` — i.e. __aenter__ returns something
    whose `post()` is an AsyncMock returning ``response_obj``.
    """
    client_obj = MagicMock()
    client_obj.post = AsyncMock(return_value=response_obj)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=client_obj)
    ctx.__aexit__ = AsyncMock(return_value=None)
    return MagicMock(return_value=ctx)


@pytest.fixture
def anthropic_key_set(monkeypatch):
    """Ensure ANTHROPIC_API_KEY is non-empty — otherwise the endpoint 503s
    before even building the dossier."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-fake-for-pytest")


class TestAIAssessAuthz:
    def test_ai_assess_requires_analyst(
        self, client, sample_report, viewer_token, anthropic_key_set,
    ):
        """Viewer → 403. No mock needed; the role-check runs BEFORE any
        outbound call."""
        rid = sample_report["id"]
        res = client.post(
            f"/api/v1/reports/{rid}/ai-assess",
            headers=auth_header(viewer_token),
            json={},
        )
        assert res.status_code == 403


class TestAIAssessHappyPath:
    def test_ai_assess_with_mocked_anthropic_populates_ai_analysis(
        self, client, sample_report, analyst_token, anthropic_key_set, db,
    ):
        """Mock the outbound Claude call → the endpoint persists the full
        JSON verdict onto `report.ai_assessment`. We assert key fields
        are present (summary, priority_level) and that the inferred
        severity was written through to the report column.
        """
        rid = sample_report["id"]
        fake_verdict = {
            "priority_level": "P2_URGENT",
            "confidence_score": 82,
            "suggested_action": "Dispatch Rescue Team",
            "lives_at_risk_estimate": "3-5",
            "inferred_severity": "SEVERE",
            "inferred_crisis_type": "FLOOD",
            "inferred_damage_class": "PARTIAL",
            "score_breakdown": {
                "text_voice_score": 80, "visual_evidence_score": 70,
                "satellite_score": 60, "corroboration_score": 75,
                "credibility_bonus": 2, "criticality_bonus": 3,
                "penalties": 0, "raw_total": 82.0, "final_score": 82,
            },
            "key_factors": ["local-detail", "photo-present"],
            "risk_flags": [],
            "summary": "Probable real flood damage at a residential block. Dispatch.",
            "reasoning": "Text + photo corroborate. Nearby reports 4.",
        }
        resp_obj = _make_claude_response(fake_verdict)

        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_obj)):
            res = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["summary"].startswith("Probable real flood damage")
        assert body["priority_level"] == "P2_URGENT"

        # Persisted to DB — ai_assessment JSON, and inferred_severity → column.
        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.ai_assessment is not None
        assert r.ai_assessment["priority_level"] == "P2_URGENT"
        assert r.severity.value == "SEVERE"
        assert r.crisis_type == "FLOOD"
        assert r.damage_classification == "PARTIAL"


class TestAIAssessErrorHandling:
    def test_ai_assess_handles_anthropic_exception_gracefully(
        self, client, sample_report, analyst_token, anthropic_key_set, db,
    ):
        """If Claude returns a non-200 status, the endpoint surfaces 502
        ("AI service error") and does NOT write a partial ai_assessment.
        Timeout raises 504 via the TimeoutException handler — we pick the
        502 branch here because it's the more common failure mode (rate
        limit / transient 5xx).
        """
        rid = sample_report["id"]

        # Snapshot pre-call state so we can prove no partial write.
        from app.models.report import Report
        before = db.query(Report).filter(Report.id == rid).first()
        pre_assessment = before.ai_assessment
        pre_severity = before.severity.value

        # Claude returns 500.
        resp_obj = _make_claude_response({"error": "boom"}, status_code=500)
        resp_obj.text = "upstream-500"

        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_obj)):
            res = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert res.status_code == 502
        assert "AI service error" in res.json().get("detail", "")

        # Post-call state unchanged.
        db.expire_all()
        after = db.query(Report).filter(Report.id == rid).first()
        assert after.ai_assessment == pre_assessment
        assert after.severity.value == pre_severity


class TestAIAssessIdempotency:
    """Phase 3.3 (May 2026) — cost-protection. Repeated /ai-assess
    calls on the same report MUST NOT re-bill Claude. The endpoint
    re-uses ``report.ai_assessment`` if it's already populated;
    callers explicitly pass ``?force=true`` to override.

    Rationale: the dashboard's "Credibility Check" button fires this
    endpoint on every click; two analysts hitting the same report,
    a page refresh between async result arrivals, or a programmatic
    re-poll would all duplicate-bill Claude without this gate. At
    UNDP-judging scale (~500 evaluator clicks across the test fleet)
    that's measurable cost AND model jitter (Claude isn't strictly
    deterministic — the second answer may differ from the first).
    """

    def test_ai_assess_caches_first_result_and_skips_claude_on_rerun(
        self, client, sample_report, analyst_token, anthropic_key_set, db,
    ):
        """First POST → fresh Claude call + persist. Second POST →
        cached blob returned, mock NOT invoked again."""
        rid = sample_report["id"]
        fake_1 = {
            "priority_level": "P3_STANDARD", "confidence_score": 55,
            "summary": "First call.", "suggested_action": "Monitor",
            "inferred_severity": "MODERATE",
        }
        # If the cache is honoured, the SECOND mock NEVER gets called.
        # Use a sentinel response that would FAIL the test if it
        # actually landed (different priority).
        sentinel = {
            "priority_level": "P1_IMMEDIATE", "confidence_score": 95,
            "summary": "Should never appear — cache should short-circuit.",
            "suggested_action": "Dispatch Rescue Team",
            "inferred_severity": "CRITICAL",
        }
        resp_1 = _make_claude_response(fake_1)
        resp_sentinel = _make_claude_response(sentinel)

        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_1)):
            r1 = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert r1.status_code == 200
        body1 = r1.json()
        assert body1["priority_level"] == "P3_STANDARD"
        # Fresh call → `_cached: False` in the response envelope.
        assert body1.get("_cached") is False, body1
        # Metadata stamp present.
        assert "_meta" in body1
        assert "computed_at" in body1["_meta"]

        # Re-POST with sentinel mock — if the cache works, the mock
        # is never asked.
        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_sentinel)):
            r2 = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert r2.status_code == 200
        body2 = r2.json()
        # The cache returns the FIRST verdict, not the sentinel.
        assert body2["priority_level"] == "P3_STANDARD"
        assert body2["summary"].startswith("First call")
        # `_cached: True` so the dashboard can render "cached at X".
        assert body2.get("_cached") is True

        # DB unchanged — the cached blob wasn't overwritten.
        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.ai_assessment["priority_level"] == "P3_STANDARD"
        # And the inferred severity from the FIRST call is what's
        # persisted (not the sentinel's CRITICAL).
        assert r.severity.value == "MODERATE"

    def test_ai_assess_force_query_param_bypasses_cache(
        self, client, sample_report, analyst_token, anthropic_key_set, db,
    ):
        """Explicit ``?force=true`` must override the cache — operators
        need a way to re-run after a re-classification or a media
        attach changes the dossier inputs."""
        rid = sample_report["id"]
        fake_1 = {
            "priority_level": "P3_STANDARD", "confidence_score": 55,
            "summary": "First call.", "suggested_action": "Monitor",
            "inferred_severity": "MODERATE",
        }
        fake_2 = {
            "priority_level": "P1_IMMEDIATE", "confidence_score": 95,
            "summary": "Re-run after new evidence.",
            "suggested_action": "Dispatch Rescue Team",
            "inferred_severity": "CRITICAL",
        }
        resp_1 = _make_claude_response(fake_1)
        resp_2 = _make_claude_response(fake_2)

        # First call seeds the cache.
        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_1)):
            r1 = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert r1.status_code == 200
        assert r1.json()["priority_level"] == "P3_STANDARD"

        # Force re-run.
        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp_2)):
            r2 = client.post(
                f"/api/v1/reports/{rid}/ai-assess?force=true",
                headers=auth_header(analyst_token),
                json={},
            )
        assert r2.status_code == 200
        body2 = r2.json()
        # Force bypasses the cache → fresh verdict.
        assert body2["priority_level"] == "P1_IMMEDIATE"
        assert body2.get("_cached") is False, body2

        # DB now carries the FORCED verdict.
        from app.models.report import Report
        db.expire_all()
        r = db.query(Report).filter(Report.id == rid).first()
        assert r.ai_assessment["priority_level"] == "P1_IMMEDIATE"
        assert r.severity.value == "CRITICAL"

    def test_ai_assess_empty_dict_assessment_counts_as_cache_miss(
        self, client, sample_report, analyst_token, anthropic_key_set, db,
    ):
        """An empty {} on report.ai_assessment is a NO-cache state
        (the field is nullable; tests / migrations may stamp an
        empty dict). The cache guard checks ``isinstance + truthy``
        so an empty dict triggers a fresh Claude call."""
        rid = sample_report["id"]
        # Stamp an empty dict — treat as cache miss.
        from app.models.report import Report
        r = db.query(Report).filter(Report.id == rid).first()
        r.ai_assessment = {}
        db.commit()

        fake = {
            "priority_level": "P2_URGENT", "confidence_score": 80,
            "summary": "Fresh.", "suggested_action": "Monitor",
            "inferred_severity": "SEVERE",
        }
        resp = _make_claude_response(fake)
        with patch("httpx.AsyncClient", _mock_async_client_ctx(resp)):
            res = client.post(
                f"/api/v1/reports/{rid}/ai-assess",
                headers=auth_header(analyst_token),
                json={},
            )
        assert res.status_code == 200
        body = res.json()
        # Empty dict → cache miss → Claude was called → `_cached: False`.
        assert body["priority_level"] == "P2_URGENT"
        assert body.get("_cached") is False
