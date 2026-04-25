#!/usr/bin/env python3
"""Provision a single admin user with password + TOTP authenticator MFA.

Apr 2026 — Single-admin dashboard lockdown helper.

Run inside the backend container:

    docker compose -f docker-compose.prod.yml exec backend \\
        python scripts/create_admin.py --email you@example.com

The script will:

  1. Prompt for a password (twice for confirmation, hidden input).
  2. Validate password strength (min 8, upper+lower+digit+special).
  3. Generate a base32-encoded TOTP shared secret (RFC 4648/6238).
  4. Either create the User row OR — if --update is passed and the user
     already exists — rotate their password and TOTP secret.
  5. Mark the user `role=SUPER_ADMIN`, `mfa_enabled=True`,
     `is_active=True`, `is_verified=True`.
  6. Print the otpauth:// URI plus an ASCII QR code that you scan with
     Google Authenticator / Authy / 1Password. Also prints the manual
     base32 secret as a fallback in case the QR doesn't render in your
     terminal.

The QR / secret is shown ONCE — there's no recovery path. If you lose
it, re-run with --update to rotate.

Exit codes:
  0 = success
  1 = validation error (bad email, weak password, mismatch)
  2 = user already exists and --update wasn't passed
"""
from __future__ import annotations

import argparse
import getpass
import sys
from datetime import datetime, timezone

import pyotp
import qrcode

# Late imports so `python scripts/create_admin.py --help` runs even if
# DATABASE_URL is unset (we only validate the DSN once we actually
# connect, in main()).


def _print_qr_ascii(uri: str) -> None:
    """Render the otpauth URI as an ASCII QR to stdout."""
    qr = qrcode.QRCode(border=1)
    qr.add_data(uri)
    qr.make(fit=True)
    qr.print_ascii(invert=True)


def _save_qr_png(uri: str, path: str) -> None:
    """Save the otpauth URI as a real PNG file (sharper than the ASCII
    rendering — useful for embedding in submission docs / sharing with
    judges so they can scan from their phone)."""
    img = qrcode.make(uri)
    img.save(path)


def _validate_email(email: str) -> str:
    email = (email or "").strip().lower()
    if not email or "@" not in email or len(email) > 255:
        print(f"ERROR: invalid email: {email!r}", file=sys.stderr)
        sys.exit(1)
    return email


def _prompt_password() -> str:
    pw = getpass.getpass("New password (hidden): ")
    pw2 = getpass.getpass("Confirm password    : ")
    if pw != pw2:
        print("ERROR: passwords do not match", file=sys.stderr)
        sys.exit(1)
    return pw


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Create or update a single SUPER_ADMIN user with TOTP MFA.",
    )
    ap.add_argument("--email", required=True, help="Admin email address")
    ap.add_argument("--name", default=None, help="Full name (optional)")
    ap.add_argument(
        "--update",
        action="store_true",
        help="If the user exists, rotate their password and TOTP secret instead of erroring.",
    )
    ap.add_argument(
        "--password-from-stdin",
        action="store_true",
        help="Read password from a single stdin line (useful for non-interactive invocations).",
    )
    ap.add_argument(
        "--qr-png-path",
        default=None,
        help="If set, also save the TOTP QR as a PNG at this path (e.g. /app/backend/demo-qr.png). "
             "Useful for submission packages — judges scan the PNG with their phone.",
    )
    args = ap.parse_args()

    # Late imports — only do them once the CLI has parsed, so --help works
    # without a configured DB.
    from app.db.session import SessionLocal
    from app.models.auth import User, RoleEnum
    from app.core.security import hash_password, validate_password_strength

    email = _validate_email(args.email)

    if args.password_from_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = _prompt_password()

    ok, msg = validate_password_strength(pw)
    if not ok:
        print(f"ERROR: weak password — {msg}", file=sys.stderr)
        sys.exit(1)

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()

        if existing and not args.update:
            print(
                f"ERROR: user with email {email!r} already exists. "
                f"Re-run with --update to rotate their password + TOTP.",
                file=sys.stderr,
            )
            sys.exit(2)

        # Generate fresh TOTP secret on every run (160 random bits, base32).
        totp_secret = pyotp.random_base32()

        if existing:
            existing.password_hash = hash_password(pw)
            existing.mfa_secret = totp_secret
            existing.mfa_enabled = True
            existing.is_active = True
            existing.is_verified = True
            existing.role = RoleEnum.SUPER_ADMIN.value
            existing.failed_login_count = 0
            existing.locked_until = None
            if args.name:
                existing.full_name = args.name
            user = existing
            verb = "Updated"
        else:
            user = User(
                email=email,
                password_hash=hash_password(pw),
                full_name=args.name,
                role=RoleEnum.SUPER_ADMIN.value,
                is_active=True,
                is_verified=True,
                mfa_enabled=True,
                mfa_secret=totp_secret,
                gdpr_consent_at=datetime.now(timezone.utc),
            )
            db.add(user)
            verb = "Created"

        db.commit()
        db.refresh(user)

        # Build the otpauth:// URI per RFC 6238. The "issuer" goes to
        # "CRISP" so the entry shows up sensibly in the authenticator app.
        otp_uri = pyotp.totp.TOTP(totp_secret).provisioning_uri(
            name=email,
            issuer_name="CRISP Dashboard",
        )

        print()
        print("=" * 70)
        print(f"  {verb} admin user")
        print("=" * 70)
        print(f"  Email      : {email}")
        print(f"  User ID    : {user.id}")
        print(f"  Role       : {user.role}")
        print(f"  MFA enabled: {user.mfa_enabled}")
        print()
        print("  Scan this QR code with Google Authenticator / Authy / 1Password:")
        print()
        _print_qr_ascii(otp_uri)
        print()
        if args.qr_png_path:
            _save_qr_png(otp_uri, args.qr_png_path)
            print(f"  QR also saved as PNG: {args.qr_png_path}")
            print()
        print("  Or enter the secret manually in your authenticator app:")
        print()
        print(f"    Account : CRISP Dashboard ({email})")
        print(f"    Secret  : {totp_secret}")
        print(f"    Type    : Time-based (TOTP)")
        print(f"    Digits  : 6")
        print(f"    Period  : 30 seconds")
        print()
        print("  otpauth URI (for password managers that accept it directly):")
        print(f"    {otp_uri}")
        print()
        print("=" * 70)
        print("  IMPORTANT: this secret is shown ONCE. Store it in 1Password")
        print("  /Bitwarden as a backup. To rotate, re-run with --update.")
        print("=" * 70)
    finally:
        db.close()


if __name__ == "__main__":
    main()
