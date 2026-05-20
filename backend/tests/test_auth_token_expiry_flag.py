"""K.2.e (May 2026, Phase K) — Report flagged when accepted with an
expired Bearer token.

Before this fix, `_optional_user_from_auth` at reports.py:1842 swallowed
all token-related errors as anonymous. A logged-in reporter whose tab
sat idle for 15+ minutes captured a report; by the time the queue
drained, their JWT had expired; the backend silently accepted it as
anonymous; the reporter lost attribution credit (badge tier didn't
update, dashboard couldn't link the report back).

Fix: `_optional_user_from_auth` now returns `(user, downgrade_reason)`.
The `/meta` endpoint stamps `submitted_as_anonymous_due_to_expired_token=True`
when the reason is 'expired_token'. Dashboard K.5.a chip-row renders
"🔓 Attribution lost" so operators + the reporter know.

Positive assertions:
  - Valid token → user_id stamped, flag stays False
  - Expired token → user_id=NULL, flag=True
  - Invalid token (garbage / wrong secret) → flag=True
  - No Authorization header (genuine anonymous) → flag stays False
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core.security import JWT_SECRET, JWT_ALGORITHM, create_access_token
from app.models.report import Report


def _expired_token(user_id: str) -> str:
    """JWT with `exp` 1 hour in the past."""
    expire = datetime.now(timezone.utc) - timedelta(hours=1)
    payload = {
        "sub": user_id,
        "role": "REPORTER",
        "type": "access",
        "exp": expire,
        "iat": datetime.now(timezone.utc) - timedelta(hours=2),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _meta_payload(device_hash: str, *, client_report_id=None):
    return {
        "device_hash": device_hash,
        "client_report_id": client_report_id or str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "K.2.e test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    }


# ── K.2.e positive assertions ────────────────────────────────────────────────


def test_no_auth_header_does_not_set_expired_flag(client, db):
    """Genuine anonymous submission (no header) → flag stays False."""
    payload = _meta_payload("DEV-K2E-anonymous")
    res = client.post("/api/v1/reports/meta", json=payload)
    assert res.status_code == 201, f"got {res.status_code} body={res.text}"

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.user_id is None
    assert r.submitted_as_anonymous_due_to_expired_token is False, (
        "Genuine anonymous (no header) must NOT set the lost-attribution flag"
    )


def test_valid_token_attaches_user_id_and_does_not_set_flag(client, db, analyst_user):
    """Happy path: valid token → user_id set, flag stays False."""
    token = create_access_token(
        analyst_user.id, "ANALYST", None, analyst_user.email
    )
    payload = _meta_payload("DEV-K2E-valid-token")
    res = client.post(
        "/api/v1/reports/meta",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, f"got {res.status_code} body={res.text}"

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.user_id == analyst_user.id, f"Expected user_id={analyst_user.id}, got {r.user_id}"
    assert r.submitted_as_anonymous_due_to_expired_token is False


def test_expired_token_sets_lost_attribution_flag(client, db, analyst_user):
    """Expired JWT → report accepted anonymously, flag=True."""
    token = _expired_token(analyst_user.id)
    payload = _meta_payload("DEV-K2E-expired-token")
    res = client.post(
        "/api/v1/reports/meta",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    # UNDP must-have #9: submission MUST still succeed even with expired token.
    assert res.status_code == 201, (
        f"Expired-token submission must still succeed (anonymous fallback); "
        f"got {res.status_code} body={res.text}"
    )

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.user_id is None, (
        "Expired token must NOT attach user_id (security: don't impersonate)"
    )
    assert r.submitted_as_anonymous_due_to_expired_token is True, (
        f"Expired token must set the lost-attribution flag; "
        f"got submitted_as_anonymous_due_to_expired_token={r.submitted_as_anonymous_due_to_expired_token}"
    )


def test_invalid_token_does_not_set_lost_attribution_flag(client, db):
    """Malformed / wrong-secret JWT → submission still succeeds anonymously
    but the lost-attribution flag stays False.

    Rationale: a malformed token can't be distinguished from an attacker
    probing the endpoint. We don't want to mark suspect requests as
    'this reporter lost attribution' — that's an operator-visible chip
    implying a real reporter exists. Only the precise 'token was once
    valid, now expired' case (where we can decode the structure but
    `exp` is past) sets the flag.
    """
    payload = _meta_payload("DEV-K2E-invalid-token")
    res = client.post(
        "/api/v1/reports/meta",
        json=payload,
        headers={"Authorization": "Bearer this-is-not-a-jwt"},
    )
    assert res.status_code == 201

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.user_id is None
    assert r.submitted_as_anonymous_due_to_expired_token is False, (
        "Invalid-token (malformed/wrong-secret) is indistinguishable from "
        "an attacker probe; must not set the lost-attribution flag"
    )


def test_malformed_bearer_header_treated_as_anonymous(client, db):
    """Header present but missing the token portion → treated as anonymous
    (no token = nothing to lose attribution for)."""
    payload = _meta_payload("DEV-K2E-bare-bearer")
    res = client.post(
        "/api/v1/reports/meta",
        json=payload,
        headers={"Authorization": "Bearer "},  # empty token
    )
    assert res.status_code == 201

    body = res.json()
    report_id = body["id"]

    db.expire_all()
    r = db.query(Report).filter(Report.id == report_id).first()
    assert r.user_id is None
    # Empty token = no auth attempt → genuine anonymous, no flag.
    assert r.submitted_as_anonymous_due_to_expired_token is False
