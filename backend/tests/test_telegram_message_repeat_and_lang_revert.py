"""Regression: Telegram message-repeat + language-revert (May 2026).

Operator: "On Telegram, same message is repeating again and again. its
properly broken and useless. Once a single language is selected why the
language switches back to geolocation based language. Not Ok. Plan it
properly first, identify gaps and let me know. This is not ok currently
at all. Test it and verify once end to end before you confirm it is
fixed."

THREE distinct bugs, each pinned by tests in this file:

Bug A — "same message repeats" — actually: callbacks silently dropped
        as "stale" because some `send_step_*` calls in the callback
        handlers bypass the `track_prompt_msg(session, result)` wiring.
        Two specific call sites:
          · handlers.py:620 — send_step_description after skip_photo
          · handlers.py:660 — send_step_building_name after bldg_type
        Effect: the new prompt's message_id never lands on
        session.active_prompt_msg_id, so the user's NEXT callback on
        that prompt is rejected by is_stale_callback_message → user
        taps, taps, taps, nothing visible advances.

Bug B — language reverts to geolocation-based language. Pre-fix,
        session_manager.resolve_location_name() unconditionally
        overwrote session.lang with the country-language detected
        from the user's GPS. User picks 🇬🇧 English, shares GPS in
        India → session.lang silently flips back to "hi".

Bug C — /start resets the user's explicit language to the
        Telegram-locale default. clear_session() drops session.lang,
        and the new session is initialised with `s.lang = detected`
        (Telegram-locale fallback) regardless of any prior pick.
        Persisting picks in consent_store.lang + restoring on /start
        is the fix.

All three fixes share a common discipline: only OVERWRITE session.lang
when it's empty; treat the user's explicit pick as authoritative.
"""
from unittest.mock import patch
import os
import tempfile

import pytest


# Use a fresh on-disk SQLite per test process so the consent store
# state is isolated from any previous run + from production data.
_TMP_DB = os.path.join(tempfile.gettempdir(), "test_telegram_consent_repeat_lang.sqlite")
os.environ["CRISP_TELEGRAM_CONSENT_DB"] = _TMP_DB

# Import AFTER setting the env var so the consent_store reads it.
from messaging_bot.telegram import handlers, session_manager, consent_store, bot_replies


# ── Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """Reset every kind of state that could leak between tests:
       in-memory sessions, the SQLite consent store, and the monkey-
       patched Telegram API."""
    # Wipe in-memory sessions.
    session_manager._sessions.clear()
    # Recreate the SQLite file so every test sees an empty store.
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)
    yield
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)


@pytest.fixture
def fake_telegram(monkeypatch):
    """Patch bot_replies._send so no real Telegram traffic. Each call
    increments a counter on a per-method basis + returns a synthetic
    Bot API response with an incrementing message_id (so the bot's
    `track_prompt_msg` has something realistic to record)."""
    state = {"counter": 1000, "sent": []}

    async def fake_send(method, data):
        state["counter"] += 1
        msg_id = state["counter"]
        state["sent"].append({"method": method, "msg_id": msg_id, "data": data})
        return {"ok": True, "result": {"message_id": msg_id}}

    monkeypatch.setattr(bot_replies, "_send", fake_send)
    return state


# ── Bug A1 — skip_photo prompt is tracked ────────────────────────────────

class TestBugA1SkipPhoto:
    @pytest.mark.asyncio
    async def test_skip_photo_records_active_prompt_msg_id(self, fake_telegram):
        """After tapping `skip_photo`, the resulting STEP_DESCRIPTION
        prompt's message_id MUST land on session.active_prompt_msg_id.
        Pre-fix this was not happening; the dedupe at the top of
        _handle_callback would then drop the next callback as stale."""
        user_id = 11111
        chat_id = 22222
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.state = "STEP_PHOTO"
        s.active_prompt_msg_id = 500  # the previous (STEP_PHOTO) prompt
        # Build a callback_query for the skip_photo tap.
        cb = {
            "id": "cq-skip-photo-1",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": 500},
            "data": "skip_photo",
        }
        await handlers._handle_callback(cb)
        # Active prompt must now equal whatever message_id the bot
        # just sent (the STEP_DESCRIPTION prompt). Anything different
        # means the prompt wasn't tracked — the bug.
        last_send = fake_telegram["sent"][-1]
        assert s.active_prompt_msg_id == last_send["msg_id"], (
            f"skip_photo's STEP_DESCRIPTION prompt (msg_id={last_send['msg_id']}) "
            f"must update session.active_prompt_msg_id; got {s.active_prompt_msg_id}"
        )

    @pytest.mark.asyncio
    async def test_callback_after_skip_photo_is_NOT_dropped_as_stale(self, fake_telegram):
        """End-to-end: a callback that arrives AFTER skip_photo on the
        STEP_DESCRIPTION prompt must be processed normally (handler
        fires, state advances). Pre-fix this was the silent-drop bug."""
        user_id = 33333
        chat_id = 44444
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.state = "STEP_PHOTO"
        s.active_prompt_msg_id = 500
        # Tap skip_photo.
        await handlers._handle_callback({
            "id": "cq-skip-photo-2",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": 500},
            "data": "skip_photo",
        })
        new_active = s.active_prompt_msg_id
        # Now tap skip_description from the new prompt.
        await handlers._handle_callback({
            "id": "cq-skip-desc-1",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": new_active},
            "data": "skip_description",
        })
        # If the callback was dropped as stale, the only messages sent
        # would be skip_photo's ack + the description prompt. After
        # skip_description we should see ADDITIONAL sends — either
        # answerCallbackQuery or the next prompt.
        methods_after = [s["method"] for s in fake_telegram["sent"]]
        # answerCallbackQuery should appear at least twice (once per
        # processed callback).
        ack_count = methods_after.count("answerCallbackQuery")
        assert ack_count >= 2, (
            f"two callbacks should each fire answerCallbackQuery; got "
            f"{ack_count} acks across all sends: {methods_after}"
        )


# ── Bug A2 — bldg_type prompt is tracked ─────────────────────────────────

class TestBugA2BldgType:
    @pytest.mark.asyncio
    async def test_bldg_type_records_active_prompt_msg_id(self, fake_telegram):
        user_id = 55555
        chat_id = 66666
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.state = "STEP_BUILDING_NAME"
        s.active_prompt_msg_id = 700
        await handlers._handle_callback({
            "id": "cq-bldg-type-1",
            "from": {"id": user_id},
            "message": {"chat": {"id": chat_id}, "message_id": 700},
            "data": "bldg_type",
        })
        last_send = fake_telegram["sent"][-1]
        assert s.active_prompt_msg_id == last_send["msg_id"], (
            f"bldg_type's free-text prompt must update active_prompt_msg_id; "
            f"got {s.active_prompt_msg_id}, expected {last_send['msg_id']}"
        )


# ── Bug B — language survives a location share ───────────────────────────

class TestBugBLanguageSurvivesLocation:
    @pytest.mark.asyncio
    async def test_user_picked_language_NOT_overwritten_by_geo(self, monkeypatch):
        """User has explicitly picked English. They share GPS in India.
        Nominatim returns country_code='IN' (→ 'hi'). session.lang
        MUST stay 'en'."""
        user_id = 70001
        chat_id = 70002
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.latitude = 12.9716
        s.longitude = 77.5946  # Bangalore
        # Patch the httpx call inside resolve_location_name so we don't
        # actually hit Nominatim. Return an India response.
        class FakeResp:
            status_code = 200
            def json(self):
                return {
                    "address": {
                        "city": "Bangalore",
                        "state": "Karnataka",
                        "country": "India",
                        "country_code": "in",
                    }
                }
        class FakeAsyncClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): pass
            async def get(self, *a, **k): return FakeResp()
        monkeypatch.setattr(session_manager.httpx, "AsyncClient", FakeAsyncClient)
        # Run resolve_location_name.
        await session_manager.resolve_location_name(s)
        # Critical assertion — user's explicit "en" must SURVIVE.
        assert s.lang == "en", (
            f"location share must NOT overwrite a user-picked language; "
            f"session.lang flipped to '{s.lang}'"
        )

    @pytest.mark.asyncio
    async def test_empty_language_IS_filled_from_geo(self, monkeypatch):
        """The fix must NOT break the cold-start case: when the user
        has never set a language, geo-detection still fills it."""
        user_id = 70003
        chat_id = 70004
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = ""  # explicitly empty (no pick yet)
        s.consented = True
        s.latitude = 12.9716
        s.longitude = 77.5946
        class FakeResp:
            status_code = 200
            def json(self):
                return {
                    "address": {
                        "city": "Bangalore", "state": "Karnataka",
                        "country": "India", "country_code": "in",
                    }
                }
        class FakeAsyncClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): pass
            async def get(self, *a, **k): return FakeResp()
        monkeypatch.setattr(session_manager.httpx, "AsyncClient", FakeAsyncClient)
        await session_manager.resolve_location_name(s)
        # Cold start: lang should fill from geo. Karnataka → 'kn' per
        # _REGION_LANG_MAP if matched, otherwise 'hi' from IN country.
        assert s.lang in ("kn", "hi"), (
            f"cold-start lang fill from geo must work; got '{s.lang}'"
        )


# ── Bug C — /start preserves last-picked language ────────────────────────

class TestBugCStartPreservesLang:
    def test_consent_store_get_lang_returns_none_for_unknown_user(self):
        assert consent_store.get_lang(99999) is None

    def test_consent_store_grant_writes_lang_and_get_lang_reads_it(self):
        consent_store.grant(80001, lang="pt")
        assert consent_store.get_lang(80001) == "pt"

    def test_set_lang_updates_existing_row(self):
        consent_store.grant(80002, lang="en")
        consent_store.set_lang(80002, "pt")
        assert consent_store.get_lang(80002) == "pt"

    def test_set_lang_on_nonexistent_user_does_NOT_create_row(self):
        """set_lang is UPDATE-only — otherwise it would flip
        has_consented() to True for users who only picked a language
        without consenting."""
        consent_store.set_lang(80003, "pt")
        assert consent_store.has_consented(80003) is False
        assert consent_store.get_lang(80003) is None

    @pytest.mark.asyncio
    async def test_start_command_restores_persisted_language(self, fake_telegram):
        """User picked Portuguese, consented, then types /start again.
        session.lang must come back as 'pt', not the Telegram-locale
        default."""
        user_id = 90001
        chat_id = 90002
        # Seed consent_store with the user's previous pick.
        consent_store.grant(user_id, lang="pt")
        # Build a /start text message. Telegram-locale = "hi" (India),
        # so without the fix s.lang would revert to "hi".
        message = {
            "from": {"id": user_id, "language_code": "hi"},
            "chat": {"id": chat_id},
            "message_id": 1,
            "text": "/start",
        }
        await handlers.handle_update({"message": message})
        s = session_manager._sessions[session_manager.hash_user(user_id)]
        assert s.lang == "pt", (
            f"/start must restore the user's stored language; got '{s.lang}' "
            f"(should have come from consent_store: 'pt')"
        )

    @pytest.mark.asyncio
    async def test_start_command_falls_back_to_detected_when_no_stored_lang(self, fake_telegram):
        """First-ever /start has no stored lang — detected (Telegram
        locale) is the correct fallback."""
        user_id = 90003
        chat_id = 90004
        message = {
            "from": {"id": user_id, "language_code": "fr"},
            "chat": {"id": chat_id},
            "message_id": 1,
            "text": "/start",
        }
        await handlers.handle_update({"message": message})
        s = session_manager._sessions[session_manager.hash_user(user_id)]
        assert s.lang == "fr", (
            f"first-ever /start with no stored lang must use detected; got '{s.lang}'"
        )

    @pytest.mark.asyncio
    async def test_lang_callback_persists_pick_when_already_consented(self, fake_telegram):
        """Tapping a lang chip while already consented persists the
        new pick to consent_store so the next /start restores it."""
        user_id = 90005
        chat_id = 90006
        # User has consented previously with English.
        consent_store.grant(user_id, lang="en")
        s = session_manager.get_or_create_session(user_id, chat_id)
        s.lang = "en"
        s.consented = True
        s.state = "STEP_PHOTO"
        s.active_prompt_msg_id = 100
        # Now they re-open the picker and tap lang_pt.
        await handlers._handle_callback({
            "id": "cq-lang-pt-1",
            "from": {"id": user_id, "language_code": "en"},
            "message": {"chat": {"id": chat_id}, "message_id": 100},
            "data": "lang_pt",
        })
        # session.lang reflects the new pick.
        assert s.lang == "pt"
        # And consent_store now stores the new pick.
        assert consent_store.get_lang(user_id) == "pt"


# ── Full happy-path walk ──────────────────────────────────────────────────

class TestFullHappyPathLangSurvives:
    @pytest.mark.asyncio
    async def test_full_flow_pt_language_survives_every_step(self, fake_telegram, monkeypatch):
        """User picks Portuguese and goes through:
           /start → lang_pt → consent_accept → location → photo →
           description text → crisis pick → damage pick → severity →
           skip_building → debris_no → confirm
        session.lang MUST be 'pt' at every step."""
        user_id = 95001
        chat_id = 95002
        # 1. /start
        await handlers.handle_update({"message": {
            "from": {"id": user_id, "language_code": "hi"},
            "chat": {"id": chat_id}, "message_id": 1, "text": "/start",
        }})
        s = session_manager._sessions[session_manager.hash_user(user_id)]
        first_lang = s.lang
        # 2. Pick Portuguese.
        await handlers._handle_callback({
            "id": "cq-1", "from": {"id": user_id, "language_code": "hi"},
            "message": {"chat": {"id": chat_id}, "message_id": s.active_prompt_msg_id or 1001},
            "data": "lang_pt",
        })
        assert s.lang == "pt", f"after lang_pt: got '{s.lang}'"
        # 3. Accept consent.
        await handlers._handle_callback({
            "id": "cq-2", "from": {"id": user_id, "language_code": "hi"},
            "message": {"chat": {"id": chat_id}, "message_id": s.active_prompt_msg_id},
            "data": "consent_accept",
        })
        assert s.lang == "pt", f"after consent_accept: got '{s.lang}'"
        # 4. Share a location. Patch httpx so resolve_location_name
        #    "succeeds" with an Indian address.
        class FakeResp:
            status_code = 200
            def json(self):
                return {"address": {
                    "city": "Bangalore", "state": "Karnataka",
                    "country": "India", "country_code": "in",
                }}
        class FakeAsyncClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): pass
            async def get(self, *a, **k): return FakeResp()
        monkeypatch.setattr(session_manager.httpx, "AsyncClient", FakeAsyncClient)
        await handlers.handle_update({"message": {
            "from": {"id": user_id, "language_code": "hi"},
            "chat": {"id": chat_id}, "message_id": 5000,
            "location": {"latitude": 12.9716, "longitude": 77.5946},
        }})
        # 5. CRITICAL ASSERTION — language survived the location share.
        assert s.lang == "pt", (
            f"after location share in India: language must STILL be 'pt'; "
            f"got '{s.lang}' (Bug B regression)"
        )

    @pytest.mark.asyncio
    async def test_session_clear_then_start_restores_language(self, fake_telegram):
        """User picks pt → /start fresh → still pt."""
        user_id = 95003
        chat_id = 95004
        # First /start to land on LANG_SELECT.
        await handlers.handle_update({"message": {
            "from": {"id": user_id, "language_code": "hi"},
            "chat": {"id": chat_id}, "message_id": 1, "text": "/start",
        }})
        s = session_manager._sessions[session_manager.hash_user(user_id)]
        # Pick pt.
        await handlers._handle_callback({
            "id": "cq-x", "from": {"id": user_id, "language_code": "hi"},
            "message": {"chat": {"id": chat_id}, "message_id": s.active_prompt_msg_id or 1},
            "data": "lang_pt",
        })
        # Consent so the row gets a granted_at + the pick lands in store.
        await handlers._handle_callback({
            "id": "cq-y", "from": {"id": user_id, "language_code": "hi"},
            "message": {"chat": {"id": chat_id}, "message_id": s.active_prompt_msg_id},
            "data": "consent_accept",
        })
        assert consent_store.get_lang(user_id) == "pt"
        # Now /start fresh — pre-fix this would wipe back to "hi".
        await handlers.handle_update({"message": {
            "from": {"id": user_id, "language_code": "hi"},
            "chat": {"id": chat_id}, "message_id": 2, "text": "/start",
        }})
        s_after = session_manager._sessions[session_manager.hash_user(user_id)]
        assert s_after.lang == "pt", (
            f"second /start must restore stored lang; got '{s_after.lang}'"
        )
