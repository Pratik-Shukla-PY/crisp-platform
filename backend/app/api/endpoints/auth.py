"""
Auth Endpoints — Registration, Login, OTP, Token Refresh, GDPR, Admin, SSO stubs.
Enterprise-grade identity system with brute force protection and audit logging.
"""
import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import pyotp
from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from sqlalchemy import func as sa_func

from app.db.session import get_db
from app.models.auth import (
    User, Organization, OTPRecord, UserSession, AuthAuditLog, RoleEnum,
    UserDeviceLink,
)
from app.models.report import Report
from app.core.security import (
    hash_password, verify_password, validate_password_strength,
    create_access_token, create_refresh_token, decode_token, hash_token,
    generate_otp, get_otp_expiry, send_otp_email,
)
from app.core.deps import get_current_user, require_admin, require_super_admin
from app.services.sms import send_otp_sms, validate_e164, SMSSendError
from jose import JWTError

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
OTP_RATE_LIMIT = 3          # Max OTP requests per email per 10 min
OTP_MAX_ATTEMPTS = 5

# Apr 2026 — single-admin dashboard lockdown.
# When ALLOW_REGISTRATION=false (set in prod .env), the /auth/register
# endpoint returns 410 Gone with a clear "contact admin" message. Default
# stays "true" so dev / test environments + the PWA reporter signup flow
# (if they go through /register) continue to work unchanged.
ALLOW_REGISTRATION = os.getenv("ALLOW_REGISTRATION", "true").lower() == "true"


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: Optional[str] = None
    full_name: Optional[str] = Field(None, max_length=255)


# Phase 1 (Apr 2026 — Optional reporter login) — OTP schemas generalised
# to accept EMAIL or PHONE. `destination` holds whichever the reporter
# chose; `channel` disambiguates. Legacy `email`-only OTPRequest kept as
# an alias path that the endpoint auto-promotes to EMAIL+destination
# (back-compat with the dashboard operator login flow).
class OTPRequest(BaseModel):
    # Legacy alias — dashboard operators' existing login flow sends email.
    email: Optional[EmailStr] = None
    # New: generalised destination (email OR E.164 phone like "+919876543210").
    destination: Optional[str] = Field(None, max_length=255)
    channel: Optional[str] = Field(None, pattern="^(EMAIL|PHONE)$")
    purpose: str = "LOGIN"   # SIGNUP, LOGIN, MFA, PASSWORD_RESET
    # Client-sent device_hash so /auth/otp/verify can return a
    # `linkable_report_count` the app uses to paint the post-login
    # "Link N reports?" card. Optional; dashboard operators won't send it.
    device_hash: Optional[str] = Field(None, max_length=255)


class OTPVerify(BaseModel):
    # Legacy email-only path kept alive.
    email: Optional[EmailStr] = None
    # Phase 1 generalised.
    destination: Optional[str] = Field(None, max_length=255)
    channel: Optional[str] = Field(None, pattern="^(EMAIL|PHONE)$")
    code: str = Field(..., min_length=6, max_length=6)
    purpose: str = "SIGNUP"
    device_hash: Optional[str] = Field(None, max_length=255)


class LinkDeviceRequest(BaseModel):
    """POST /auth/link-device body — claims every anonymous report from
    the given device_hash for the currently-authenticated user."""
    device_hash: str = Field(..., min_length=1, max_length=255)


class UnlinkDeviceRequest(BaseModel):
    """POST /auth/unlink-device — reverts rows attributed to the caller
    via this device back to anonymous AND removes the user_device_link
    row so the device stops appearing in the user's "My Reports" merged
    feed."""
    device_hash: str = Field(..., min_length=1, max_length=255)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    # Apr 2026 — TOTP authenticator code, required when the user has
    # `mfa_enabled = True` (set during admin provisioning). Optional in
    # the schema so legacy non-MFA accounts still work; the login handler
    # rejects with 400 if the user IS mfa_enabled but the field is empty.
    totp_code: Optional[str] = Field(None, min_length=6, max_length=6, pattern=r"^\d{6}$")

class RefreshRequest(BaseModel):
    refresh_token: str

class ProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None

class UserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    full_name: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_ip(request: Request) -> str:
    return request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()

def _audit(db: Session, user_id: str, email: str, action: str, request: Request,
           resource_type: str = None, resource_id: str = None, details: dict = None):
    db.add(AuthAuditLog(
        user_id=user_id, user_email=email, action=action,
        resource_type=resource_type, resource_id=resource_id,
        ip_address=_get_ip(request),
        user_agent=(request.headers.get("user-agent", "") or "")[:500],
        details=details,
    ))

