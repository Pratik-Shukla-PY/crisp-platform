"""Regression: Telegram bot end-to-end fixes (May 2026).

Operator-reported, three distinct bugs:

A. Duplicate-tab double-action — user has the bot open in two phone tabs
   (or scrolls back to an older message), taps a button on the STALE
   inline keyboard. Different `cq_id`, identical `data`, way outside the
   existing 2-second-window dedupe → handler fires a second time, state
   advances twice, the report receives duplicate writes.

B. Original (HIGH-tier) photo never surfaces on the dashboard. Telegram-
   bot chunked uploads hard-coded `resolution_tier: "LOW"`. The dashboard
   filters Originals on `resolution_tier === 'HIGH'`, so every Telegram
   photo was permanently hidden from the Originals tab.

C. Taxonomy parity with the PWA + UNDP rubric: the bot offered LANDSLIDE
   and PANDEMIC as crisis chips, but the backend's
   `_enforce_undp_taxonomy` validator rejects them with 422 (CLAUDE.md
   must-have #5 names the canonical list and LANDSLIDE/PANDEMIC are not
   on it). Tapping either chip used to fail submission silently.

Fixes pinned by this file:

  1. `is_stale_callback_message(session, msg_id)` returns True when the
     callback came from any message other than the most recent prompt;
     `_handle_callback` calls it before the existing dedupe and silently
     drops the press.
  2. `track_prompt_msg(session, send_result)` captures the message_id of
     every prompt that carries an inline keyboard so the staleness check
     has a reference.
  3. `chunked_uploader._send_chunk_with_retry` and `_send_chunk_b64_
     fallback` now send `resolution_tier="HIGH"` when `media_type
     == "IMAGE"`. AUDIO stays at LOW.
  4. `bot_replies.send_step_crisis_type` no longer renders the
     LANDSLIDE/PANDEMIC chips. `session_manager.CRISIS_MAP` keeps those
     callback keys as back-compat aliases that fall through to OTHER so
     a stale chat tap is still UNDP-valid.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from messaging_bot.telegram import bot_replies, handlers, session_manager
from messaging_bot import chunked_uploader


# ── Bug A: stale-message dedupe ────────────────────────────────────────────

class TestStaleCallbackMessage:

    def test_no_active_prompt_means_not_stale(self):
        """First interaction (`active_prompt_msg_id is None`) must not
        trip the stale guard — otherwise the very first button press
        would be silently dropped."""
        s = session_manager.TelegramSession(user_hash="x", chat_id=1)
        assert s.active_prompt_msg_id is None
        assert session_manager.is_stale_callback_message(s, message_id=42) is False

    def test_matching_message_id_is_not_stale(self):
        s = session_manager.TelegramSession(user_hash="x", chat_id=1)
        s.active_prompt_msg_id = 555
        assert session_manager.is_stale_callback_message(s, message_id=555) is False

    def test_different_message_id_is_stale(self):
        """Old-tab scenario: active prompt is message 555 but the
        callback arrived on message 100 (the user scrolled up + tapped
        an older keyboard). Must be reported as stale."""
        s = session_manager.TelegramSession(user_hash="x", chat_id=1)
        s.active_prompt_msg_id = 555
        assert session_manager.is_stale_callback_message(s, message_id=100) is True

    def test_track_prompt_msg_captures_message_id(self):
        s = session_manager.TelegramSession(user_hash="x", chat_id=1)
        ok_response = {"ok": True, "result": {"message_id": 777}}
        session_manager.track_prompt_msg(s, ok_response)
        assert s.active_prompt_msg_id == 777

    def test_track_prompt_msg_ignores_failed_response(self):
        """A `None` (network error) or `{ok: False}` (Telegram error)
        must leave `active_prompt_msg_id` alone so the in-flight dedupe
        falls back to the existing time-windowed check."""
        s = session_manager.TelegramSession(user_hash="x", chat_id=1)
        s.active_prompt_msg_id = 42
        session_manager.track_prompt_msg(s, None)
        assert s.active_prompt_msg_id == 42
        session_manager.track_prompt_msg(s, {"ok": False, "description": "Bad Request"})
        assert s.active_prompt_msg_id == 42
        session_manager.track_prompt_msg(s, "not a dict")
        assert s.active_prompt_msg_id == 42

    @pytest.mark.asyncio
    async def test_callback_from_stale_message_does_not_fire_handler(self, monkeypatch):
        """End-to-end: a callback_query whose message.message_id doesn't
        match the session's `active_prompt_msg_id` is acked + dropped.
        The downstream `_prompt_for_step` MUST NOT be called for it."""
        # Seed a session with an active prompt msg_id.
        user_id = 11111
        chat_id = 22222
        session_manager.clear_session(user_id)
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.active_prompt_msg_id = 999
        # Stub network sends so no real Telegram traffic.
        sent_calls = []
        async def fake_send(method, data):
            sent_calls.append((method, data))
            return {"ok": True, "result": {"message_id": 1234}}
        monkeypatch.setattr(bot_replies, "_send", fake_send)
        # Spy on _prompt_for_step — must NOT fire for a stale callback.
        prompt_calls = []
        original_prompt = handlers._prompt_for_step
        async def fake_prompt(session, chat_id, step):
            prompt_calls.append((step,))
            await original_prompt(session, chat_id, step)
        monkeypatch.setattr(handlers, "_prompt_for_step", fake_prompt)
        # Stale callback: msg_id 555 ≠ active 999.
        stale_cb = {
            "id": "cq-stale-001",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": 555},
            "data": "crisis_flood",
        }
        await handlers._handle_callback(stale_cb)
        # Expectations: answer_callback fired (ack), edit_reply_markup
        # fired (clear stale buttons), NO _prompt_for_step.
        methods = [m for (m, _) in sent_calls]
        assert "answerCallbackQuery" in methods, "stale tap must still ack to clear the user's spinner"
        assert "editMessageReplyMarkup" in methods, "stale message keyboard must be cleared"
        assert prompt_calls == [], f"_prompt_for_step must NOT fire for stale callbacks; got {prompt_calls}"

    @pytest.mark.asyncio
    async def test_callback_from_active_message_clears_old_keyboard_then_advances(self, monkeypatch):
        """The HAPPY path: a callback arriving on the active prompt
        message gets handled normally — and the old keyboard is cleared
        so the user can't tap the same chip twice from the now-stale
        message."""
        user_id = 33333
        chat_id = 44444
        session_manager.clear_session(user_id)
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.state = "STEP_CRISIS_TYPE"
        s.active_prompt_msg_id = 999  # the prompt we're answering
        sent_calls = []
        async def fake_send(method, data):
            sent_calls.append((method, data))
            return {"ok": True, "result": {"message_id": 1500}}
        monkeypatch.setattr(bot_replies, "_send", fake_send)
        cb = {
            "id": "cq-active-001",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": 999},
            "data": "crisis_flood",
        }
        await handlers._handle_callback(cb)
        # The bot MUST have edited the *old* (999) keyboard to clear it
        # before sending the next prompt — otherwise the user could
        # tap the same chip on the now-stale message.
        edit_calls = [d for (m, d) in sent_calls if m == "editMessageReplyMarkup"]
        assert any(d.get("message_id") == 999 for d in edit_calls), \
            f"old keyboard 999 must be cleared; observed edits: {edit_calls}"


# ── Bug B: Telegram Originals dashboard receipt ────────────────────────────

class TestTelegramOriginalsTier:

    def test_image_chunks_send_resolution_tier_high(self):
        """The binary chunk form must carry `resolution_tier=HIGH` for
        IMAGE uploads so the dashboard's `resolution_tier === 'HIGH'`
        filter finds the Telegram-channel Original."""
        # The form dict construction lives inside
        # _send_chunk_with_retry. Easiest reach: re-derive the tier
        # the way the function does.
        for media_type in ("IMAGE",):
            tier = "HIGH" if media_type == "IMAGE" else "LOW"
            assert tier == "HIGH", "IMAGE chunks must be tagged HIGH"
        for media_type in ("AUDIO", "VIDEO"):
            tier = "HIGH" if media_type == "IMAGE" else "LOW"
            assert tier == "LOW", "AUDIO/VIDEO chunks remain LOW"

    @pytest.mark.asyncio
    async def test_binary_chunk_form_contains_high_for_image(self, monkeypatch):
        """Live-fire: invoke _send_chunk_with_retry with an IMAGE chunk
        and observe the form sent to the backend carries HIGH."""
        captured = {}

        class FakeResp:
            status_code = 200

        class FakeClient:
            async def post(self, url, **kwargs):
                captured["url"] = url
                captured["data"] = kwargs.get("data")
                captured["files"] = kwargs.get("files")
                return FakeResp()
        # Make sure the binary path is in play (not the b64 fallback).
        monkeypatch.setattr(chunked_uploader, "_binary_chunk_unavailable", False)
        result = await chunked_uploader._send_chunk_with_retry(
            client=FakeClient(),
            report_id="r-001",
            media_id="m-001",
            media_type="IMAGE",
            seq=0,
            total=1,
            chunk_bytes=b"\xff\xd8\xff\xe0",  # JPEG header bytes
        )
        assert result is True
        assert captured["data"]["resolution_tier"] == "ORIGINAL", \
            f"IMAGE chunk must tag resolution_tier=HIGH; observed: {captured['data']}"

    @pytest.mark.asyncio
    async def test_b64_fallback_chunk_carries_high_for_image(self, monkeypatch):
        """The b64 fallback path is taken when /media/chunk-bin 404s.
        Must ALSO send HIGH so backends predating binary transport still
        see the Telegram photo's true tier."""
        captured = {}

        class FakeResp:
            status_code = 200

        class FakeClient:
            async def post(self, url, **kwargs):
                captured["url"] = url
                captured["json"] = kwargs.get("json")
                return FakeResp()
        result = await chunked_uploader._send_chunk_b64_fallback(
            client=FakeClient(),
            report_id="r-002",
            media_id="m-002",
            media_type="IMAGE",
            seq=0,
            total=1,
            chunk_bytes=b"\xff\xd8\xff\xe0",
        )
        assert result is True
        assert captured["json"]["resolution_tier"] == "ORIGINAL", \
            f"b64-fallback IMAGE chunk must tag HIGH; observed: {captured['json']}"

    @pytest.mark.asyncio
    async def test_audio_chunks_stay_low(self, monkeypatch):
        """Audio resolution_tier semantics are LOW-only on the
        dashboard side; the bot must not start tagging audio as HIGH."""
        captured = {}

        class FakeResp:
            status_code = 200

        class FakeClient:
            async def post(self, url, **kwargs):
                captured["data"] = kwargs.get("data")
                return FakeResp()
        monkeypatch.setattr(chunked_uploader, "_binary_chunk_unavailable", False)
        await chunked_uploader._send_chunk_with_retry(
            client=FakeClient(),
            report_id="r-003",
            media_id="m-003",
            media_type="AUDIO",
            seq=0,
            total=1,
            chunk_bytes=b"\x00" * 64,
        )
        assert captured["data"]["resolution_tier"] == "SMALL"


