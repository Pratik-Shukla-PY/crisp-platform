"""Regression: Telegram ↔ PWA reporting-parity rebuild (Phases 2-6).

Locks in the conversational-parity work that brought the Telegram bot in
line with the PWA's V4 capture flow without changing the shared transport:

  Phase 2 — forgiving location: forward-geocode fields on the session;
            debris "Not sure" → NULL (non-blocking, keeps must-have #1).
  Phase 3 — forgiving message ordering: pre-consent buffer slot; capturable
            vs unsupported-media classification; tap-only-step set.
  Phase 4 — multi-photo: first photo is primary, extras (album OR one-by-one)
            cap at 3 total, each its own ORIGINAL Media row; media_count +
            expected_media reflect the real count.
  Phase 5 — pre-submit review card + idempotent submit latch; ✏️ Fix field
            clears that route back to the review gate.
  Phase 6 — session-leak fix (abandoned-report-id reap), shared _is_stale/
            _sweep, and /delete → consent erasure (must-have #10).

All pure-logic / mocked — no live Telegram API, no DB except the consent
store (isolated to a tmp file per test).
"""
from unittest.mock import AsyncMock, patch

import pytest

from messaging_bot.telegram import bot_replies, handlers, session_manager
from messaging_bot.telegram import consent_store
from messaging_bot.telegram.session_manager import TelegramSession


def _mk(**kw) -> TelegramSession:
    s = TelegramSession(user_hash="TG-test", chat_id=1)
    for k, v in kw.items():
        setattr(s, k, v)
    return s


# ── Phase 2 — forgiving location + non-blocking debris ─────────────────────

class TestPhase2Location:

    def test_session_has_geocoding_fields(self):
        s = _mk()
        assert hasattr(s, "geocoding_confidence")
        assert hasattr(s, "geocoding_source")
        assert s.geocoding_confidence is None and s.geocoding_source is None

    def test_debris_na_maps_to_null(self):
        # "Not sure / N/A" must persist as None (NULL), never absent — the
        # field stays capturable for must-have #1 without forcing an answer.
        assert session_manager.DEBRIS_MAP.get("debris_na") is None
        assert session_manager.DEBRIS_MAP.get("debris_yes") is True
        assert session_manager.DEBRIS_MAP.get("debris_no") is False

    def test_forward_geocode_is_coroutine(self):
        import inspect
        assert inspect.iscoroutinefunction(session_manager.forward_geocode)


# ── Phase 3 — forgiving message ordering ───────────────────────────────────

class TestPhase3Ordering:

    def test_pending_message_buffer_slot(self):
        assert _mk().pending_message is None

    def test_capturable_vs_unsupported(self):
        assert handlers._message_has_capturable({"photo": [{"file_id": "f"}]}) is True
        assert handlers._message_has_capturable({"voice": {"file_id": "v"}}) is True
        assert handlers._message_has_capturable({"text": "hello"}) is True
        assert handlers._message_has_capturable({}) is False
        # A sticker / GIF / file-document is "unsupported media" → nudge, not silence.
        # (Telegram sends a populated object; an empty dict is correctly falsy.)
        assert handlers._message_is_unsupported_media({"sticker": {"file_id": "s"}}) is True
        assert handlers._message_is_unsupported_media({"document": {"file_id": "d"}}) is True
        assert handlers._message_is_unsupported_media({"text": "hi"}) is False
        assert handlers._message_is_unsupported_media({"photo": [{"file_id": "f"}]}) is False

    def test_tap_only_steps(self):
        assert handlers._TAP_ONLY_STEPS == {
            "STEP_DAMAGE_CLASS", "STEP_TYPE", "STEP_CRISIS_TYPE", "STEP_DEBRIS"
        }


# ── Phase 4 — multi-photo ──────────────────────────────────────────────────

class TestPhase4MultiPhoto:

    def test_extra_images_default_empty(self):
        assert _mk().extra_images == []

    def test_media_count_counts_primary_extras_audio(self):
        s = _mk()
        assert s.media_count == 0
        s.image_data_url = "data:image/jpeg;base64,A"
        assert s.media_count == 1
        s.extra_images = [{"data_url": "d1", "uploaded": False},
                          {"data_url": "d2", "uploaded": False}]
        assert s.media_count == 3
        s.audio_data_url = "data:audio/ogg;base64,B"
        assert s.media_count == 4

    def test_photo_cap_is_three(self):
        assert handlers._MAX_PHOTOS == 3

    def test_photo_cap_string_present(self):
        assert bot_replies.t("en", "photo_cap")
        assert bot_replies.t("ar", "photo_cap")  # falls back to en, non-empty

    @pytest.mark.asyncio
    async def test_upload_extra_images_skips_uploaded_and_marks(self):
        s = _mk(report_id="r1")
        s.extra_images = [{"data_url": "data:image/jpeg;base64,AAAA", "uploaded": True},
                          {"data_url": "data:image/jpeg;base64,BBBB", "uploaded": False}]
        with patch("messaging_bot.chunked_uploader.upload_media_chunked",
                   new=AsyncMock(return_value=True)) as up:
            ok = await session_manager.upload_extra_images(s)
        assert ok is True
        # Only the not-yet-uploaded one was sent — no double-upload of the first.
        assert up.await_count == 1
        assert all(item["uploaded"] for item in s.extra_images)

    @pytest.mark.asyncio
    async def test_upload_extra_images_noop_without_report(self):
        s = _mk(report_id=None)
        s.extra_images = [{"data_url": "x", "uploaded": False}]
        assert await session_manager.upload_extra_images(s) is False


# ── Phase 5 — review card + idempotent submit latch ────────────────────────

