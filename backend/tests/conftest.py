"""
CRISP Test Fixtures — In-memory DB, test client, auth tokens, sample data.
"""
import os
import sys
import pytest
from datetime import datetime, timezone

# Ensure backend app is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Phase 24 — skip the fail-fast env-var validator in tests. Production
# deployment refuses to start without MEDIA_BACKEND/AWS_S3_BUCKET/
# AWS_REGION, but the pytest suite legitimately runs without those
# (local-storage mode + mocked S3). The validator itself is exercised
# explicitly by tests/test_env_validation.py, which calls the helper
# function directly with crafted environments. This skip flag is read
# at module import time in `app/main.py` before the validator runs,
# so it MUST be set BEFORE `app.main` is imported anywhere.
os.environ.setdefault("CRISP_SKIP_ENV_VALIDATION", "1")

# Apr 2026 — SQLite fully retired. The test suite runs against Postgres
# ONLY. DATABASE_URL precedence:
#
#   1. `PYTEST_DATABASE_URL` — highest. CI injects the service-container
#      Postgres URL here so the matrix + parallel test-runs don't clash
#      with a developer's default.
#   2. `DATABASE_URL` — whatever the dev shell has exported, IFF it
#      points at a `_test` DB (see seatbelt below).
#   3. Localhost Postgres default — now `crisp_test`, NOT `crisp`. The
#      previous default pointed at the live dev DB; the session-scoped
#      teardown then `DROP SCHEMA CASCADE`'d whatever the developer had
#      submitted through the dashboard / bots. Moving the default to
#      `crisp_test` means a naked `pytest` run can never again wipe
#      production data.
#
# There is NO SQLite fallback. If Postgres isn't reachable, pytest fails
# loudly at setup — which is the right behaviour since silent fallback
# was the SQLite-era cause of production-only dialect bugs.
TEST_DB_URL = (
    os.environ.get("PYTEST_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or "postgresql+psycopg2://crisp:crisp@localhost:5432/crisp_test"
)

# ── SEATBELT ──────────────────────────────────────────────────────────
# Hard-refuse to run against any database whose name does not end in
# `_test`. This is the guard that would have saved the Apr 2026 incident
# where a naked `pytest` blew away every report submitted via the live
# dashboard. Even if a developer (or CI) accidentally exports
# DATABASE_URL pointing at `crisp`, we surface a loud RuntimeError
# instead of silently `DROP SCHEMA CASCADE`-ing it.
from sqlalchemy.engine import make_url  # noqa: E402
_url = make_url(TEST_DB_URL)
if not (_url.database or "").endswith("_test"):
    raise RuntimeError(
        f"pytest refuses to run against database `{_url.database}` — "
        f"target DB name must end in `_test` to prevent wiping live "
        f"dev data. Set PYTEST_DATABASE_URL to a `…_test` DB, e.g.\n"
        f"    export PYTEST_DATABASE_URL="
        f"'postgresql+psycopg2://crisp:crisp@localhost:5432/crisp_test'\n"
        f"Or run `createdb crisp_test` once and re-invoke pytest."
    )

os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ.setdefault("JWT_SECRET", "test-secret-key-do-not-use-in-production")
os.environ.setdefault("APP_ENV", "dev")

# Apr 2026 — isolate test-generated uploads from the production tree.
# `app.api.endpoints.reports::UPLOAD_DIR` reads this env var at import
# time, so setting it BEFORE `from app.main import app` below routes
# every chunked-upload assembly into `backend/uploads_test/`.
# Production uploads (`backend/uploads/`) are therefore physically
# untouched by any pytest run. The test dir is wiped in the session-
# scoped `setup_test_db` fixture below, colocated with the DB reset
# so both the structural + filesystem side of state resets together.
_test_uploads = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "uploads_test")
)
os.makedirs(_test_uploads, exist_ok=True)
os.environ["CRISP_UPLOAD_DIR"] = _test_uploads

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.db.session import Base, get_db
from app.main import app
from app.core.security import create_access_token, hash_password

