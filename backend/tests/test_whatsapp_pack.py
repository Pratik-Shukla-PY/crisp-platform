"""WhatsApp bot - UNDP crisis-pack conversational flow (integration).

Drives the real handler logic (_handle_text → _advance_flow) with the network
mocked, asserting the numbered multi-select UX collects the 3 UNDP answers, the
"Other" free-text follow-up works, the submit is gated until the pack is complete,
and submit_report sends form_pack_id / form_pack_version / form_data. No-pack path
submits without any pack fields.
"""
import asyncio

import pytest

from messaging_bot.whatsapp import handlers
from messaging_bot.whatsapp import session_manager as sm
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
    captured = {"meta": None}

    async def fake_submit(session):
        captured["meta"] = {
            "form_pack_id": session.form_pack_id,
            "form_pack_version": session.form_pack_version,
            "form_data": dict(session.pack_answers),
            "crisis_type": session.crisis_type,
        }
        return "rpt-wa-1"

    async def anoop(*a, **k):
        return None

    monkeypatch.setattr(handlers, "submit_report", fake_submit)
    monkeypatch.setattr(handlers, "send_text", anoop)
    monkeypatch.setattr(handlers, "send_confirmation", anoop)
    monkeypatch.setattr(handlers, "send_welcome", anoop)
    monkeypatch.setattr(handlers, "send_severity_prompt", anoop)
    monkeypatch.setattr(handlers, "send_type_prompt", anoop)
    monkeypatch.setattr(handlers, "send_location_request", anoop)
    monkeypatch.setattr(handlers, "send_received_ack", anoop)
    monkeypatch.setattr(handlers, "clear_session", lambda *a, **k: None)
    return captured


def _seed(active_pack: bool):
    sm._sessions.clear()
    s = sm.get_or_create_session("+15551234567")
    s.state = "COLLECTING"
    s.lang = "en"
    s.text = "building damaged"
    s.severity = "SEVERE"
    s.infra_type = "RESIDENTIAL"
    s.crisis_type = "FLOOD"
    s.damage_class = "PARTIAL"
    s.latitude, s.longitude = 12.97, 77.59
    s.message_ids = {"m1", "m2"}
    s.pack_resolved = True
    if active_pack:
        s.form_pack_id = UNDP_PACK_KEY
        s.form_pack_version = 1
        s.pack_schema = _schema()
        s.pack_fields = iter_askable_fields(_schema(), "WHATSAPP")
    return s


def _txt(body):
    return {"text": {"body": body}}


async def _reply(session, body):
    await handlers._handle_text(session, _txt(body))
    await handlers._advance_flow(session)


def test_active_pack_numbered_replies_collect_and_submit(patched):
    s = _seed(active_pack=True)
    # Entering the flow asks the first pack question (electricity).
    _run(handlers._advance_flow(s))
    assert s.state == "AWAITING_PACK" and s.pack_index == 0

    # Q1 electricity: pick option 2, then 0/done.
    _run(_reply(s, "2"))
    assert s.pack_partial == [s.pack_fields[0]["options"][1]["value"]]
    _run(_reply(s, "0"))
    assert s.pack_index == 1
    assert s.pack_answers["electricity_condition"] == [s.pack_fields[0]["options"][1]["value"]]

    # Q2 health: pick 1, done.
    _run(_reply(s, "1"))
    _run(_reply(s, "0"))
    assert s.pack_index == 2

    # Q3 pressing-needs: pick FOOD_WATER + OTHER (by their 1-based numbers), done.
    needs = s.pack_fields[2]
    food_n = next(i for i, o in enumerate(needs["options"], 1) if o["value"] == "FOOD_WATER")
    other_n = next(i for i, o in enumerate(needs["options"], 1) if o["value"] == "OTHER")
    _run(_reply(s, f"{food_n} {other_n}"))
    assert set(s.pack_partial) == {"FOOD_WATER", "OTHER"}
    _run(_reply(s, "0"))
    # OTHER picked → awaiting free-text, not yet submitted
    assert s.pack_awaiting_other == "pressing_needs_other"
    assert patched["meta"] is None

    # Free-text completes the pack → submit fires WITH the pack attached.
    _run(_reply(s, "fuel for generators"))
    assert s.pack_complete is True
    meta = patched["meta"]
    assert meta is not None
    assert meta["form_pack_id"] == UNDP_PACK_KEY and meta["form_pack_version"] == 1
    fd = meta["form_data"]
    assert set(fd) == {"electricity_condition", "health_services_status",
                       "pressing_needs", "pressing_needs_other"}
    assert "OTHER" in fd["pressing_needs"] and "FOOD_WATER" in fd["pressing_needs"]
    assert fd["pressing_needs_other"] == "fuel for generators"
    assert meta["crisis_type"] == "FLOOD"


def test_no_pack_submits_without_pack_fields(patched):
    s = _seed(active_pack=False)
    assert s.pack_active is False and s.is_complete is True
    _run(handlers._advance_flow(s))
    meta = patched["meta"]
    assert meta is not None
    assert meta["form_pack_id"] is None and meta["form_data"] == {}


def test_toggle_deselect_then_reselect(patched):
    s = _seed(active_pack=True)
    _run(handlers._advance_flow(s))
    val0 = s.pack_fields[0]["options"][0]["value"]
    _run(_reply(s, "1"))           # select option 1
    assert val0 in s.pack_partial
    _run(_reply(s, "1"))           # toggle it off
    assert val0 not in s.pack_partial
