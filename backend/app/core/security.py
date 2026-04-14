"""
Security Core — JWT, password hashing, OTP generation, email delivery.
Zero-trust, GDPR-compliant, enterprise-ready.
"""
import os
import re
import secrets
import logging
import smtplib
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional, Any
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from jose import jwt, JWTError
from passlib.context import CryptContext

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

JWT_SECRET = os.getenv("JWT_SECRET", "crisp-dev-secret-change-in-production-" + secrets.token_hex(16))
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "CRISP Platform <noreply@crisp.undp.org>")

# ── Password Hashing ─────────────────────────────────────────────────────────

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def validate_password_strength(password: str) -> tuple[bool, str]:
    """Enforce password policy: min 8 chars, upper+lower+digit+special."""
    if len(password) < 8:
        return False, "Password must be at least 8 characters"
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain an uppercase letter"
    if not re.search(r"[a-z]", password):
        return False, "Password must contain a lowercase letter"
    if not re.search(r"\d", password):
        return False, "Password must contain a digit"
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>_\-+=\[\]\\;'/`~]", password):
        return False, "Password must contain a special character"
    return True, ""


# ── JWT Tokens ────────────────────────────────────────────────────────────────

def create_access_token(user_id: str, role: str, org_id: Optional[str] = None,
                        email: Optional[str] = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": user_id,
        "role": role,
        "org": org_id,
        "email": email,
        "type": "access",
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": user_id,
        "type": "refresh",
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": secrets.token_hex(16),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and validate JWT. Raises JWTError on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def hash_token(token: str) -> str:
    """Hash refresh token for DB storage (never store raw tokens)."""
    return hashlib.sha256(token.encode()).hexdigest()


# ── OTP Generation ────────────────────────────────────────────────────────────

def generate_otp() -> str:
    """Generate cryptographically secure 6-digit OTP."""
    return f"{secrets.randbelow(1000000):06d}"


def get_otp_expiry() -> datetime:
    """OTP expires in 10 minutes."""
    return datetime.now(timezone.utc) + timedelta(minutes=10)


# ── Email Delivery ────────────────────────────────────────────────────────────

def send_otp_email(email: str, code: str, purpose: str) -> bool:
    """Send OTP via SMTP. Returns True on success."""
    subject_map = {
        "SIGNUP": "CRISP — Verify Your Email",
        "LOGIN": "CRISP — Your Login Code",
        "MFA": "CRISP — Verification Required",
        "PASSWORD_RESET": "CRISP — Password Reset Code",
    }
    subject = subject_map.get(purpose, "CRISP — Verification Code")

    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#111827;color:#f1f5f9;border-radius:16px;">
        <div style="text-align:center;margin-bottom:20px;">
            <span style="font-size:28px;font-weight:800;color:#7c3aed;">CRISP</span>
            <p style="color:#9ca3af;font-size:13px;margin:4px 0 0;">Crisis Response Intelligence Platform</p>
        </div>
        <div style="background:#1e293b;border-radius:12px;padding:24px;text-align:center;margin-bottom:16px;">
            <p style="color:#94a3b8;font-size:14px;margin:0 0 12px;">Your verification code is:</p>
            <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#7c3aed;font-family:monospace;">{code}</div>
            <p style="color:#64748b;font-size:12px;margin:12px 0 0;">Valid for 10 minutes</p>
        </div>
        <p style="color:#64748b;font-size:11px;text-align:center;">If you didn't request this code, please ignore this email.</p>
    </div>
    """

    if not SMTP_HOST or not SMTP_USER:
        logger.warning(f"[OTP] SMTP not configured — OTP for {email}: {code} (purpose: {purpose})")
        return True  # Dev mode: log to console

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = email
        msg.attach(MIMEText(f"Your CRISP verification code: {code}\nValid for 10 minutes.", "plain"))
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM, email, msg.as_string())
        logger.info(f"[OTP] Email sent to {email} (purpose: {purpose})")
        return True
    except Exception as e:
        logger.error(f"[OTP] Email delivery failed for {email}: {e}")
        return False
