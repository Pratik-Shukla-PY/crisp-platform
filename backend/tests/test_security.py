"""Unit tests for core security module — passwords, JWT, OTP."""
import pytest
import time
from datetime import datetime, timezone, timedelta
from jose import jwt, JWTError

from app.core.security import (
    hash_password, verify_password, validate_password_strength,
    create_access_token, create_refresh_token, decode_token,
    hash_token, generate_otp, get_otp_expiry,
    JWT_SECRET, JWT_ALGORITHM,
)


# ── Password Hashing ─────────────────────────────────────────────────────────

class TestPasswordHashing:
    def test_hash_produces_bcrypt(self):
        h = hash_password("Test@1234")
        assert h.startswith("$2b$")

    def test_verify_correct_password(self):
        h = hash_password("MyPass@99")
        assert verify_password("MyPass@99", h) is True

    def test_verify_wrong_password(self):
        h = hash_password("MyPass@99")
        assert verify_password("WrongPass@1", h) is False

    def test_different_hashes_for_same_password(self):
        h1 = hash_password("Same@Pass1")
        h2 = hash_password("Same@Pass1")
        assert h1 != h2  # bcrypt uses random salt


# ── Password Policy ──────────────────────────────────────────────────────────

class TestPasswordPolicy:
    def test_too_short(self):
        ok, msg = validate_password_strength("Ab1@")
        assert not ok
        assert "8 characters" in msg

    def test_no_uppercase(self):
        ok, msg = validate_password_strength("abcdef1@xyz")
        assert not ok
        assert "uppercase" in msg

    def test_no_lowercase(self):
        ok, msg = validate_password_strength("ABCDEF1@XYZ")
        assert not ok
        assert "lowercase" in msg

    def test_no_digit(self):
        ok, msg = validate_password_strength("Abcdefgh@")
        assert not ok
        assert "digit" in msg

    def test_no_special(self):
        ok, msg = validate_password_strength("Abcdefg1")
        assert not ok
        assert "special" in msg

    def test_valid_password(self):
        ok, msg = validate_password_strength("Strong@1234")
        assert ok
        assert msg == ""

    def test_complex_valid(self):
        ok, _ = validate_password_strength("C0mpl3x!Pass#2026")
        assert ok


# ── JWT Tokens ────────────────────────────────────────────────────────────────

class TestJWT:
    def test_access_token_contains_claims(self):
        token = create_access_token("user-123", "ADMIN", "org-456", "test@test.com")
        payload = decode_token(token)
        assert payload["sub"] == "user-123"
        assert payload["role"] == "ADMIN"
        assert payload["org"] == "org-456"
        assert payload["email"] == "test@test.com"
        assert payload["type"] == "access"

    def test_access_token_has_expiry(self):
        token = create_access_token("u1", "VIEWER")
        payload = decode_token(token)
        assert "exp" in payload
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        now = datetime.now(timezone.utc)
        # Should expire within 25-35 minutes
        diff = (exp - now).total_seconds()
        assert 1500 < diff < 2100

    def test_refresh_token_type(self):
        token = create_refresh_token("u1")
        payload = decode_token(token)
        assert payload["type"] == "refresh"
        assert payload["sub"] == "u1"

    def test_decode_valid_token(self):
        token = create_access_token("u1", "ADMIN")
        payload = decode_token(token)
        assert payload["sub"] == "u1"

    def test_decode_invalid_token_raises(self):
        with pytest.raises(JWTError):
            decode_token("invalid.token.string")

    def test_decode_tampered_token_raises(self):
        token = create_access_token("u1", "ADMIN")
        tampered = token[:-5] + "XXXXX"
        with pytest.raises(JWTError):
            decode_token(tampered)

    def test_hash_token_is_sha256(self):
        h = hash_token("my-refresh-token")
        assert len(h) == 64  # SHA256 hex = 64 chars
        assert h.isalnum()


# ── OTP ───────────────────────────────────────────────────────────────────────

class TestOTP:
    def test_otp_is_6_digits(self):
        otp = generate_otp()
        assert len(otp) == 6
        assert otp.isdigit()

    def test_otp_randomness(self):
        otps = {generate_otp() for _ in range(50)}
        assert len(otps) > 40  # At least 80% unique in 50 tries

    def test_otp_expiry_is_10_minutes(self):
        expiry = get_otp_expiry()
        now = datetime.now(timezone.utc)
        diff = (expiry - now).total_seconds()
        assert 590 < diff < 610  # ~10 minutes
