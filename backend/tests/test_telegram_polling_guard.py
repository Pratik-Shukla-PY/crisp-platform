"""Regression — a non-production backend must NOT auto-start Telegram polling.

Incident (Jun 2026): a Telegram bot allows exactly ONE active getUpdates poll
per token. Local/dev .env files carry the SAME prod bot token, so a dev backend
that auto-started polling on boot stole the prod poll slot — Telegram answered
prod's getUpdates with 409 Conflict and the live Telegram channel went silent
(no messages → no reports) until the dev process stopped. This pins the boot
guard so only the production deployment polls.
"""
from app.main import _should_autostart_telegram_polling as should_poll


def test_production_polls_by_default():
    assert should_poll("production", "") is True


def test_dev_does_not_poll():
    assert should_poll("dev", "") is False


def test_unknown_env_does_not_poll():
    assert should_poll("staging", "") is False


def test_flag_forces_on_even_in_dev():
    # A single operator with a DEDICATED token may opt in explicitly.
    assert should_poll("dev", "1") is True


def test_flag_forces_off_even_in_prod():
    assert should_poll("production", "0") is False


def test_flag_whitespace_is_tolerated():
    assert should_poll("dev", " 1 ") is True
    assert should_poll("production", " 0 ") is False
