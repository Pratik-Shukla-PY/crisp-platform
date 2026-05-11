"""Phase 24 — Fail-fast env-var validation tests.

Why this test exists: in Phase 23 the operator's `.env.production`
lost `AWS_REGION` during a manual `nano` edit. The backend started
healthy because `S3Storage.get_storage()` only raised on the first
media request — hours after the bad container went live. This
guard refuses to start unless the required env vars are present.

The validator runs at module-import time (see `app/main.py`). It
short-circuits when `PYTEST_CURRENT_TEST` is set so the regular
pytest suite doesn't need a full prod env. These tests exercise
the validator directly via the `_validate_required_env` helper.
"""
import os

import pytest


@pytest.fixture
def restore_env(monkeypatch):
    """Snapshot + restore env vars the test mutates."""
    yield monkeypatch
    # monkeypatch's own autoreverse handles cleanup.


def _call_validator(monkeypatch, env):
    """Helper: load + invoke `_validate_required_env()` against a
    custom env dict. Uses monkeypatch.setenv / delenv so the global
    interpreter env isn't mutated permanently."""
    # First clear any inherited values that would let the test pass
    # accidentally.
    for k in ("MEDIA_BACKEND", "AWS_S3_BUCKET", "AWS_REGION"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    # Import inside the function so we get a fresh read every call.
    from app.main import _validate_required_env
    return _validate_required_env


def test_validator_passes_when_media_backend_is_local(restore_env):
    """Local-storage deployments don't need any AWS vars; only
    MEDIA_BACKEND itself is required, defaulting to 'local'."""
    validator = _call_validator(
        restore_env,
        {"MEDIA_BACKEND": "local"},
    )
    # Must NOT raise SystemExit.
    validator()


def test_validator_passes_when_s3_fully_configured(restore_env):
    """S3 deployment with all three required vars present → green."""
    validator = _call_validator(
        restore_env,
        {
            "MEDIA_BACKEND": "s3",
            "AWS_S3_BUCKET": "crisp-uploads-prod-test",
            "AWS_REGION": "ap-south-1",
        },
    )
    validator()


def test_validator_exits_when_s3_missing_region(restore_env, capsys):
    """The Phase 23 outage: MEDIA_BACKEND=s3 but AWS_REGION missing →
    backend MUST refuse to start instead of half-running and 500-ing
    on the first media request."""
    validator = _call_validator(
        restore_env,
        {
            "MEDIA_BACKEND": "s3",
            "AWS_S3_BUCKET": "crisp-uploads-prod-test",
            # AWS_REGION missing on purpose
        },
    )
    with pytest.raises(SystemExit) as exc:
        validator()
    assert exc.value.code == 1
    # Error message must name the missing variable so the operator
    # knows exactly what to add.
    captured = capsys.readouterr()
    assert "AWS_REGION" in captured.err
    assert "Refusing to start" in captured.err


def test_validator_exits_when_s3_missing_bucket(restore_env, capsys):
    """Same shape as the region case, for the bucket var. Both AWS
    vars are required when MEDIA_BACKEND=s3."""
    validator = _call_validator(
        restore_env,
        {
            "MEDIA_BACKEND": "s3",
            "AWS_REGION": "ap-south-1",
            # AWS_S3_BUCKET missing
        },
    )
    with pytest.raises(SystemExit) as exc:
        validator()
    assert exc.value.code == 1
    assert "AWS_S3_BUCKET" in capsys.readouterr().err


def test_validator_exits_when_media_backend_missing(restore_env, capsys):
    """MEDIA_BACKEND is foundational; without it the storage layer
    has no idea what backend to instantiate. Test runs with the var
    absent and confirms the validator yells."""
    validator = _call_validator(restore_env, {})
    with pytest.raises(SystemExit) as exc:
        validator()
    assert exc.value.code == 1
    assert "MEDIA_BACKEND" in capsys.readouterr().err


def test_validator_case_insensitive_for_s3_value(restore_env):
    """MEDIA_BACKEND=S3 (uppercase) should still trigger the S3
    branch's AWS-vars requirements. Operators sometimes use
    `MEDIA_BACKEND=S3` by convention; the validator must not silently
    let them through with no AWS vars."""
    validator = _call_validator(
        restore_env,
        {
            "MEDIA_BACKEND": "S3",  # uppercase
            "AWS_S3_BUCKET": "x",
            "AWS_REGION": "y",
        },
    )
    validator()
    # Same case but missing AWS vars → must exit.
    validator2 = _call_validator(
        restore_env,
        {"MEDIA_BACKEND": "S3"},
    )
    with pytest.raises(SystemExit):
        validator2()
