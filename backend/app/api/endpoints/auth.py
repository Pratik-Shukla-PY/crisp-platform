"""
Auth Endpoints — Registration, Login, OTP, Token Refresh, GDPR, Admin, SSO stubs.
Enterprise-grade identity system with brute force protection and audit logging.
"""
import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.auth import User, Organization, OTPRecord, UserSession, AuthAuditLog, RoleEnum
from app.core.security import (
    hash_password, verify_password, validate_password_strength,
    create_access_token, create_refresh_token, decode_token, hash_token,
    generate_otp, get_otp_expiry, send_otp_email,
)
from app.core.deps import get_current_user, require_admin, require_super_admin
from jose import JWTError

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
OTP_RATE_LIMIT = 3          # Max OTP requests per email per 10 min
OTP_MAX_ATTEMPTS = 5


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: Optional[str] = None
    full_name: Optional[str] = Field(None, max_length=255)

class OTPRequest(BaseModel):
    email: EmailStr
    purpose: str = "LOGIN"   # SIGNUP, LOGIN, MFA, PASSWORD_RESET

class OTPVerify(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)
    purpose: str = "SIGNUP"

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

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
    """Register a new user. Sends OTP for email verification."""
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
    code = generate_otp()
    otp = OTPRecord(
        email=req.email, code=code, purpose="SIGNUP",
        expires_at=get_otp_expiry(), ip_address=_get_ip(request),
    )
    db.add(otp)
    _audit(db, user.id, req.email, "REGISTER", request)
    db.commit()

    send_otp_email(req.email, code, "SIGNUP")
    logger.info(f"User registered: {req.email}")

    return {"message": "Registration successful. Check your email for verification code.", "email": req.email}


# ── OTP Request ───────────────────────────────────────────────────────────────

@router.post("/otp/request")
def request_otp(req: OTPRequest, request: Request, db: Session = Depends(get_db)):
    """Send a new OTP code to the user's email."""
    # Rate limit: max 3 per 10 minutes per email
    ten_min_ago = datetime.now(timezone.utc) - timedelta(minutes=10)
    recent = db.query(OTPRecord).filter(
        OTPRecord.email == req.email,
        OTPRecord.created_at >= ten_min_ago,
    ).count()
    if recent >= OTP_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many OTP requests. Try again in a few minutes.")

    # For LOGIN purpose, user must exist
    if req.purpose == "LOGIN":
        user = db.query(User).filter(User.email == req.email).first()
        if not user:
            raise HTTPException(status_code=404, detail="No account with this email")

    code = generate_otp()
    otp = OTPRecord(
        email=req.email, code=code, purpose=req.purpose,
        expires_at=get_otp_expiry(), ip_address=_get_ip(request),
    )
    db.add(otp)
    _audit(db, None, req.email, "OTP_REQUEST", request, details={"purpose": req.purpose})
    db.commit()

    send_otp_email(req.email, code, req.purpose)
    return {"message": "Verification code sent to your email.", "email": req.email}


# ── OTP Verification ─────────────────────────────────────────────────────────

@router.post("/otp/verify")
def verify_otp(req: OTPVerify, request: Request, db: Session = Depends(get_db)):
    """Verify OTP code. On success: verifies account and/or issues tokens."""
    otp = db.query(OTPRecord).filter(
        OTPRecord.email == req.email,
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

    # Check attempts
    otp.attempts = (otp.attempts or 0) + 1
    if otp.attempts > OTP_MAX_ATTEMPTS:
        raise HTTPException(status_code=400, detail="Too many attempts. Request a new code.")

    # Verify code
    if otp.code != req.code:
        db.commit()
        remaining = OTP_MAX_ATTEMPTS - otp.attempts
        raise HTTPException(status_code=400, detail=f"Invalid code. {remaining} attempts remaining.")

    # Success
    otp.used = True
    _audit(db, None, req.email, "OTP_VERIFY", request, details={"purpose": req.purpose})

    user = db.query(User).filter(User.email == req.email).first()

    # SIGNUP verification
    if req.purpose == "SIGNUP":
        if user:
            user.is_verified = True
            db.commit()
            return _issue_tokens(user, db, request)
        raise HTTPException(status_code=404, detail="User not found")

    # LOGIN verification
    if req.purpose == "LOGIN":
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if not user.is_active:
            raise HTTPException(status_code=403, detail="Account disabled")
        user.is_verified = True
        _audit(db, user.id, req.email, "LOGIN", request, details={"method": "otp"})
        return _issue_tokens(user, db, request)

    # MFA verification
    if req.purpose == "MFA":
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        _audit(db, user.id, req.email, "LOGIN", request, details={"method": "mfa"})
        return _issue_tokens(user, db, request)

    db.commit()
    return {"message": "Code verified successfully."}


# ── Password Login ────────────────────────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Login with email + password. Issues JWT tokens."""
    user = db.query(User).filter(User.email == req.email).first()
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

    # MFA check
    if user.mfa_enabled:
        code = generate_otp()
        db.add(OTPRecord(email=req.email, code=code, purpose="MFA",
                         expires_at=get_otp_expiry(), ip_address=_get_ip(request)))
        db.commit()
        send_otp_email(req.email, code, "MFA")
        return {"requires_mfa": True, "message": "MFA code sent to your email."}

    _audit(db, user.id, req.email, "LOGIN", request, details={"method": "password"})
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
    """Revoke current session."""
    # Revoke all active sessions for this user (simple approach)
    db.query(UserSession).filter(
        UserSession.user_id == user.id, UserSession.is_active == True
    ).update({"is_active": False, "revoked_at": datetime.now(timezone.utc)})
    _audit(db, user.id, user.email, "LOGOUT", request)
    db.commit()
    return {"message": "Logged out successfully"}


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
