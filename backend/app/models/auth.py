"""
Auth Models — User, Organization, OTP, Session, AuditLog
Enterprise-grade identity system with RBAC, multi-tenant, GDPR compliance.
"""
import uuid
import enum
from sqlalchemy import Column, String, Float, Boolean, Integer, DateTime, ForeignKey, Enum, JSON, Text, Index
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
    """Individual or enterprise user with RBAC.

    Phase 1 (Apr 2026 — Optional reporter login) adds phone-only support:
    - `email` is now nullable (phone-only reporters have no email).
    - `phone_number` is the E.164 contact (e.g. "+91987654321").
    - `phone_verified` flips True after OTP verification on the phone channel.
    - `primary_auth_channel` remembers which channel the reporter picked
      first so the Settings screen defaults the re-auth prompt correctly.
    DB-level: a CHECK constraint ensures at least ONE of (email, phone_number)
    is populated — added in migration `0010_auth`, not duplicated here
    because SQLAlchemy's declarative model doesn't need to know.
    """
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    email = Column(String(255), unique=True, nullable=True, index=True)   # now nullable — phone-only OK
    # Phase 1 (Apr 2026 reporter login) — E.164 international phone.
    phone_number = Column(String(32), unique=True, nullable=True, index=True)
    phone_verified = Column(Boolean, default=False, nullable=False)
    # EMAIL | PHONE — the channel the user most recently verified.
    primary_auth_channel = Column(String(10), nullable=True)
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
    # Phase 1 — join rows binding this user to every device they've authed on.
    # Cascade-deletes on user removal so a GDPR account-delete wipes these too.
    devices = relationship(
        "UserDeviceLink", back_populates="user", cascade="all, delete-orphan"
    )


class OTPRecord(Base):
    """OTP codes for signup, login, MFA, password reset.

    Phase 1 (Apr 2026 — Optional reporter login) generalised to a
    `destination` + `channel` shape so phone-OTP verification uses the
    same table as email. The legacy `email` column stays populated for
    EMAIL rows (audit trail) but is now nullable so a PHONE-only row
    doesn't need a synthetic email value.
    """
    __tablename__ = "otp_records"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    # Generalised contact point: holds the email OR E.164 phone. The
    # `channel` column disambiguates. Every hot-path query (`verify`)
    # now uses `(destination, purpose, used, expires_at)` — see the
    # `ix_otp_verify_hotpath` compound index from migration 0010.
    destination = Column(String(255), nullable=False, index=True)
    channel = Column(String(10), nullable=False, default="EMAIL")   # EMAIL | PHONE
    email = Column(String(255), nullable=True, index=True)           # kept for legacy audit rows
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

    # Apr 2026 UI v2.1 — time-range scans (30-day retention purge,
    # forensic queries) need an index on created_at. Mirrors 0008.
    __table_args__ = (
        Index("ix_auth_audit_log_created_at", "created_at"),
    )


class UserDeviceLink(Base):
    """Join table binding a user to every device they've authenticated on.

    Phase 1 (Apr 2026 — Optional reporter login) — a reporter may submit
    from a phone, then check status on a laptop PWA, and we want both
    devices to surface the same "My Reports" feed. Each row is an
    `(user_id, device_hash)` pair; `(user_id)` fetch returns every
    device, `(device_hash)` fetch tells us which user (if any) claims
    a device.

    On a GDPR account deletion the CASCADE drops these rows — the
    reports themselves revert to anonymous via the `reports.user_id`
    ON DELETE SET NULL in migration 0009/0010 (user answer 3).
    """
    __tablename__ = "user_device_link"

    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    device_hash = Column(String(255), primary_key=True, nullable=False)
    linked_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="devices")

    __table_args__ = (
        Index("ix_udl_device_hash", "device_hash"),
    )
