"""
CRISP Test Fixtures — In-memory DB, test client, auth tokens, sample data.
"""
import os
import sys
import pytest
from datetime import datetime, timezone

# Ensure backend app is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["DATABASE_URL"] = "sqlite:///./test_crisp.db"
os.environ["JWT_SECRET"] = "test-secret-key-do-not-use-in-production"

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.db.session import Base, get_db
from app.main import app
from app.core.security import create_access_token, hash_password


# ── Database Fixture ──────────────────────────────────────────────────────────

TEST_DB_URL = "sqlite:///./test_crisp.db"
test_engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False})
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


def override_get_db():
    db = TestSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    """Create all tables once for the test session."""
    import app.models.report
    import app.models.auth
    import app.models.prediction
    Base.metadata.drop_all(bind=test_engine)
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)
    # Clean up test DB file
    try:
        os.remove("./test_crisp.db")
    except:
        pass


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