# Postgres engine — pool_pre_ping revives stale connections (e.g. between
# CI job warmup and the first fixture). No `check_same_thread` anymore;
# that was a SQLite-specific argument.
test_engine = create_engine(TEST_DB_URL, pool_pre_ping=True)
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


def override_get_db():
    db = TestSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    """Reset the test DB + test-uploads dir once per session.

    Postgres specifics: SQLAlchemy's `drop_all` removes tables but leaves
    the ENUM types behind. The next run then fails with "type already
    exists" when SQLAlchemy tries to CREATE TYPE during create_all. Nuke
    the whole `public` schema (tables + types + indexes + everything)
    for a guaranteed clean slate.

    No alembic migration run here — we use `create_all` which reads the
    live `Base.metadata` and matches what alembic head produces. The
    dedicated migration-chain test (`test_migrations.py`) is what
    exercises alembic end-to-end; this fixture is just fast setup for
    the application-layer tests.

    Apr 2026 — the seatbelt at the top of this file ensures this
    fixture can ONLY run against a `_test`-suffixed DB. Combined with
    `CRISP_UPLOAD_DIR` pointing at `backend/uploads_test/` (also set at
    the top of this file), a full pytest run cannot reach into any
    production state — DB rows or on-disk media.
    """
    import app.models.report  # noqa: F401
    import app.models.auth  # noqa: F401
    import app.models.prediction  # noqa: F401

    from sqlalchemy import text
    import shutil

    # --- Pre-test reset --------------------------------------------------
    with test_engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    Base.metadata.create_all(bind=test_engine)
    # Wipe the test uploads dir at session start (never the prod one —
    # the env var is set above to point ONLY at `backend/uploads_test/`).
    # Defensive: only if the path exists and is the one we provisioned.
    _uploads = os.environ.get("CRISP_UPLOAD_DIR", "")
    if _uploads and os.path.isdir(_uploads) and _uploads.endswith("uploads_test"):
        for _name in os.listdir(_uploads):
            _full = os.path.join(_uploads, _name)
            try:
                if os.path.isdir(_full):
                    shutil.rmtree(_full, ignore_errors=True)
                else:
                    os.remove(_full)
            except Exception:
                pass

    yield

    # --- Post-test teardown ----------------------------------------------
    with test_engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    if _uploads and os.path.isdir(_uploads) and _uploads.endswith("uploads_test"):
        for _name in os.listdir(_uploads):
            _full = os.path.join(_uploads, _name)
            try:
                if os.path.isdir(_full):
                    shutil.rmtree(_full, ignore_errors=True)
                else:
                    os.remove(_full)
            except Exception:
                pass


@pytest.fixture(scope="session", autouse=True)
def seed_e2e_admin(setup_test_db):
    """Seed the `e2e-admin@crisp-e2e-tests.org` user once per session.

    The nearby-phase test suites (test_nearby_phase2, …phase4, …phase5,
    …phase5_1) and test_blurhash_and_partial use this canonical admin
    identity to exercise the protected `/api/v1/admin/...` endpoints
    via the real auth flow (`POST /auth/login`). Before this fixture
    landed, those tests `pytest.skip()`-ed when the user wasn't seeded,
    masking 9 tests in the regression sweep.

    Lifecycle:
      - `scope="session"` + `autouse=True` → seeds once per pytest run.
      - Depends on `setup_test_db` so the `users` table exists.
      - mfa_enabled=False so login doesn't require TOTP at test time
        (production e2e-admin has TOTP; this is the unit-test
         equivalent).
      - role=ADMIN suffices for every endpoint the nearby suites
        exercise. Tests that need SUPER_ADMIN use the existing
        `admin_user` fixture instead.
    """
    from app.models.auth import User, RoleEnum

    session = TestSessionLocal()
    try:
        existing = (
            session.query(User)
            .filter(User.email == "e2e-admin@crisp-e2e-tests.org")
            .first()
        )
        if not existing:
            session.add(
                User(
                    email="e2e-admin@crisp-e2e-tests.org",
                    password_hash=hash_password("E2eAdmin!2026"),
                    full_name="E2E Admin (seeded by conftest)",
                    role=RoleEnum.ADMIN.value,
                    is_active=True,
                    is_verified=True,
                    mfa_enabled=False,
                    gdpr_consent_at=datetime.now(timezone.utc),
                )
            )
            session.commit()
    finally:
        session.close()
    yield


