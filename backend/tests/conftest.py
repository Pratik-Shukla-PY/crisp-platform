"""
CRISP Test Fixtures — In-memory DB, test client, auth tokens, sample data.
"""
import os
import sys
import pytest
from datetime import datetime, timezone

# Ensure backend app is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Apr 2026 — SQLite fully retired. The test suite runs against Postgres
# ONLY. DATABASE_URL precedence:
#
#   1. `PYTEST_DATABASE_URL` — highest. CI injects the service-container
#      Postgres URL here so the matrix + parallel test-runs don't clash
#      with a developer's default.
#   2. `DATABASE_URL` — whatever the dev shell has exported.
#   3. Localhost Postgres default (crisp/crisp/crisp) — matches the
#      Postgres that `scripts/dev-setup.sh` provisions.
#
# There is NO SQLite fallback. If Postgres isn't reachable, pytest fails
# loudly at setup — which is the right behaviour since silent fallback
# was the SQLite-era cause of production-only dialect bugs.
TEST_DB_URL = (
    os.environ.get("PYTEST_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or "postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
)
os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ.setdefault("JWT_SECRET", "test-secret-key-do-not-use-in-production")
os.environ.setdefault("APP_ENV", "dev")

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
    """Reset + create all tables once for the test session.

    Postgres specifics: SQLAlchemy's `drop_all` removes tables but leaves
    the ENUM types behind. The next run then fails with "type already
    exists" when SQLAlchemy tries to CREATE TYPE during create_all. Nuke
    the whole `public` schema (tables + types + indexes + everything)
    for a guaranteed clean slate.

    No alembic migration run here — we use `create_all` which reads the
    live `Base.metadata` and matches what alembic head produces. The
    dedicated migration-chain test (`test_migrations_postgres.py`) is
    what exercises alembic end-to-end; this fixture is just fast setup
    for the application-layer tests.
    """
    import app.models.report  # noqa: F401
    import app.models.auth  # noqa: F401
    import app.models.prediction  # noqa: F401

    from sqlalchemy import text
    with test_engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    Base.metadata.create_all(bind=test_engine)

    yield

    with test_engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))


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
    assert res.status_code == 201
    return res.json()
