"""Regression: Telegram consent prompt must NOT use legacy Markdown.

Background
----------
Shortly after shipping the Telegram consent flow, field testers reported
the bot "hanging after language select" — you tap `🇬🇧 English`, the
language toast appears, then silence. Root cause: `send_consent_prompt`
wrapped its title in `*…*` and posted with `parse_mode=Markdown`. The
body contains `(…)` groups + a trailing `/delete` command + mixed
emoji; Telegram's LEGACY `Markdown` parser (the one most widely
supported across clients) refuses that combo with:

    Bad Request: can't parse entities:
    Can't find end of the entity starting at byte offset 24

The message was silently dropped, leaving the user staring at a blank
chat. This file pins two guarantees:

1. `send_consent_prompt` never submits `parse_mode=Markdown` (it must
   use plain text or MarkdownV2/HTML — legacy Markdown is banned for
   this specific template).
2. `_send` has a graceful parse-error retry: on a 400 "can't parse
   entities" response it re-posts without `parse_mode`, so any future
   template regression degrades to plain-text delivery instead of a
   silent drop.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from messaging_bot.telegram import bot_replies


class TestConsentPromptNoLegacyMarkdown:

    @pytest.mark.asyncio
    async def test_consent_prompt_does_not_use_markdown(self, monkeypatch):
        """Reproducer for the "hang after language select" bug. Must
        not regress: the consent card is the first message the user
        sees after opting in; any parse error drops them into a dead
        end."""
        captured = {}

        async def fake_send(method, data):
            captured["method"] = method
            captured["data"] = data

        monkeypatch.setattr(bot_replies, "_send", fake_send)
        await bot_replies.send_consent_prompt(chat_id=12345, lang="en")
        assert captured["method"] == "sendMessage"
        # The bug: this key used to be set to "Markdown". Banning the
        # whole family here means a future translator can drop bold
        # markers into the text without breaking the flow.
        assert "parse_mode" not in captured["data"], (
            "send_consent_prompt must NOT set parse_mode — legacy "
            "Markdown breaks on this template. See test docstring."
        )
        # Still carries text content + both consent buttons.
        # (We don't assert on a specific phrase — `t()` returns the
        # key itself when the locale lacks the `consent_title` /
        # `consent_body` strings, which is the intended fallback path.
        # The flow contract is "a message went out with both buttons";
        # the copy is i18n-team territory.)
        assert captured["data"]["text"]
        btns = [b["callback_data"]
                for row in captured["data"]["reply_markup"]["inline_keyboard"]
                for b in row]
        assert "consent_accept" in btns
        assert "consent_decline" in btns


class TestSendParseErrorRetry:

    @pytest.mark.asyncio
    async def test_parse_error_retries_without_parse_mode(self, monkeypatch):
        """On a 400 'can't parse entities', `_send` must re-POST the
        payload without `parse_mode` so the user sees SOMETHING. Silent
        drops are the worst-case UX — we'd rather ship plain text than
        nothing."""
        # First POST: parse-entity 400. Second POST: 200.
        resp_bad = MagicMock()
        resp_bad.status_code = 400
        resp_bad.text = (
            '{"ok":false,"error_code":400,'
            '"description":"Bad Request: can\'t parse entities: Can\'t find end '
            'of the entity starting at byte offset 24"}'
        )
        resp_ok = MagicMock()
        resp_ok.status_code = 200
        resp_ok.text = '{"ok":true}'

        post_mock = AsyncMock(side_effect=[resp_bad, resp_ok])

        class _FakeClient:
            def __init__(self, *a, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            post = post_mock

        monkeypatch.setattr(bot_replies, "BOT_TOKEN", "test-token")
        monkeypatch.setattr(bot_replies.httpx, "AsyncClient", _FakeClient)

        await bot_replies._send("sendMessage", {
            "chat_id": 1, "text": "hi", "parse_mode": "Markdown",
        })
        # Two calls: the failing one + the retry without parse_mode.
        assert post_mock.await_count == 2
        retry_payload = post_mock.await_args_list[1].kwargs.get("json") \
                       or post_mock.await_args_list[1].args[-1]
        # Retry MUST NOT carry parse_mode.
        assert "parse_mode" not in retry_payload
        # But keeps the original text + chat_id.
        assert retry_payload["chat_id"] == 1
        assert retry_payload["text"] == "hi"

    @pytest.mark.asyncio
    async def test_non_parse_400_not_retried(self, monkeypatch):
        """Other 400s (chat not found, message too long) are genuine —
        don't waste a retry on them."""
        resp = MagicMock()
        resp.status_code = 400
        resp.text = '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'
        post_mock = AsyncMock(return_value=resp)

        class _FakeClient:
            def __init__(self, *a, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            post = post_mock

        monkeypatch.setattr(bot_replies, "BOT_TOKEN", "test-token")
        monkeypatch.setattr(bot_replies.httpx, "AsyncClient", _FakeClient)

        await bot_replies._send("sendMessage", {
            "chat_id": 1, "text": "hi", "parse_mode": "Markdown",
        })
        assert post_mock.await_count == 1   # single call, no retry