@pytest.fixture
def db():
    """Fresh DB session per test."""
    session = TestSessionLocal()
    try:
        yield session
    finally:
        session.close()


# ── FastAPI Test Client ───────────────────────────────────────────────────────

@pytest.fixture
def client():
    """FastAPI test client with test DB."""
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# ── Auth Tokens ───────────────────────────────────────────────────────────────

@pytest.fixture
def admin_user(db):
    """Create a test admin user and return it."""
    from app.models.auth import User
    user = db.query(User).filter(User.email == "admin@test.com").first()
    if not user:
        user = User(
            email="admin@test.com",
            password_hash=hash_password("Admin@1234"),
            full_name="Test Admin",
            role="SUPER_ADMIN",
            is_active=True,
            is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@pytest.fixture
def analyst_user(db):
    """Create a test analyst user."""
    from app.models.auth import User
    user = db.query(User).filter(User.email == "analyst@test.com").first()
    if not user:
        user = User(
            email="analyst@test.com",
            password_hash=hash_password("Analyst@1234"),
            full_name="Test Analyst",
            role="ANALYST",
            is_active=True,
            is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@pytest.fixture
def viewer_user(db):
    """Create a test viewer user."""
    from app.models.auth import User
    user = db.query(User).filter(User.email == "viewer@test.com").first()
    if not user:
        user = User(
            email="viewer@test.com",
            password_hash=hash_password("Viewer@1234"),
            full_name="Test Viewer",
            role="VIEWER",
            is_active=True,
            is_verified=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@pytest.fixture
def admin_token(admin_user):
    return create_access_token(admin_user.id, "SUPER_ADMIN", None, admin_user.email)


@pytest.fixture
def analyst_token(analyst_user):
    return create_access_token(analyst_user.id, "ANALYST", None, analyst_user.email)


@pytest.fixture
def viewer_token(viewer_user):
    return create_access_token(viewer_user.id, "VIEWER", None, viewer_user.email)


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def _reset_rate_limit_buckets():
    """Per-test isolation for the process-global rate limiter.

    The in-memory rate-limit buckets (e.g. ``meta:<device_hash>`` → 30 reports/min)
    are module-level and persist for the whole pytest session. Without a reset they
    accumulate across every test that POSTs a report on the shared
    ``TEST-DEVICE-001`` device, so once the suite has created >30 within the 60 s
    window the NEXT ``sample_report`` POST 429s — surfacing as a setup ERROR in a
    later file (e.g. test_api_reports_state_patches) even though that file passes in
    isolation. Clearing before each test gives every test a clean window; tests that
    exercise the limiter itself (test_rate_limit / channel tests) build their own
    counts up within a single test body, so this does not weaken them.
    """
    try:
        from app.services.rate_limit import _inmemory_buckets
        _inmemory_buckets.clear()
    except Exception:
        pass
    yield


# ── Sample Data ───────────────────────────────────────────────────────────────

@pytest.fixture
def sample_report(client):
    """Create a sample report and return its ID."""
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": "TEST-DEVICE-001",
        "client_report_id": f"test-{datetime.now().timestamp()}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "Test road damage near market",
        "expected_media": 0,
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, f"sample_report POST failed: {res.status_code} {res.text[:400]}"
    return res.json()
