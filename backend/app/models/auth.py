"""
Auth Models — User, Organization, OTP, Session, AuditLog
Enterprise-grade identity system with RBAC, multi-tenant, GDPR compliance.
"""
import uuid
import enum
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, Enum, JSON, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.session import Base


def gen_uuid():
    return str(uuid.uuid4())


# ── Enums ─────────────────────────────────────────────────────────────────────

class RoleEnum(str, enum.Enum):
    SUPER_ADMIN = "SUPER_ADMIN"
    ADMIN = "ADMIN"
    ANALYST = "ANALYST"
    VIEWER = "VIEWER"
    REPORTER = "REPORTER"


class OTPPurposeEnum(str, enum.Enum):
    SIGNUP = "SIGNUP"
    LOGIN = "LOGIN"
    MFA = "MFA"
    PASSWORD_RESET = "PASSWORD_RESET"


class AuditActionEnum(str, enum.Enum):
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    OTP_REQUEST = "OTP_REQUEST"
    OTP_VERIFY = "OTP_VERIFY"
    PASSWORD_CHANGE = "PASSWORD_CHANGE"
    ROLE_CHANGE = "ROLE_CHANGE"
    REPORT_DISPATCH = "REPORT_DISPATCH"
    REPORT_RESOLVE = "REPORT_RESOLVE"
    REPORT_DELETE = "REPORT_DELETE"
    DATA_EXPORT = "DATA_EXPORT"
    ACCOUNT_DELETE = "ACCOUNT_DELETE"
    SSO_LOGIN = "SSO_LOGIN"
    SESSION_REVOKE = "SESSION_REVOKE"
    REGISTER = "REGISTER"
    FAILED_LOGIN = "FAILED_LOGIN"
    ACCOUNT_LOCKED = "ACCOUNT_LOCKED"


class SSOProviderEnum(str, enum.Enum):
    OKTA = "OKTA"
    AUTH0 = "AUTH0"
    AZURE_AD = "AZURE_AD"
    KEYCLOAK = "KEYCLOAK"


# ── Models ────────────────────────────────────────────────────────────────────

class Organization(Base):
    """Multi-tenant: each enterprise is an organization."""
    __tablename__ = "organizations"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    name = Column(String(255), nullable=False)
    domain = Column(String(255), unique=True, nullable=True, index=True)  # e.g. "undp.org"
    sso_provider = Column(String(20), nullable=True)     # OKTA, AUTH0, AZURE_AD, KEYCLOAK
    sso_config = Column(JSON, nullable=True)              # IdP metadata URL, client_id, etc.
    is_active = Column(Boolean, default=True)
    max_users = Column(Integer, default=100)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    users = relationship("User", back_populates="organization")


class User(Base):
    """Individual or enterprise user with RBAC."""
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=True)   # Nullable for OTP-only users
    full_name = Column(String(255), nullable=True)
    role = Column(String(20), default=RoleEnum.VIEWER.value, nullable=False)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True)
    is_active = Column(Boolean, default=True)
    is_verified = Column(Boolean, default=False)         # True after OTP verification
    mfa_enabled = Column(Boolean, default=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    login_count = Column(Integer, default=0)
    failed_login_count = Column(Integer, default=0)
    locked_until = Column(DateTime(timezone=True), nullable=True)  # Brute force lockout
    # GDPR
    gdpr_consent_at = Column(DateTime(timezone=True), nullable=True)
    gdpr_data_export_requested_at = Column(DateTime(timezone=True), nullable=True)
    gdpr_deletion_requested_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    organization = relationship("Organization", back_populates="users")
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")


class OTPRecord(Base):
    """OTP codes for signup, login, MFA, password reset."""
    __tablename__ = "otp_records"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    email = Column(String(255), nullable=False, index=True)
    code = Column(String(6), nullable=False)
    purpose = Column(String(20), nullable=False)  # SIGNUP, LOGIN, MFA, PASSWORD_RESET
    attempts = Column(Integer, default=0)          # Max 5 attempts
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False)
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class UserSession(Base):
    """Active sessions with device tracking."""
    __tablename__ = "user_sessions"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    refresh_token_hash = Column(String(255), nullable=False)
    device_info = Column(JSON, nullable=True)         # {user_agent, platform, browser}
    ip_address = Column(String(45), nullable=True)
    location_approx = Column(String(255), nullable=True)  # City, Country from IP
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User", back_populates="sessions")


class AuthAuditLog(Base):
    """Comprehensive audit trail for all auth and dashboard actions."""
    __tablename__ = "auth_audit_log"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_email = Column(String(255), nullable=True)     # Denormalized for deleted-user audit
    action = Column(String(30), nullable=False)          # LOGIN, LOGOUT, etc.
    resource_type = Column(String(50), nullable=True)    # "report", "user", "session"
    resource_id = Column(String(36), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    details = Column(JSON, nullable=True)                # Extra context
    created_at = Column(DateTime(timezone=True), server_default=func.now())