class TestPhase5Review:

    def test_flags_default_false(self):
        s = _mk()
        assert s.reviewed is False and s.submitted is False

    def test_review_summary_renders_all_fields(self):
        s = _mk(crisis_type="EARTHQUAKE", damage_class="COMPLETE",
                type_answered=True, infra_type="RESIDENTIAL",
                infra_name="Maple School", latitude=12.9716, longitude=77.5946,
                location_name="Koramangala", debris_answered=True, debris_needed=True,
                image_data_url="data:image/jpeg;base64,A", audio_data_url="data:audio/ogg;base64,B",
                text="wall down")
        s.extra_images = [{"data_url": "d", "uploaded": False}]
        body = handlers._review_summary(s)
        for token in ("EARTHQUAKE", "COMPLETE", "RESIDENTIAL", "Maple School",
                      "Koramangala", "2×📸", "🎤", "📝"):
            assert token in body, f"missing {token!r}"

    def test_review_summary_degrades_when_empty(self):
        body = handlers._review_summary(_mk())
        assert bot_replies.t("en", "review_evidence") in body
        assert bot_replies.t("en", "review_none") in body

    def test_fix_fields_clear_and_map_to_steps(self):
        mapping = handlers._FIX_FIELDS
        assert set(mapping) == {"location", "damage", "type", "crisis", "building", "debris"}
        s = _mk(latitude=1.0, longitude=2.0, location_name="x", damage_class="COMPLETE",
                severity_answered=True, type_answered=True, infra_type="RESIDENTIAL",
                crisis_type="FLOOD", infra_name="y", infra_name_answered=True,
                debris_answered=True, debris_needed=True)
        clr, step = mapping["location"]; clr(s)
        assert s.latitude is None and s.longitude is None and s.location_name == "" and step == "STEP_LOCATION"
        clr, step = mapping["damage"]; clr(s)
        assert s.damage_class == "" and s.severity_answered is False and step == "STEP_DAMAGE_CLASS"
        clr, step = mapping["type"]; clr(s)
        assert s.type_answered is False and s.infra_type == "OTHER" and step == "STEP_TYPE"
        clr, step = mapping["crisis"]; clr(s)
        assert s.crisis_type == "" and step == "STEP_CRISIS_TYPE"
        clr, step = mapping["building"]; clr(s)
        assert s.infra_name == "" and s.infra_name_answered is False and step == "STEP_BUILDING_NAME"
        clr, step = mapping["debris"]; clr(s)
        assert s.debris_answered is False and s.debris_needed is False and step == "STEP_DEBRIS"

    def test_review_builders_exist(self):
        import inspect
        assert inspect.iscoroutinefunction(bot_replies.send_review_card)
        assert inspect.iscoroutinefunction(bot_replies.send_review_fix_menu)
        for k in ("review_title", "review_send", "review_fix", "review_fix_back"):
            assert bot_replies.t("en", k)


# ── Phase 6 — session leak fix + /delete erasure ───────────────────────────

class TestPhase6Lifecycle:

    NOW = 1_000_000.0

    def _aged(self, *, state="STEP_TYPE", report_id="r1", age_h=0.0, idle_h=0.0):
        s = _mk(state=state, report_id=report_id)
        s.created_at = self.NOW - age_h * 3600
        s.last_activity = self.NOW - idle_h * 3600
        return s

    def test_is_stale_done_over_24h(self):
        assert session_manager._is_stale(self._aged(state="DONE", age_h=25), self.NOW) is True
        assert session_manager._is_stale(self._aged(state="DONE", age_h=10), self.NOW) is False

    def test_is_stale_reportless_over_2h(self):
        assert session_manager._is_stale(self._aged(report_id="", age_h=3), self.NOW) is True
        assert session_manager._is_stale(self._aged(report_id="", age_h=1), self.NOW) is False

    def test_is_stale_abandoned_report_id_over_12h(self):
        # The previously-leaking case: report created early, abandoned mid-flow.
        assert session_manager._is_stale(self._aged(report_id="r1", idle_h=13), self.NOW) is True
        assert session_manager._is_stale(self._aged(report_id="r1", idle_h=3), self.NOW) is False

    def test_sweep_drops_only_stale(self):
        session_manager._sessions.clear()
        session_manager._sessions["a"] = self._aged(state="DONE", age_h=25)
        session_manager._sessions["b"] = self._aged(report_id="r1", idle_h=13)
        session_manager._sessions["c"] = self._aged(report_id="r1", idle_h=1)
        removed = session_manager._sweep(self.NOW)
        assert removed == 2 and sorted(session_manager._sessions) == ["c"]
        session_manager._sessions.clear()

    def test_cleanup_keeps_real_fresh_session(self):
        session_manager._sessions.clear()
        fresh = _mk(report_id="r1")  # created_at/last_activity = real now
        session_manager._sessions["fresh"] = fresh
        assert session_manager.cleanup_stale_sessions() == 0
        assert "fresh" in session_manager._sessions
        session_manager._sessions.clear()

    def test_sweep_is_throttled(self):
        assert session_manager._SWEEP_INTERVAL_SEC >= 60

    def test_delete_revokes_consent(self, tmp_path, monkeypatch):
        # /delete → consent erasure (right to erasure, must-have #10).
        monkeypatch.setenv("CRISP_TELEGRAM_CONSENT_DB", str(tmp_path / "c.sqlite"))
        consent_store.grant(424242, "fr")
        assert consent_store.has_consented(424242) is True
        assert consent_store.get_lang(424242) == "fr"
        consent_store.revoke(424242)
        assert consent_store.has_consented(424242) is False
        assert consent_store.get_lang(424242) is None

    def test_deleted_ack_string_present(self):
        assert bot_replies.t("en", "deleted_ack")