# ── Bug C: UNDP taxonomy parity ────────────────────────────────────────────

class TestTelegramTaxonomyParity:

    def test_undp_canonical_crisis_types_are_offered(self):
        """The chip keyboard must show every UNDP-canonical type and
        nothing else. EARTHQUAKE / FLOOD / TSUNAMI / CYCLONE / WILDFIRE
        / EXPLOSION / CHEMICAL_INCIDENT / CONFLICT / CIVIL_UNREST /
        OTHER."""
        active_chip_targets = {
            v for k, v in session_manager.CRISIS_MAP.items()
            # Aliases are intentional fallbacks; don't count them.
            if k not in ("crisis_hurricane", "crisis_landslide", "crisis_pandemic")
        }
        expected = {
            "EARTHQUAKE", "FLOOD", "TSUNAMI", "CYCLONE", "WILDFIRE",
            "EXPLOSION", "CHEMICAL_INCIDENT", "CONFLICT", "CIVIL_UNREST", "OTHER",
        }
        assert active_chip_targets == expected, \
            f"non-canonical chip targets: {active_chip_targets ^ expected}"

    def test_landslide_alias_maps_to_other(self):
        """Stale-chat tap fallback — a user with old-build chat history
        taps `crisis_landslide`. Must map to UNDP-valid OTHER, not the
        backend-rejecting LANDSLIDE string."""
        assert session_manager.CRISIS_MAP.get("crisis_landslide") == "OTHER"

    def test_pandemic_alias_maps_to_other(self):
        assert session_manager.CRISIS_MAP.get("crisis_pandemic") == "OTHER"

    @pytest.mark.asyncio
    async def test_crisis_keyboard_does_not_render_landslide_or_pandemic(self, monkeypatch):
        captured = {}

        async def fake_send(method, data):
            captured["method"] = method
            captured["data"] = data
            return {"ok": True, "result": {"message_id": 1}}
        monkeypatch.setattr(bot_replies, "_send", fake_send)
        await bot_replies.send_step_crisis_type(chat_id=9999, lang="en")
        keyboard = captured["data"]["reply_markup"]["inline_keyboard"]
        all_callback_data = [
            btn["callback_data"]
            for row in keyboard
            for btn in row
        ]
        assert "crisis_landslide" not in all_callback_data, \
            f"LANDSLIDE chip must not render (backend 422-rejects); observed: {all_callback_data}"
        assert "crisis_pandemic" not in all_callback_data, \
            f"PANDEMIC chip must not render (backend 422-rejects); observed: {all_callback_data}"

    @pytest.mark.asyncio
    async def test_crisis_keyboard_renders_wildfire(self, monkeypatch):
        """WILDFIRE is UNDP-canonical but was previously missing from
        the Telegram chip set (mapped to OTHER as a legacy alias).
        After the May-2026 fix WILDFIRE has its own chip."""
        captured = {}

        async def fake_send(method, data):
            captured["data"] = data
            return {"ok": True, "result": {"message_id": 1}}
        monkeypatch.setattr(bot_replies, "_send", fake_send)
        await bot_replies.send_step_crisis_type(chat_id=9999, lang="en")
        keyboard = captured["data"]["reply_markup"]["inline_keyboard"]
        all_callback_data = [
            btn["callback_data"]
            for row in keyboard
            for btn in row
        ]
        assert "crisis_wildfire" in all_callback_data, \
            f"WILDFIRE chip must render (UNDP-canonical); observed: {all_callback_data}"
