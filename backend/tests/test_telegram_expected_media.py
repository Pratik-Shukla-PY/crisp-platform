"""K.2.f (May 2026, Phase K) — Telegram session computes
`expected_media` from actual session state, not the legacy hardcoded `2`.

Before this fix, `create_report_early` in
messaging-bot/telegram/session_manager.py:518 hardcoded
`expected_media: 2` based on the assumption that every Telegram
report would carry a photo + audio. Reports with only a photo (the
common case — most users skip the optional voice note) landed with
`expected_media=2, received_media=1` and stayed PARTIAL forever.

Action ④ now promotes such reports at 60 s idle (since photo_group's
SMALL is complete), but the underlying lie in `expected_media=2`
remained in operator-visible state until Action ④ fires.

Fix: `_expected_media = max(1, session.media_count)` — compute from
the actual state at meta-create time. The session's `media_count`
property at session_manager.py:201 sums `image_data_url` +
`audio_data_url` present-ness.

Positive assertions:
  - Session with image only → expected_media == 1
  - Session with image + audio → expected_media == 2
  - Session with audio only → expected_media == 1
  - Session with neither (defensive floor) → expected_media == 1
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_session(*, image: bool, audio: bool):
    """Construct a TelegramSession with the requested media presence."""
    from messaging_bot.telegram.session_manager import TelegramSession

    s = TelegramSession(
        user_hash="TG-K2F-TEST",
        chat_id=12345,
    )
    s.client_report_id = "k2f-test-client-id"
    s.text = "k2f test report"
    s.severity = "MODERATE"
    s.infra_type = "ROAD"
    s.latitude = 12.97
    s.longitude = 77.59
    s.location_name = "Test Location"
    if image:
        s.image_data_url = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    if audio:
        s.audio_data_url = "data:audio/ogg;base64,T2dnUwAAAAA="
    return s


def _captured_meta_json(captured) -> dict:
    """Helper to pull the JSON kwarg out of the captured AsyncMock call."""
    args, kwargs = captured.call_args
    return kwargs.get("json") or (args[1] if len(args) > 1 else {})


# ── K.2.f positive assertions ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_image_only_session_expected_media_is_one():
    """Photo-only Telegram report → expected_media == 1 (was 2 pre-fix)."""
    import messaging_bot.telegram.session_manager as sm

    session = _make_session(image=True, audio=False)

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"id": "fake-report-uuid"}

    with patch("messaging_bot.telegram.session_manager.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await sm.create_report_early(session)

    meta = _captured_meta_json(mock_client.post)
    assert meta["expected_media"] == 1, (
        f"Photo-only session should set expected_media=1, got {meta['expected_media']}"
    )


@pytest.mark.asyncio
async def test_image_plus_audio_session_expected_media_is_two():
    """Photo + audio → expected_media == 2 (unchanged from pre-fix
    behaviour, but now derived from actual count, not hardcoded)."""
    import messaging_bot.telegram.session_manager as sm

    session = _make_session(image=True, audio=True)

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"id": "fake-report-uuid"}

    with patch("messaging_bot.telegram.session_manager.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await sm.create_report_early(session)

    meta = _captured_meta_json(mock_client.post)
    assert meta["expected_media"] == 2


@pytest.mark.asyncio
async def test_audio_only_session_expected_media_is_one():
    """Audio-only Telegram report (rare but possible — voice note + text,
    no photo) → expected_media == 1."""
    import messaging_bot.telegram.session_manager as sm

    session = _make_session(image=False, audio=True)

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"id": "fake-report-uuid"}

    with patch("messaging_bot.telegram.session_manager.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await sm.create_report_early(session)

    meta = _captured_meta_json(mock_client.post)
    assert meta["expected_media"] == 1


@pytest.mark.asyncio
async def test_no_media_session_expected_media_floor_is_one():
    """Defensive floor: if `create_report_early` is somehow reached with
    no media at all, the floor of 1 keeps the row from over-counting
    on subsequent attaches."""
    import messaging_bot.telegram.session_manager as sm

    session = _make_session(image=False, audio=False)
    # Sanity check the property
    assert session.media_count == 0

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"id": "fake-report-uuid"}

    with patch("messaging_bot.telegram.session_manager.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await sm.create_report_early(session)

    meta = _captured_meta_json(mock_client.post)
    assert meta["expected_media"] == 1, (
        f"Defensive floor should be 1, got {meta['expected_media']}"
    )


@pytest.mark.asyncio
async def test_legacy_hardcoded_two_is_no_longer_emitted():
    """Negative-direction sentinel: NO Telegram session should emit
    expected_media=2 unless BOTH image AND audio are present. Pre-fix
    every session emitted 2."""
    import messaging_bot.telegram.session_manager as sm

    session = _make_session(image=True, audio=False)

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"id": "fake-report-uuid"}

    with patch("messaging_bot.telegram.session_manager.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        await sm.create_report_early(session)

    meta = _captured_meta_json(mock_client.post)
    assert meta["expected_media"] != 2, (
        "Photo-only session must not emit the legacy hardcoded 2"
    )
