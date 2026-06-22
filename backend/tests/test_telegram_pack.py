"""Telegram bot - UNDP crisis-pack conversational flow (integration).

Drives the real handler state machine (handle_update / _handle_callback) with the
network boundaries mocked, and asserts:
  * with an active pack the bot enters STEP_PACK and collects the 3 UNDP answers
    via the ps:/ps_done: inline-keyboard callbacks;
  * an "Other" selection triggers the free-text follow-up stored under
    pressing_needs_other;
  * the report is DEFERRED until the pack is complete, then created once with
    form_pack_id / form_pack_version / form_data attached;
  * the no-pack path creates the report WITHOUT any pack fields (regression).
"""
import asyncio

import pytest

from messaging_bot.telegram import handlers
from messaging_bot.telegram import session_manager as sm
from messaging_bot.pack_questions import iter_askable_fields
from app.services.undp_pack import UNDP_CORE_SCHEMA, UNDP_PACK_KEY


def _run(coro):
    return asyncio.run(coro)


def _schema():
    s = dict(UNDP_CORE_SCHEMA)
    s["key"] = UNDP_PACK_KEY
    return s


@pytest.fixture
def patched(monkeypatch):
    """Mock every network/IO boundary the handlers touch; capture what
    create_report_early WOULD send (it reads the pack off the session)."""
    captured = {"create_meta": None, "finalized": False}

    async def fake_create(session):
        session.report_id = "rpt-telegram-1"
        captured["create_meta"] = {
            "form_pack_id": session.form_pack_id,
            "form_pack_version": session.form_pack_version,
            "form_data": dict(session.pack_answers),
            "crisis_type": session.crisis_type,
            "damage_class": session.damage_class,
        }

    async def anoop(*a, **k):
        return None

    async def fake_send(*a, **k):
        return {"ok": True, "result": {"message_id": 100}}

    async def fake_finalize(session):
        captured["finalized"] = True

    monkeypatch.setattr(handlers, "create_report_early", fake_create)
    monkeypatch.setattr(handlers, "update_report_metadata", anoop)
    monkeypatch.setattr(handlers, "_finalize", fake_finalize)
    monkeypatch.setattr(handlers, "resolve_location_name", anoop)
    monkeypatch.setattr(handlers, "update_report_location", anoop)
    # sends + acks
    for name in ("send_pack_question", "send_pack_other_prompt", "answer_callback",
                 "edit_reply_markup_clear", "send_text", "_prompt_for_step"):
        monkeypatch.setattr(handlers, name, fake_send)
    monkeypatch.setattr(handlers, "track_prompt_msg", lambda *a, **k: None)
    monkeypatch.setattr(handlers, "_fire_upload", lambda *a, **k: None)
    monkeypatch.setattr(handlers, "is_stale_callback_message", lambda *a, **k: False)
    monkeypatch.setattr(handlers, "is_duplicate_callback", lambda *a, **k: False)
    return captured


def _seed_session(active_pack: bool):
    """A session that has already passed location + the classify chips and (if
    active_pack) resolved the UNDP pack, sitting at the pack stage."""
    s = sm.get_or_create_session(424242, 424242)
    s.consented = True
    s.state = "STEP_PHOTO"   # past the START/consent gate, in the data-collecting flow
    s.lang = "en"
    s.latitude, s.longitude = 12.97, 77.59
    s.location_name = "Test Zone"
    s.damage_class = "PARTIAL"
    s.type_answered = True
    s.infra_type = "RESIDENTIAL"
    s.crisis_type = "FLOOD"
    s.infra_name_answered = True
    s.debris_answered = True
    s.debris_needed = True
    s.text = "wall collapsed"
    s.active_prompt_msg_id = 100
    s.pack_resolved = True
    if active_pack:
        s.form_pack_id = UNDP_PACK_KEY
        s.form_pack_version = 1
        s.pack_schema = _schema()
        s.pack_fields = iter_askable_fields(_schema(), "TELEGRAM")
    return s


def _cb(data, msg_id=100, cq="cq-x"):
    return {"id": cq, "from": {"id": 424242, "language_code": "en"},
            "message": {"message_id": msg_id, "chat": {"id": 424242}}, "data": data}


def _msg(text):
    return {"message": {"chat": {"id": 424242}, "from": {"id": 424242, "language_code": "en"},
                        "text": text}}


def test_active_pack_collects_three_answers_and_attaches_to_create(patched, monkeypatch):
    sm._sessions.clear()
    s = _seed_session(active_pack=True)
    assert [f["key"] for f in s.pack_fields] == [
        "electricity_condition", "health_services_status", "pressing_needs"]

    # Q1 electricity: pick option 1 (SEVERE-ish), then Done.
    _run(handlers._handle_callback(_cb("ps:0:1", cq="c1")))
    assert s.pack_partial == [s.pack_fields[0]["options"][1]["value"]]
    _run(handlers._handle_callback(_cb("ps_done:0", cq="c2")))
    assert s.pack_index == 1
    assert s.pack_answers["electricity_condition"] == [s.pack_fields[0]["options"][1]["value"]]

    # Q2 health: pick option 0, Done.
    _run(handlers._handle_callback(_cb("ps:1:0", cq="c3")))
    _run(handlers._handle_callback(_cb("ps_done:1", cq="c4")))
    assert s.pack_index == 2

    # Q3 pressing-needs: pick FOOD_WATER + OTHER, Done → triggers the Other prompt.
    needs = s.pack_fields[2]
    food_idx = next(i for i, o in enumerate(needs["options"]) if o["value"] == "FOOD_WATER")
    other_idx = next(i for i, o in enumerate(needs["options"]) if o["value"] == "OTHER")
    _run(handlers._handle_callback(_cb(f"ps:2:{food_idx}", cq="c5")))
    _run(handlers._handle_callback(_cb(f"ps:2:{other_idx}", cq="c6")))
    _run(handlers._handle_callback(_cb("ps_done:2", cq="c7")))
    # waiting on the free-text "Other" - not yet complete, not yet created
    assert s.pack_awaiting_other == "pressing_needs_other"
    assert s.report_id is None
    assert patched["create_meta"] is None

    # The free-text reply completes the pack → deferred create fires WITH the pack.
    _run(handlers.handle_update(_msg("fuel for generators")))
    assert s.pack_awaiting_other is None
    assert s.pack_index == 3
    assert s.report_id == "rpt-telegram-1"
    meta = patched["create_meta"]
    assert meta["form_pack_id"] == UNDP_PACK_KEY
    assert meta["form_pack_version"] == 1
    fd = meta["form_data"]
    assert set(fd) == {"electricity_condition", "health_services_status",
                       "pressing_needs", "pressing_needs_other"}
    assert "OTHER" in fd["pressing_needs"] and "FOOD_WATER" in fd["pressing_needs"]
    assert fd["pressing_needs_other"] == "fuel for generators"
    # classify fields survive the deferral (flushed after create)
    assert meta["crisis_type"] == "FLOOD" and meta["damage_class"] == "PARTIAL"


def test_no_pack_creates_report_without_pack_fields(patched):
    sm._sessions.clear()
    s = _seed_session(active_pack=False)   # pack_fields empty
    assert s.pack_active is False and s.pack_complete is True
    # a text message with location + evidence already present → create fires now
    _run(handlers.handle_update(_msg("more detail")))
    assert s.report_id == "rpt-telegram-1"
    meta = patched["create_meta"]
    assert meta["form_pack_id"] is None
    assert meta["form_data"] == {}
