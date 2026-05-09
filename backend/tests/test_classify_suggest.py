"""
Unit + integration tests for the v4 classify-suggest endpoint
(POST /api/v1/reports/classify-suggest) and its underlying service.

The service wraps Claude Haiku for predicting (infra, crisis, damage) from
a single ground-level photo. Tests cover:

  • Happy path (mocked Anthropic) — valid JSON response in enum sets is
    returned with source="ai".
  • Fallback paths — no API key, timeout, parse failure, out-of-enum
    response — all return source="fallback" with a reason.
  • Endpoint validation — 422 on missing image, 429 on rate limit abuse,
    media_type defaulting, optional GPS coercion.
  • Public defaults (`_fallback`) match what the v4 client expects.

We don't make real API calls — every test mocks `anthropic.AsyncAnthropic`.
"""
from __future__ import annotations

import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Service-level tests ────────────────────────────────────────────────────

@pytest.fixture
def tiny_jpeg_b64():
    """Minimal valid JPEG (just enough bytes to look like one). Anthropic's
    SDK never sees this in tests since we mock the whole client."""
    return base64.b64encode(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00fake").decode()


def _mock_anthropic_response(text: str):
    """Build a fake `messages.create` response object with the given body."""
    block = MagicMock()
    block.text = text
    msg = MagicMock()
    msg.content = [block]
    return msg


class TestClassifySuggestService:
    @pytest.mark.asyncio
    async def test_no_api_key_returns_fallback(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        svc = ClassifySuggestService()
        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "fallback"
        assert out["fallback_reason"] == "no api key"
        assert out["infrastructure_type"] == "RESIDENTIAL"
        assert out["crisis_type"] == "EARTHQUAKE"
        assert out["damage_classification"] == "PARTIAL"

    @pytest.mark.asyncio
    async def test_empty_image_returns_fallback(self, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        out = await svc.suggest(image_b64="")
        assert out["source"] == "fallback"
        assert out["fallback_reason"] == "no image"

    @pytest.mark.asyncio
    async def test_oversize_image_returns_fallback(self, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        # 12 MB base64 string — exceeds the 8 MB × 1.4 cap
        oversize = "A" * (12 * 1024 * 1024)
        out = await svc.suggest(image_b64=oversize)
        assert out["source"] == "fallback"
        assert out["fallback_reason"] == "image too large"

    @pytest.mark.asyncio
    async def test_happy_path_returns_ai_source(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()

        good_json = json.dumps({
            "infrastructure_type": "COMMUNITY",
            "crisis_type": "EARTHQUAKE",
            "damage_classification": "PARTIAL",
            "confidence": 0.78,
            "reasoning_short": "school building, cracked walls + broken glass",
        })

        fake_client = MagicMock()
        fake_client.messages = MagicMock()
        fake_client.messages.create = AsyncMock(return_value=_mock_anthropic_response(good_json))
        svc._client = fake_client

        out = await svc.suggest(image_b64=tiny_jpeg_b64, lat=12.97, lng=77.59)
        assert out["source"] == "ai"
        assert out["infrastructure_type"] == "COMMUNITY"
        assert out["crisis_type"] == "EARTHQUAKE"
        assert out["damage_classification"] == "PARTIAL"
        assert out["confidence"] == 0.78
        # The prompt + GPS context should have been threaded through
        call_args = fake_client.messages.create.call_args
        assert call_args is not None
        msgs = call_args.kwargs["messages"]
        assert len(msgs) == 1
        # Two content parts: the image and the prompt text
        assert len(msgs[0]["content"]) == 2
        text_block = msgs[0]["content"][1]["text"]
        assert "12.9700" in text_block
        assert "77.5900" in text_block

    @pytest.mark.asyncio
    async def test_markdown_fenced_response_is_parsed(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        # Sometimes Haiku wraps the JSON in ```json ... ``` fences despite
        # the prompt saying not to. The parser should strip them.
        fenced = "```json\n" + json.dumps({
            "infrastructure_type": "TRANSPORT_COMMUNICATION",
            "crisis_type": "FLOOD",
            "damage_classification": "COMPLETE",
            "confidence": 0.9,
            "reasoning_short": "bridge submerged in water",
        }) + "\n```"
        fake_client = MagicMock()
        fake_client.messages.create = AsyncMock(return_value=_mock_anthropic_response(fenced))
        svc._client = fake_client
        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "ai"
        assert out["infrastructure_type"] == "TRANSPORT_COMMUNICATION"
        assert out["crisis_type"] == "FLOOD"
        assert out["damage_classification"] == "COMPLETE"

    @pytest.mark.asyncio
    async def test_unparseable_response_falls_back(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        fake_client = MagicMock()
        fake_client.messages.create = AsyncMock(
            return_value=_mock_anthropic_response("here is the answer: not json")
        )
        svc._client = fake_client
        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "fallback"
        assert out["fallback_reason"] == "unparseable response"

    @pytest.mark.asyncio
    async def test_out_of_enum_response_falls_back(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        bad_json = json.dumps({
            "infrastructure_type": "SOMETHING_ELSE",  # not in the enum
            "crisis_type": "EARTHQUAKE",
            "damage_classification": "PARTIAL",
            "confidence": 0.5,
            "reasoning_short": "x",
        })
        fake_client = MagicMock()
        fake_client.messages.create = AsyncMock(return_value=_mock_anthropic_response(bad_json))
        svc._client = fake_client
        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "fallback"
        assert "infra out of set" in out["fallback_reason"]

    @pytest.mark.asyncio
    async def test_timeout_falls_back(self, tiny_jpeg_b64, monkeypatch):
        """When Anthropic is slow, the service must time out and tell the
        client to use heuristics — never block the user."""
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        # Force a tight timeout so the test is fast.
        monkeypatch.setattr(
            "app.services.classify_suggest._TIMEOUT_SECONDS", 0.1, raising=True,
        )
        svc = ClassifySuggestService()

        async def slow_create(*args, **kwargs):
            await asyncio.sleep(0.5)  # simulate slow Anthropic
            return _mock_anthropic_response("never returned")

        fake_client = MagicMock()
        fake_client.messages.create = slow_create
        svc._client = fake_client

        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "fallback"
        assert out["fallback_reason"] == "timeout"

    @pytest.mark.asyncio
    async def test_anthropic_exception_falls_back(self, tiny_jpeg_b64, monkeypatch):
        from app.services.classify_suggest import ClassifySuggestService
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        svc = ClassifySuggestService()
        fake_client = MagicMock()
        fake_client.messages.create = AsyncMock(side_effect=RuntimeError("API unreachable"))
        svc._client = fake_client
        out = await svc.suggest(image_b64=tiny_jpeg_b64)
        assert out["source"] == "fallback"
        assert "exception: RuntimeError" in out["fallback_reason"]


# ── Endpoint-level tests ───────────────────────────────────────────────────

class TestClassifySuggestEndpoint:
    def test_missing_image_returns_422(self, client):
        res = client.post("/api/v1/reports/classify-suggest", json={})
        assert res.status_code == 422
        assert "image_b64" in res.json()["detail"]

    def test_image_b64_must_be_string(self, client):
        res = client.post(
            "/api/v1/reports/classify-suggest",
            json={"image_b64": 12345},
        )
        assert res.status_code == 422

    def test_endpoint_returns_fallback_when_no_api_key(self, client, monkeypatch, tiny_jpeg_b64):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        res = client.post(
            "/api/v1/reports/classify-suggest",
            json={"image_b64": tiny_jpeg_b64, "media_type": "image/jpeg"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["source"] == "fallback"
        assert body["infrastructure_type"] in (
            "RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY",
            "TRANSPORT_COMMUNICATION", "COMMUNITY", "PUBLIC_SPACES", "OTHER",
        )

    def test_invalid_media_type_falls_back_to_jpeg(self, client, tiny_jpeg_b64, monkeypatch):
        """The endpoint coerces unknown media_type → image/jpeg rather
        than rejecting; client-side typo shouldn't break the suggest call."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        res = client.post(
            "/api/v1/reports/classify-suggest",
            json={"image_b64": tiny_jpeg_b64, "media_type": "image/garbage"},
        )
        assert res.status_code == 200

    def test_non_numeric_lat_lng_is_dropped(self, client, tiny_jpeg_b64, monkeypatch):
        """Defensive coercion: a client that sends `lat: "12.97"` (string)
        shouldn't break the call. We just treat them as missing."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        res = client.post(
            "/api/v1/reports/classify-suggest",
            json={
                "image_b64": tiny_jpeg_b64,
                "lat": "12.97",
                "lng": None,
            },
        )
        assert res.status_code == 200

    def test_response_shape_is_complete(self, client, tiny_jpeg_b64, monkeypatch):
        """Run BEFORE the rate-limit test — the rate limiter is process-
        global and doesn't reset between tests; running this test after
        the 60-spam test would itself 429."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        res = client.post(
            "/api/v1/reports/classify-suggest",
            json={"image_b64": tiny_jpeg_b64},
        )
        # Could be 200 (under limit) or 429 (limit hit by earlier tests in
        # this module). Either is fine; on 200 we verify the shape.
        if res.status_code == 200:
            body = res.json()
            for key in (
                "infrastructure_type", "crisis_type", "damage_classification",
                "confidence", "reasoning_short", "source",
            ):
                assert key in body, f"missing response key: {key}"
        else:
            assert res.status_code == 429

    def test_rate_limit_kicks_in_eventually(self, client, tiny_jpeg_b64, monkeypatch):
        """The endpoint enforces 60 req/min/IP — make 70 calls and assert
        AT LEAST one is 429. Doesn't try to pin the exact transition
        point because the in-process limiter accumulates state across
        tests in this module."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        statuses = []
        for _ in range(70):
            res = client.post(
                "/api/v1/reports/classify-suggest",
                json={"image_b64": tiny_jpeg_b64},
            )
            statuses.append(res.status_code)
        assert 429 in statuses, (
            "Expected at least one 429 across 70 calls; got "
            f"only {set(statuses)}"
        )
        # Also verify we got SOME 200s — i.e. the limiter isn't denying
        # everyone (would indicate a regression in the rate-limit logic).
        assert 200 in statuses
