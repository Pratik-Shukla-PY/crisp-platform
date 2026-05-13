"""Persistent consent store for Telegram reporters.

Persists consent grants in a tiny SQLite DB keyed by the Telegram
user_id so a returning reporter never re-sees the consent card. The
in-memory `TelegramSession` instances are lost on bot restart + new
instances every N minutes; without a persistence layer the bot would
re-ask for consent on every `/start`, which gets in the way after the
first session.

Design notes:
  * SQLite on disk — zero external deps, survives bot restarts, trivial
    to back up. File lives next to the bot code by default; override via
    `CRISP_TELEGRAM_CONSENT_DB` env var for test isolation.
  * `user_id` is Telegram's numeric id — stable across restarts, survives
    the user changing their display name / phone number. We hash it the
    same way session.user_hash does for consistency.
  * `granted_at` is UTC ISO 8601. Used for the GDPR delete path + audit.
  * `revoke(user_id)` drops the row so the next `/start` re-prompts.
    Wired to the `/delete` command via the existing session-teardown hook.

Never raises — DB errors degrade to "not granted" so the flow always
falls back to the (safe) consent prompt. This keeps consent collection
robust even if the file is missing / read-only / corrupted.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _db_path() -> str:
    env = os.environ.get("CRISP_TELEGRAM_CONSENT_DB")
    if env:
        return env
    # Default: co-located with the bot module.
    return os.path.join(os.path.dirname(__file__), "telegram_consent.sqlite")


def _conn() -> sqlite3.Connection:
    path = _db_path()
    c = sqlite3.connect(path, timeout=5.0, check_same_thread=False)
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_consent (
            user_id    INTEGER PRIMARY KEY,
            granted_at TEXT NOT NULL,
            lang       TEXT
        )
        """
    )
    return c


def has_consented(user_id: int) -> bool:
    """True iff the reporter has an active consent row on file."""
    try:
        with _conn() as c:
            row = c.execute(
                "SELECT 1 FROM telegram_consent WHERE user_id = ?",
                (int(user_id),),
            ).fetchone()
            return bool(row)
    except Exception as e:
        logger.warning("[consent_store] has_consented error: %s", e)
        return False


def grant(user_id: int, lang: Optional[str] = None) -> None:
    """Record consent. Idempotent — repeated calls refresh granted_at."""
    try:
        with _conn() as c:
            c.execute(
                "INSERT INTO telegram_consent (user_id, granted_at, lang) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET granted_at = excluded.granted_at, lang = excluded.lang",
                (int(user_id), datetime.now(timezone.utc).isoformat(), lang),
            )
            c.commit()
    except Exception as e:
        logger.warning("[consent_store] grant error: %s", e)


def revoke(user_id: int) -> None:
    """Drop the consent row so the next `/start` re-prompts. Wired into the
    existing `/delete` flow so a reporter who hits Delete My Data has to
    re-consent before submitting anything new."""
    try:
        with _conn() as c:
            c.execute("DELETE FROM telegram_consent WHERE user_id = ?", (int(user_id),))
            c.commit()
    except Exception as e:
        logger.warning("[consent_store] revoke error: %s", e)


def get_lang(user_id: int) -> Optional[str]:
    """Return the last language code this user explicitly picked (via the
    lang-picker keyboard), or None when the user has never picked or has
    no consent row yet.

    Added May 2026 (operator-reported) — previously the user's language
    choice was held only in the in-memory `TelegramSession.lang`, which
    means `/start` (which calls `clear_session`) wiped it back to the
    Telegram-locale default. Persisting picks here lets `/start` restore
    the user's last choice instead of reverting to geo-detected.
    """
    try:
        with _conn() as c:
            row = c.execute(
                "SELECT lang FROM telegram_consent WHERE user_id = ?",
                (int(user_id),),
            ).fetchone()
            if row and row[0]:
                return str(row[0])
            return None
    except Exception as e:
        logger.warning("[consent_store] get_lang error: %s", e)
        return None


def set_lang(user_id: int, lang: str) -> None:
    """Persist the user's most recent explicit language pick. Idempotent —
    repeated calls overwrite. Safe to call from the lang-picker callback
    on every tap.

    UPDATE-only on purpose: writing this row would make has_consented()
    return True (it just checks for row existence). The row only gets
    created by `grant()` at consent time, with the user's then-current
    language. Pre-consent language picks live in session.lang only —
    once the user consents, `grant(user_id, session.lang)` persists
    their pick and subsequent set_lang calls update it.
    """
    if not lang:
        return
    try:
        with _conn() as c:
            c.execute(
                "UPDATE telegram_consent SET lang = ? WHERE user_id = ?",
                (lang, int(user_id)),
            )
            c.commit()
    except Exception as e:
        logger.warning("[consent_store] set_lang error: %s", e)
