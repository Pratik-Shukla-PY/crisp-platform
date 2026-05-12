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

# May 2026 — JWT migrated from python-jose → PyJWT to close
# CVE-2024-33663 (algorithm confusion) + CVE-2024-33664 (DoS via crafted
# JWE). PyJWT signs HS256 byte-for-byte identically, so existing tokens
# in DB / cookies / clients keep verifying through the cutover. We
# re-export PyJWT's base exception class as `JWTError` so the existing
# `except JWTError:` call sites (app.core.deps, app.api.endpoints.auth,
# tests) don't have to change.
import jwt
from jwt import PyJWTError as JWTError
# May 2026 — Password hashing migrated OFF passlib (last release 2020;
# imports the removed-in-Python-3.13 `crypt` stdlib module; its
# detect_wrap_bug self-test breaks on bcrypt 5.x). We call bcrypt
# directly. Wire format unchanged ($2b$12$…) so historical password
# hashes still verify cleanly through the cutover.
import bcrypt as _bcrypt

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

# P1.2 — JWT secret. In production we REQUIRE the env var. A previous fallback
# built the secret as "crisp-dev-secret-change-in-production-" + random hex,
# which rotated on every worker restart — that invalidated everyone's tokens
# AND meant a misconfigured prod ran with dev-grade secret generation. Now:
#   - APP_ENV=production + missing var → raise at import (service won't boot)
#   - APP_ENV=dev        + missing var → auto-generate a dev secret and log a
#                                        loud warning (convenient for local work)
# Rotate the production value via scripts/rotate_secrets.sh (written alongside).
_APP_ENV = os.getenv("APP_ENV", "production").lower()
_JWT_SECRET_ENV = os.getenv("JWT_SECRET", "").strip()
if not _JWT_SECRET_ENV:
    if _APP_ENV == "production":
        raise RuntimeError(
            "JWT_SECRET env var is required when APP_ENV=production. "
            "Generate one with scripts/rotate_secrets.sh and set it in your "
            "deploy environment. Aborting boot to avoid shipping with a "
            "dev-grade key."
        )
    # Dev mode — generate an ephemeral secret + shout about it.
    _JWT_SECRET_ENV = "dev-insecure-" + secrets.token_hex(16)
    logger.warning(
        "⚠  JWT_SECRET not set and APP_ENV=%s — using an ephemeral dev secret. "
        "All tokens will be invalidated on next restart.", _APP_ENV
    )
JWT_SECRET = _JWT_SECRET_ENV
# Guard against too-short production secrets that bypass the check above with
# e.g. `JWT_SECRET=x`. 32 bytes (64 hex chars) is the minimum for HS256 safety.
if _APP_ENV == "production" and len(JWT_SECRET) < 64:
    raise RuntimeError(
        f"JWT_SECRET must be at least 64 characters (got {len(JWT_SECRET)}). "
        "Use scripts/rotate_secrets.sh to generate a cryptographically strong value."
    )
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "CRISP Platform <noreply@crisp.undp.org>")

# ── Password Hashing ─────────────────────────────────────────────────────────

# bcrypt has a hard 72-byte password limit baked into the algorithm.
# passlib silently truncated, bcrypt 4.x silently truncated too, bcrypt
# 5.x raises ValueError instead. Truncating explicitly here makes the
# behavior identical across all three eras so a future bcrypt 5.x bump
# (currently blocked by the pin in requirements.txt) is a one-line move.
_BCRYPT_MAX_PASSWORD_BYTES = 72
_BCRYPT_ROUNDS = 12  # matches the cost factor passlib defaulted to


def hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt. Returns the standard
    $2b$<rounds>$<salt><hash> string format passlib used to emit, so a
    user who registered before this migration keeps logging in unchanged.
    """
    pw_bytes = plain.encode("utf-8")[:_BCRYPT_MAX_PASSWORD_BYTES]
    return _bcrypt.hashpw(pw_bytes, _bcrypt.gensalt(rounds=_BCRYPT_ROUNDS)).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext against a stored bcrypt hash. Accepts BOTH new
    hashes (produced by this module) AND legacy hashes from the passlib
    era — same $2b$… wire format, so back-compat is byte-level identity.
    Returns False on any error (malformed hash, wrong algorithm prefix)
    rather than raising — matches passlib's prior contract so call sites
    in auth.py don't change."""
    if not hashed or not isinstance(hashed, str):
        return False
    try:
        pw_bytes = plain.encode("utf-8")[:_BCRYPT_MAX_PASSWORD_BYTES]
        return _bcrypt.checkpw(pw_bytes, hashed.encode("utf-8"))
    except (ValueError, TypeError):
        # Malformed hash (e.g. legacy non-bcrypt prefix, empty, or
        # mutated bytes) — same outcome as passlib's CryptContext.verify
        # when the input isn't a recognisable hash.
        return False


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