def _issue_tokens(user: User, db: Session, request: Request) -> dict:
    """Create access + refresh tokens, record session, return response."""
    access = create_access_token(user.id, user.role, user.organization_id, user.email)
    refresh = create_refresh_token(user.id)

    # Store session
    session = UserSession(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh),
        device_info={"user_agent": (request.headers.get("user-agent", "") or "")[:300]},
        ip_address=_get_ip(request),
        is_active=True,
        expires_at=datetime.now(timezone.utc) + timedelta(days=30),
    )
    db.add(session)

    # Update user stats
    user.last_login_at = datetime.now(timezone.utc)
    user.login_count = (user.login_count or 0) + 1
    user.failed_login_count = 0
    db.commit()

    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": 30 * 60,
        "user": {
            "id": user.id, "email": user.email, "full_name": user.full_name,
            "role": user.role, "is_verified": user.is_verified,
            "organization_id": user.organization_id,
        },
    }


# ── Registration ──────────────────────────────────────────────────────────────

@router.post("/register")
def register(req: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    """Register a new user. Sends OTP for email verification.

    Apr 2026 — locked down by default in prod via ``ALLOW_REGISTRATION``
    env var. When ``ALLOW_REGISTRATION=false`` we return 410 Gone with a
    clear admin-contact message. The single-admin dashboard model means
    new accounts must be provisioned via ``scripts/create_admin.py``,
    not self-service from the UI.
    """
    if not ALLOW_REGISTRATION:
        raise HTTPException(
            status_code=410,
            detail="Self-service registration is disabled. Contact the administrator.",
        )
    # Check email not taken
    existing = db.query(User).filter(User.email == req.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Validate password if provided
    pw_hash = None
    if req.password:
        ok, msg = validate_password_strength(req.password)
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        pw_hash = hash_password(req.password)

    # Create user
    user = User(
        email=req.email,
        password_hash=pw_hash,
        full_name=req.full_name,
        role=RoleEnum.VIEWER.value,
        is_verified=False,
        gdpr_consent_at=datetime.now(timezone.utc),
    )
    db.add(user)
    db.flush()

    # Generate and send OTP
    # Phase 1 (Apr 2026 — Optional reporter login): OTPRecord now
    # requires `destination` + `channel`. Legacy email-only callers
    # must populate both. `email` column retained for audit compat.
    code = generate_otp()
    otp = OTPRecord(
        destination=req.email,
        channel="EMAIL",
        email=req.email,
        code=code,
        purpose="SIGNUP",
        expires_at=get_otp_expiry(),
        ip_address=_get_ip(request),
    )
    db.add(otp)
    _audit(db, user.id, req.email, "REGISTER", request)
    db.commit()

    send_otp_email(req.email, code, "SIGNUP")
    logger.info(f"User registered: {req.email}")

    return {"message": "Registration successful. Check your email for verification code.", "email": req.email}


# ── OTP Request ───────────────────────────────────────────────────────────────

def _resolve_destination(req) -> tuple[str, str]:
    """Phase 1 back-compat shim. Accepts either the legacy `email` field
    (dashboard operators) or the new `destination`+`channel` pair
    (mobile reporters). Returns a normalised `(destination, channel)`
    tuple. Phone destinations are E.164-validated; emails are lower-
    cased so queries are case-insensitive."""
    channel = (getattr(req, "channel", None) or "").upper() or None
    dest = getattr(req, "destination", None)
    if not dest and getattr(req, "email", None):
        # Legacy path — email-only caller.
        dest = str(req.email)
        channel = channel or "EMAIL"
    if not dest:
        raise HTTPException(status_code=422, detail="destination or email required")
    if channel == "PHONE":
        try:
            dest = validate_e164(dest)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
    elif channel == "EMAIL":
        dest = dest.strip().lower()
    else:
        # Channel unspecified — infer from destination shape.
        if dest.startswith("+") and not ("@" in dest):
            try:
                dest = validate_e164(dest)
                channel = "PHONE"
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
        else:
            channel = "EMAIL"
            dest = dest.strip().lower()
    return dest, channel


def _find_user_by_destination(db: Session, destination: str, channel: str) -> Optional[User]:
    if channel == "PHONE":
        return db.query(User).filter(User.phone_number == destination).first()
    return db.query(User).filter(User.email == destination).first()


@router.post("/otp/request")
def request_otp(req: OTPRequest, request: Request, db: Session = Depends(get_db)):
    """Send a new OTP code to the reporter's email OR phone.

    Phase 1 (Apr 2026 — Optional reporter login) generalised:
      - Accepts `{destination, channel}` (EMAIL or PHONE) OR the legacy
        `{email}` shape for backward-compat with dashboard operators.
      - Rate-limits are applied per-destination + per-IP with identical
        thresholds to the pre-v1 email-only path.
      - For LOGIN purpose, if the user doesn't exist we silently CREATE
        a REPORTER-role user (OTP = proof of ownership of the channel).
        This implements the "skip-registration" UX: tapping "Login" and
        entering your phone is ALSO how you sign up.
    """
    destination, channel = _resolve_destination(req)
    ten_min_ago = datetime.now(timezone.utc) - timedelta(minutes=10)
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    client_ip = _get_ip(request)

    # Layer 1 — per-destination.
    recent = db.query(OTPRecord).filter(
        OTPRecord.destination == destination,
        OTPRecord.created_at >= ten_min_ago,
    ).count()
    if recent >= OTP_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many OTP requests. Try again in a few minutes.")

    # Layer 2 — per-IP across all destinations.
    if client_ip and client_ip not in ("127.0.0.1", "::1", "unknown"):
        from_ip = db.query(OTPRecord).filter(
            OTPRecord.ip_address == client_ip,
            OTPRecord.created_at >= one_hour_ago,
        ).count()
        if from_ip >= 20:
            raise HTTPException(
                status_code=429,
                detail="Too many OTP requests from this network. Try again later."
            )

    # Mobile "LOGIN" = "send a code to this channel". Users are AUTO-CREATED
    # on first verify (see verify_otp). Dashboard operator LOGIN stays
    # user-must-exist because dashboard accounts are admin-provisioned.
    # We detect dashboard-style calls by the absence of `device_hash` +
    # no phone channel (dashboard is email-only).
    is_mobile_flow = bool(getattr(req, "device_hash", None)) or channel == "PHONE"
    if req.purpose == "LOGIN" and not is_mobile_flow:
        user = _find_user_by_destination(db, destination, channel)
        if not user:
            raise HTTPException(status_code=404, detail="No account with this destination")

    code = generate_otp()
    otp = OTPRecord(
        destination=destination,
        channel=channel,
        # Keep email populated when channel == EMAIL for audit-trail legacy.
        email=destination if channel == "EMAIL" else None,
        code=code,
        purpose=req.purpose,
        expires_at=get_otp_expiry(),
        ip_address=_get_ip(request),
    )
    db.add(otp)
    _audit(db, None, destination, "OTP_REQUEST", request, details={"purpose": req.purpose, "channel": channel})
    db.commit()

    # Dispatch via the correct channel. Failures surface as 502 so the
    # client can prompt "Try the other channel".
    try:
        if channel == "PHONE":
            send_otp_sms(destination, code)
        else:
            send_otp_email(destination, code, req.purpose)
    except SMSSendError as e:
        raise HTTPException(status_code=502, detail="Could not send code. Please try again or use another channel.") from e

    return {"message": "Verification code sent.", "destination": destination, "channel": channel}


# ── OTP Verification ─────────────────────────────────────────────────────────

@router.post("/otp/verify")
def verify_otp(req: OTPVerify, request: Request, db: Session = Depends(get_db)):
    """Verify OTP code. On success: creates/verifies the reporter account
    and issues tokens. Returns `linkable_report_count` so the client can
    paint the post-login "Link N reports?" card.

    Phase 1 (Apr 2026 — Optional reporter login):
      - Lookup by `(destination, channel)` for phone-or-email OTP.
      - Auto-CREATE a REPORTER user on first LOGIN with a new destination
        (OTP proof-of-ownership is sufficient signup credential).
      - Bind the user to the reporting device via `user_device_link`.
      - Return `linkable_report_count` — number of anonymous reports on
        this device_hash the reporter can claim via /auth/link-device.
    """
    destination, channel = _resolve_destination(req)

    otp = db.query(OTPRecord).filter(
        OTPRecord.destination == destination,
        OTPRecord.purpose == req.purpose,
        OTPRecord.used == False,
    ).order_by(OTPRecord.created_at.desc()).first()

    if not otp:
        raise HTTPException(status_code=400, detail="No active verification code found. Request a new one.")

    # Check expiry
    now = datetime.now(timezone.utc)
    exp = otp.expires_at.replace(tzinfo=timezone.utc) if otp.expires_at.tzinfo is None else otp.expires_at
    if now > exp:
        raise HTTPException(status_code=400, detail="Code expired. Request a new one.")

    # Check attempts — local (this OTP record)
    otp.attempts = (otp.attempts or 0) + 1
    if otp.attempts > OTP_MAX_ATTEMPTS:
        raise HTTPException(status_code=400, detail="Too many attempts. Request a new code.")

    # P2.6 — global attempt cap across all OTP records for this destination
    # in the last 30 minutes. Same rationale as the legacy email-only path.
    thirty_min_ago = datetime.now(timezone.utc) - timedelta(minutes=30)
    global_attempts = db.query(OTPRecord).filter(
        OTPRecord.destination == destination,
        OTPRecord.created_at >= thirty_min_ago,
    ).with_entities(sa_func.sum(OTPRecord.attempts)).scalar() or 0
    if (global_attempts + otp.attempts) > 15:
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts on this destination. Wait 30 minutes before trying again."
        )

    # Verify code
    if otp.code != req.code:
        db.commit()
        remaining = OTP_MAX_ATTEMPTS - otp.attempts
        raise HTTPException(status_code=400, detail=f"Invalid code. {remaining} attempts remaining.")

    # Success
    otp.used = True
    _audit(db, None, destination, "OTP_VERIFY", request, details={"purpose": req.purpose, "channel": channel})

    user = _find_user_by_destination(db, destination, channel)
    is_new_user = False

    # Auto-create a reporter user on first LOGIN through mobile (email- or
    # phone-channel). SIGNUP path stays explicit — dashboard operator
    # creation still requires the /register endpoint.
    if not user and req.purpose == "LOGIN":
        is_new_user = True
        user = User(
            email=destination if channel == "EMAIL" else None,
            phone_number=destination if channel == "PHONE" else None,
            phone_verified=(channel == "PHONE"),
            is_verified=True,
            primary_auth_channel=channel,
            role=RoleEnum.REPORTER.value,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.flush()   # give us user.id for the audit log below
        _audit(db, user.id, destination, "REGISTER", request,
               details={"channel": channel, "source": "otp_first_login"})

    # Per-purpose success handling.
    if req.purpose == "SIGNUP":
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        user.is_verified = True
        if channel == "PHONE":
            user.phone_verified = True
        tokens = _issue_tokens(user, db, request)
        _maybe_bind_device(db, user.id, getattr(req, "device_hash", None))
        linkable = _linkable_report_count(db, getattr(req, "device_hash", None), user.id)
        db.commit()
        return {**tokens, "is_new_user": is_new_user, "linkable_report_count": linkable}

    if req.purpose == "LOGIN":
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if not user.is_active:
            raise HTTPException(status_code=403, detail="Account disabled")
        user.is_verified = True
        if channel == "PHONE":
            user.phone_verified = True
        user.primary_auth_channel = channel
        _audit(db, user.id, destination, "LOGIN", request, details={"method": "otp", "channel": channel})
        tokens = _issue_tokens(user, db, request)
        _maybe_bind_device(db, user.id, getattr(req, "device_hash", None))
        linkable = _linkable_report_count(db, getattr(req, "device_hash", None), user.id)
        db.commit()
        return {**tokens, "is_new_user": is_new_user, "linkable_report_count": linkable}

    if req.purpose == "MFA":
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        _audit(db, user.id, destination, "LOGIN", request, details={"method": "mfa"})
        return _issue_tokens(user, db, request)

    db.commit()
    return {"message": "Code verified successfully."}


def _maybe_bind_device(db: Session, user_id: str, device_hash: Optional[str]) -> None:
    """Upsert a user_device_link row. Idempotent; safe to call on every
    verify. Skipped when the client didn't include a device_hash (e.g.
    the dashboard operator login path)."""
    if not device_hash:
        return
    existing = db.query(UserDeviceLink).filter(
        UserDeviceLink.user_id == user_id,
        UserDeviceLink.device_hash == device_hash,
    ).first()
    if existing:
        return
    db.add(UserDeviceLink(user_id=user_id, device_hash=device_hash))


def _linkable_report_count(db: Session, device_hash: Optional[str], user_id: str) -> int:
    """Count anonymous reports on this device the user could claim.
    Bounded by `user_id IS NULL` so reports already claimed by someone
    else (a different user on a shared device) don't mistakenly appear."""
    if not device_hash:
        return 0
    device = db.query(Report.device_id).filter(Report.device_id.isnot(None)).first()
    # We need the devices table — Report.device_id is the PK of Device,
    # but clients submit the `device_hash` string, not the id. Look up.
    from app.models.report import Device  # local import avoids cycle
    d = db.query(Device).filter(Device.device_hash == device_hash).first()
    if not d:
        return 0
    return db.query(Report).filter(
        Report.device_id == d.id,
        Report.user_id.is_(None),
    ).count()


# ── Password Login ────────────────────────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Login with email + password. Issues JWT tokens.

    Apr 2026: email lookup is case-insensitive — Postgres `varchar` is
    case-sensitive by default, which meant a user registered as
    `admin@crisp.org` couldn't log in with `Admin@crisp.org` (common
    after mobile-OS autocapitalisation). `ILIKE` with escaped
    metacharacters gives a case-blind match without pulling in CITEXT.
    """
    # Escape SQL LIKE metacharacters so an email like "a%b@c.org"
    # doesn't accidentally match extra rows.
    _email = (req.email or "").strip()
    _email_escaped = _email.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    user = db.query(User).filter(User.email.ilike(_email_escaped, escape="\\")).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Check lockout
    if user.locked_until:
        lock = user.locked_until.replace(tzinfo=timezone.utc) if user.locked_until.tzinfo is None else user.locked_until
        if datetime.now(timezone.utc) < lock:
            remaining = int((lock - datetime.now(timezone.utc)).total_seconds() / 60)
            raise HTTPException(status_code=423, detail=f"Account locked. Try again in {remaining} minutes.")
        else:
            user.locked_until = None
            user.failed_login_count = 0

    if not user.password_hash:
        raise HTTPException(status_code=400, detail="This account uses OTP login. Use 'Request OTP' instead.")

    if not verify_password(req.password, user.password_hash):
        user.failed_login_count = (user.failed_login_count or 0) + 1
        if user.failed_login_count >= MAX_FAILED_LOGINS:
            user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)
            _audit(db, user.id, req.email, "ACCOUNT_LOCKED", request)
            db.commit()
            raise HTTPException(status_code=423, detail=f"Account locked for {LOCKOUT_MINUTES} minutes due to too many failed attempts.")
        _audit(db, user.id, req.email, "FAILED_LOGIN", request)
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    # MFA check — Apr 2026 single-admin lockdown: TOTP authenticator app
    # (Google Authenticator / Authy / 1Password) instead of the legacy
    # email-OTP fallback. The shared secret was generated during admin
    # provisioning (scripts/create_admin.py) and is stored in
    # users.mfa_secret. We verify the 6-digit code via pyotp's RFC 6238
    # implementation. valid_window=1 lets a code from the previous or
    # next 30s slot through too, so a user who tapped Login at the
    # wraparound boundary doesn't get falsely rejected.
    if user.mfa_enabled:
        if not user.mfa_secret:
            # Misconfigured user (mfa_enabled=True but no secret stamped).
            # Refuse to log them in rather than silently degrading to no MFA.
            logger.error("User %s has mfa_enabled=True but no mfa_secret set", user.id)
            raise HTTPException(
                status_code=500,
                detail="MFA is enabled on this account but not provisioned. Contact admin.",
            )
        if not req.totp_code:
            raise HTTPException(
                status_code=400,
                detail="Authenticator code is required for this account.",
            )
        totp = pyotp.TOTP(user.mfa_secret)
        if not totp.verify(req.totp_code, valid_window=1):
            user.failed_login_count = (user.failed_login_count or 0) + 1
            if user.failed_login_count >= MAX_FAILED_LOGINS:
                user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)
                _audit(db, user.id, req.email, "ACCOUNT_LOCKED", request, details={"reason": "totp_fail"})
                db.commit()
                raise HTTPException(status_code=423, detail=f"Account locked for {LOCKOUT_MINUTES} minutes due to too many failed attempts.")
            _audit(db, user.id, req.email, "FAILED_LOGIN", request, details={"reason": "totp_invalid"})
            db.commit()
            raise HTTPException(status_code=401, detail="Invalid authenticator code")
        # Successful TOTP — fall through to issue tokens.

    _audit(db, user.id, req.email, "LOGIN", request, details={"method": "password+totp" if user.mfa_enabled else "password"})
    return _issue_tokens(user, db, request)


# ── Token Refresh ─────────────────────────────────────────────────────────────

@router.post("/refresh")
def refresh_token(req: RefreshRequest, db: Session = Depends(get_db)):
    """Exchange refresh token for a new access token."""
    try:
        payload = decode_token(req.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Verify session exists and is active
    token_hash = hash_token(req.refresh_token)
    session = db.query(UserSession).filter(
        UserSession.user_id == user_id,
        UserSession.refresh_token_hash == token_hash,
        UserSession.is_active == True,
    ).first()
    if not session:
        raise HTTPException(status_code=401, detail="Session not found or revoked")

    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    access = create_access_token(user.id, user.role, user.organization_id, user.email)
    return {"access_token": access, "token_type": "bearer", "expires_in": 30 * 60}


# ── Logout ────────────────────────────────────────────────────────────────────

@router.post("/logout")
def logout(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Revoke ALL active sessions for this user (strong logout, per user
    Phase 1 spec answer 7). Other logged-in devices lose their refresh
    ability on the next refresh — they'll degrade to anonymous once the
    access token's 15 min expires. A fresh OTP login re-establishes
    presence on any device that still wants it."""
    # Strong logout: revoke every active session, not just the current one.
    db.query(UserSession).filter(
        UserSession.user_id == user.id, UserSession.is_active == True
    ).update({"is_active": False, "revoked_at": datetime.now(timezone.utc)})
    _audit(db, user.id, user.email or user.phone_number, "LOGOUT", request)
    db.commit()
    return {"message": "Logged out successfully"}


# ── Phase 1 (Apr 2026 — Optional reporter login): device-linking ──────────────

@router.post("/link-device")
def link_device(
    req: LinkDeviceRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Claim every anonymous report on this device for the calling user.

    Policy (user spec answer: link in Phase 1):
      - UPDATE reports SET user_id = me
        WHERE device_hash = req.device_hash AND user_id IS NULL
      - UPSERT user_device_link(me, device_hash) so the My-Reports feed
        on ANY of this user's future devices surfaces this device's reports.

    Already-claimed rows (user_id IS NOT NULL) are never touched — the
    "WHERE user_id IS NULL" guard makes this safe to call on a shared
    device where a prior user already linked some rows.
    """
    from app.models.report import Device  # avoid circular import at module load
    device = db.query(Device).filter(Device.device_hash == req.device_hash).first()
    if not device:
        # No rows to link, but still upsert the join so future anonymous
        # reports from this device surface in the user's feed after they
        # link it. Dashboard will see the tie.
        _maybe_bind_device(db, user.id, req.device_hash)
        db.commit()
        return {"linked": 0, "message": "Device bound; no anonymous reports to claim."}

    result = db.query(Report).filter(
        Report.device_id == device.id,
        Report.user_id.is_(None),
    ).update({"user_id": user.id}, synchronize_session=False)
    _maybe_bind_device(db, user.id, req.device_hash)
    _audit(db, user.id, user.email or user.phone_number, "OTP_VERIFY", request,
           details={"action": "link_device", "device_hash": req.device_hash, "linked": int(result or 0)})
    db.commit()
    return {"linked": int(result or 0)}


@router.post("/unlink-device")
def unlink_device(
    req: UnlinkDeviceRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Revert the caller's linked reports on this device back to anonymous
    and drop the user_device_link row. Preserves the crisis-response
    value of the reports (they stay in the dashboard); only the PII
    linkage is removed. Idempotent."""
    from app.models.report import Device
    device = db.query(Device).filter(Device.device_hash == req.device_hash).first()
    unlinked = 0
    if device:
        unlinked = db.query(Report).filter(
            Report.device_id == device.id,
            Report.user_id == user.id,
        ).update({"user_id": None}, synchronize_session=False)
    db.query(UserDeviceLink).filter(
        UserDeviceLink.user_id == user.id,
        UserDeviceLink.device_hash == req.device_hash,
    ).delete(synchronize_session=False)
    _audit(db, user.id, user.email or user.phone_number, "OTP_VERIFY", request,
           details={"action": "unlink_device", "device_hash": req.device_hash, "unlinked": int(unlinked or 0)})
    db.commit()
    return {"unlinked": int(unlinked or 0)}


@router.get("/me/reports")
def my_reports(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merged "My Reports" feed across every device the user has linked.

    Returns reports where:
      - user_id = me  (explicitly claimed), OR
      - device_id ∈ { devices from user_device_link(me) } AND user_id IS NULL
        (anonymous reports submitted from one of my bound devices that I
        haven't explicitly linked yet — so the user sees them on device B
        after binding device A's hash to the account).
    De-duped by id, latest-first. No pagination yet — the typical reporter
    has < 100 rows; we'll add it when a 500-row feed surfaces.
    """
    from app.models.report import Device
    hashes = [r.device_hash for r in db.query(UserDeviceLink)
              .filter(UserDeviceLink.user_id == user.id).all()]
    device_ids = []
    if hashes:
        device_ids = [
            d.id for d in db.query(Device).filter(Device.device_hash.in_(hashes)).all()
        ]
    from sqlalchemy import or_
    clauses = [Report.user_id == user.id]
    if device_ids:
        clauses.append(Report.device_id.in_(device_ids))
    rows = (
        db.query(Report)
        .filter(or_(*clauses))
        .order_by(Report.server_created_at.desc())
        .limit(200)
        .all()
    )
    # Dedup (user_id match + device_id match may overlap).
    seen = set()
    out = []
    for r in rows:
        if r.id in seen:
            continue
        seen.add(r.id)
        out.append({
            "id": r.id,
            "status": r.status.value if hasattr(r.status, "value") else r.status,
            "severity": r.severity.value if hasattr(r.severity, "value") else r.severity,
            "infrastructure_type": r.infrastructure_type.value if hasattr(r.infrastructure_type, "value") else r.infrastructure_type,
            "crisis_type": r.crisis_type,
            "description": r.description,
            "server_created_at": r.server_created_at.isoformat() if r.server_created_at else None,
            "user_id": r.user_id,
            "is_anonymous": r.user_id is None,
        })
    return {"reports": out, "device_count": len(hashes)}


# ── Profile ───────────────────────────────────────────────────────────────────

@router.get("/me")
def get_profile(user: User = Depends(get_current_user)):
    """Get current user profile."""
    return {
        "id": user.id, "email": user.email, "full_name": user.full_name,
        "role": user.role, "is_verified": user.is_verified,
        "mfa_enabled": user.mfa_enabled,
        "organization_id": user.organization_id,
        "login_count": user.login_count,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "gdpr_consent_at": user.gdpr_consent_at.isoformat() if user.gdpr_consent_at else None,
    }


@router.patch("/me")
def update_profile(req: ProfileUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Update profile (name, password)."""
    if req.full_name is not None:
        user.full_name = req.full_name
    if req.new_password:
        if not req.current_password:
            raise HTTPException(status_code=400, detail="Current password required to set new password")
        if user.password_hash and not verify_password(req.current_password, user.password_hash):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        ok, msg = validate_password_strength(req.new_password)
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        user.password_hash = hash_password(req.new_password)
    db.commit()
    return {"message": "Profile updated"}


# ── GDPR ──────────────────────────────────────────────────────────────────────

@router.get("/me/data-export")
def export_user_data(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """GDPR: Export all user data as JSON."""
    _audit(db, user.id, user.email, "DATA_EXPORT", request)
    sessions = db.query(UserSession).filter(UserSession.user_id == user.id).all()
    audit = db.query(AuthAuditLog).filter(AuthAuditLog.user_id == user.id).order_by(AuthAuditLog.created_at.desc()).limit(100).all()
    db.commit()
    return {
        "user": {
            "id": user.id, "email": user.email, "full_name": user.full_name,
            "role": user.role, "created_at": str(user.created_at),
            "login_count": user.login_count,
        },
        "sessions": [{"ip": s.ip_address, "created": str(s.created_at), "active": s.is_active} for s in sessions],
        "audit_log": [{"action": a.action, "at": str(a.created_at), "ip": a.ip_address} for a in audit],
    }


@router.post("/me/delete-account")
def request_account_deletion(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """GDPR: Request account deletion (30-day grace period)."""
    user.gdpr_deletion_requested_at = datetime.now(timezone.utc)
    user.is_active = False
    _audit(db, user.id, user.email, "ACCOUNT_DELETE", request, details={"grace_days": 30})
    db.commit()
    return {"message": "Account marked for deletion. You have 30 days to cancel by logging in again."}


# ── Admin Endpoints ───────────────────────────────────────────────────────────

@router.get("/users")
def list_users(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin: List all users."""
    users = db.query(User).order_by(User.created_at.desc()).limit(200).all()
    return [{"id": u.id, "email": u.email, "full_name": u.full_name, "role": u.role,
             "is_active": u.is_active, "is_verified": u.is_verified,
             "login_count": u.login_count, "last_login_at": str(u.last_login_at) if u.last_login_at else None,
             "created_at": str(u.created_at), "organization_id": u.organization_id} for u in users]


@router.patch("/users/{user_id}")
def update_user(user_id: str, req: UserUpdate, request: Request,
                admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin: Update user role, status, name."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if req.role is not None:
        valid = [r.value for r in RoleEnum]
        if req.role not in valid:
            raise HTTPException(status_code=400, detail=f"Invalid role. Must be: {', '.join(valid)}")
        # Only SUPER_ADMIN can assign SUPER_ADMIN
        if req.role == "SUPER_ADMIN" and admin.role != "SUPER_ADMIN":
            raise HTTPException(status_code=403, detail="Only Super Admin can assign Super Admin role")
        old_role = target.role
        target.role = req.role
        _audit(db, admin.id, admin.email, "ROLE_CHANGE", request, "user", user_id,
               {"old": old_role, "new": req.role})
    if req.is_active is not None:
        target.is_active = req.is_active
    if req.full_name is not None:
        target.full_name = req.full_name
    db.commit()
    return {"message": "User updated", "user_id": user_id}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request,
                admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin: Delete a user."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.role == "SUPER_ADMIN":
        raise HTTPException(status_code=403, detail="Cannot delete Super Admin")
    _audit(db, admin.id, admin.email, "ACCOUNT_DELETE", request, "user", user_id,
           {"deleted_email": target.email})
    db.delete(target)
    db.commit()
    return {"message": "User deleted"}


@router.get("/audit-log")
def get_audit_log(user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin: View audit trail."""
    logs = db.query(AuthAuditLog).order_by(AuthAuditLog.created_at.desc()).limit(500).all()
    return [{"id": l.id, "user_email": l.user_email, "action": l.action,
             "resource_type": l.resource_type, "resource_id": l.resource_id,
             "ip_address": l.ip_address, "details": l.details,
             "created_at": str(l.created_at)} for l in logs]


@router.get("/sessions")
def get_active_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """View user's active sessions."""
    sessions = db.query(UserSession).filter(
        UserSession.user_id == user.id, UserSession.is_active == True
    ).order_by(UserSession.created_at.desc()).all()
    return [{"id": s.id, "ip": s.ip_address, "device": s.device_info,
             "created_at": str(s.created_at), "expires_at": str(s.expires_at)} for s in sessions]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, request: Request,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Revoke a specific session."""
    session = db.query(UserSession).filter(
        UserSession.id == session_id, UserSession.user_id == user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.is_active = False
    session.revoked_at = datetime.now(timezone.utc)
    _audit(db, user.id, user.email, "SESSION_REVOKE", request, "session", session_id)
    db.commit()
    return {"message": "Session revoked"}


# ── SSO Stubs (Enterprise IAM Ready) ─────────────────────────────────────────

@router.get("/sso/providers")
def list_sso_providers(db: Session = Depends(get_db)):
    """List available SSO providers for enterprise login."""
    orgs = db.query(Organization).filter(Organization.is_active == True, Organization.sso_provider.isnot(None)).all()
    return [{"name": o.name, "domain": o.domain, "provider": o.sso_provider} for o in orgs]


@router.get("/sso/login")
def sso_login_redirect(domain: str, db: Session = Depends(get_db)):
    """Initiate SSO login — redirect to IdP. Architecture ready for Okta/Auth0/Azure AD/Keycloak."""
    org = db.query(Organization).filter(Organization.domain == domain, Organization.is_active == True).first()
    if not org or not org.sso_provider:
        raise HTTPException(status_code=404, detail="No SSO configured for this domain")

    # In production: build SAML AuthnRequest or OIDC authorization URL
    # For now: return the config so frontend can redirect
    return {
        "provider": org.sso_provider,
        "organization": org.name,
        "message": f"SSO via {org.sso_provider} is architecturally ready. Configure IdP metadata in organization settings.",
        "config": org.sso_config or {},
    }


@router.post("/sso/callback")
def sso_callback(request: Request, payload: dict, db: Session = Depends(get_db)):
    """Process SSO callback — JIT user provisioning + token issuance.
    Architecture ready for SAML assertions and OIDC tokens."""
    email = payload.get("email")
    name = payload.get("name", "")
    org_domain = payload.get("org_domain", "")
    idp_role = payload.get("role", "")

    if not email:
        raise HTTPException(status_code=400, detail="Email required from IdP")

    # Find or create user (JIT provisioning)
    user = db.query(User).filter(User.email == email).first()
    org = db.query(Organization).filter(Organization.domain == org_domain).first() if org_domain else None

    if not user:
        # Map IdP role to CRISP role
        role_map = {"admin": "ADMIN", "analyst": "ANALYST", "viewer": "VIEWER"}
        role = role_map.get(idp_role.lower(), "VIEWER")

        user = User(
            email=email, full_name=name, role=role,
            organization_id=org.id if org else None,
            is_verified=True, is_active=True,
            gdpr_consent_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.flush()

    _audit(db, user.id, email, "SSO_LOGIN", request, details={"provider": org.sso_provider if org else "unknown"})
    return _issue_tokens(user, db, request)
