#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  CRISP — Secret generation + rotation helper
#
#  Generates cryptographically strong values for the two server-side secrets
#  that the backend will refuse to boot without in production (P1.2 + P1.8):
#
#    JWT_SECRET        — signs every access + refresh token
#    CRISP_ADMIN_KEY   — guards admin-only endpoints (purge, user list, audits)
#
#  Usage:
#    ./scripts/rotate_secrets.sh                # print to stdout
#    ./scripts/rotate_secrets.sh --append       # append to backend/.env
#    ./scripts/rotate_secrets.sh --write-env    # replace in backend/.env
#
#  After rotation:
#    1. Restart the backend process so the new env vars are read.
#    2. Every existing JWT is invalidated — users must re-authenticate.
#       (Refresh tokens also invalid, by design.)
#    3. Archive the PREVIOUS secrets somewhere secure in case you need to
#       decode legacy audit logs.
#
#  Rotation cadence: at least quarterly, and immediately if a secret is
#  suspected leaked (logs published, disgruntled departure, etc.).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/backend/.env"

# 64 hex chars = 256 bits of entropy. OpenSSL ships with macOS + every Linux.
_gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # Portable fallback: /dev/urandom + od. Valid on any POSIX system.
    od -vAn -N32 -tx1 < /dev/urandom | tr -d ' \n'
  fi
}

JWT_SECRET_NEW="$(_gen)"
ADMIN_KEY_NEW="$(_gen)"

echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "JWT_SECRET=$JWT_SECRET_NEW"
echo "CRISP_ADMIN_KEY=$ADMIN_KEY_NEW"
echo "APP_ENV=production"

case "${1:-}" in
  --append)
    [[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE missing — create it first."; exit 1; }
    {
      echo ""
      echo "# Rotated by scripts/rotate_secrets.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "JWT_SECRET=$JWT_SECRET_NEW"
      echo "CRISP_ADMIN_KEY=$ADMIN_KEY_NEW"
    } >> "$ENV_FILE"
    echo "" >&2
    echo "✓ Appended new values to $ENV_FILE" >&2
    echo "  NOTE: the older JWT_SECRET/CRISP_ADMIN_KEY lines above are still" >&2
    echo "  present. Remove them manually, or use --write-env for in-place replace." >&2
    ;;
  --write-env)
    [[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE missing — create it first."; exit 1; }
    tmp="$(mktemp)"
    # Drop any existing JWT_SECRET / CRISP_ADMIN_KEY lines (with or without
    # quotes), then append the new ones.
    awk '!/^(JWT_SECRET|CRISP_ADMIN_KEY)[[:space:]]*=/' "$ENV_FILE" > "$tmp"
    {
      cat "$tmp"
      echo ""
      echo "# Rotated by scripts/rotate_secrets.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "JWT_SECRET=$JWT_SECRET_NEW"
      echo "CRISP_ADMIN_KEY=$ADMIN_KEY_NEW"
    } > "$ENV_FILE"
    rm -f "$tmp"
    echo "" >&2
    echo "✓ Rotated $ENV_FILE — restart the backend to pick up the new values." >&2
    ;;
  "" )
    echo "" >&2
    echo "Tip: pass --write-env to rotate values in $ENV_FILE directly." >&2
    ;;
  *)
    echo "Usage: $0 [--append|--write-env]" >&2
    exit 1
    ;;
esac
