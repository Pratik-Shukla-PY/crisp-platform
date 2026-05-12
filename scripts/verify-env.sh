#!/usr/bin/env bash
# CRISP — verify-env.sh
#
# Diff an env file against the required-vars manifest before
# `docker compose up -d --force-recreate backend`. Catches the
# silent-corruption trap where an operator hand-edits
# `.env.production`, accidentally drops e.g. AWS_REGION, then
# restarts: the backend looks healthy on boot because
# `S3Storage.get_storage()` only raises on the first media request —
# hours after the bad state has already reached user traffic.
#
# Usage:
#   bash scripts/verify-env.sh                    # checks ~/crisp/.env.production
#   bash scripts/verify-env.sh path/to/.env.x     # explicit path
#
# Exit codes:
#   0  — all required vars present
#   1  — at least one required var missing
#   2  — env file doesn't exist at the given path

set -euo pipefail

# Defaults to the EC2 deploy path; override by passing an arg.
ENV_FILE="${1:-${HOME}/crisp/.env.production}"

# ── colours (skip if not a TTY so logs stay clean in CI) ──
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    RESET='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; RESET=''
fi

if [ ! -f "$ENV_FILE" ]; then
    printf "%berror%b env file not found: %s\n" "$RED" "$RESET" "$ENV_FILE" >&2
    exit 2
fi

# ── manifests ────────────────────────────────────────────────────────
#
# REQUIRED: backend refuses to start 
#           or a core feature is fully broken without it.
# RECOMMENDED: nice-to-have; missing one degrades a feature but the
#           backend still boots.

REQUIRED=(
    # Storage
    MEDIA_BACKEND
    AWS_S3_BUCKET
    AWS_REGION

    # Database
    DATABASE_URL

    # Authentication
    JWT_SECRET
    CRISP_ADMIN_KEY

    # AI + maps (core feature dependencies)
    ANTHROPIC_API_KEY
    MAPBOX_TOKEN

    # Inbound channels (Twilio + Telegram)
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TELEGRAM_BOT_TOKEN
    IVR_WEBHOOK_PATH_SECRET
)

# Acceptable aliases (operator can have EITHER of these to satisfy
# the same logical requirement). Kept as plain arrays so the script
# runs on bash 3.2 (macOS default) without `declare -A`.
ALIAS_PRIMARY=("TWILIO_PHONE_NUMBER")
ALIAS_ALT=("TWILIO_FROM")

RECOMMENDED=(
    W3W_API_KEY
    CORS_ORIGINS
    VAPID_PUBLIC_KEY
    VAPID_PRIVATE_KEY
    VAPID_CONTACT_EMAIL
    SENTRY_DSN
)

printf "── verifying %s ──\n" "$ENV_FILE"

missing=()
for v in "${REQUIRED[@]}"; do
    if ! grep -q "^${v}=" "$ENV_FILE"; then
        missing+=("$v")
    fi
done

# Alias check: any pair-equivalent variable must be present.
# Parallel arrays index-by-index (bash 3.2-compatible).
for i in "${!ALIAS_PRIMARY[@]}"; do
    primary="${ALIAS_PRIMARY[$i]}"
    alias_for="${ALIAS_ALT[$i]}"
    if ! grep -q "^${primary}=" "$ENV_FILE" && ! grep -q "^${alias_for}=" "$ENV_FILE"; then
        missing+=("$primary (or $alias_for)")
    fi
done

warn=()
for v in "${RECOMMENDED[@]}"; do
    if ! grep -q "^${v}=" "$ENV_FILE"; then
        warn+=("$v")
    fi
done

# Quoted-value check (common operator mistake — docker-compose may
# parse quotes literally on some versions).
quoted_lines=$(grep -nE "^[A-Z_][A-Z_0-9]*=['\"]" "$ENV_FILE" || true)

# CRLF check (Windows line endings break some bash parsers).
crlf_lines=$(grep -lU $'\r' "$ENV_FILE" 2>/dev/null || true)

# Empty-value check (key= with nothing after the equals).
empty_lines=$(grep -nE "^[A-Z_][A-Z_0-9]*=$" "$ENV_FILE" || true)

# ── report ─────────────────────────────────────────────────────────

if [ "${#missing[@]}" -eq 0 ]; then
    printf "%b✓%b all %d required vars present\n" \
        "$GREEN" "$RESET" "${#REQUIRED[@]}"
else
    printf "%b✗%b missing required: %s\n" \
        "$RED" "$RESET" "${missing[*]}"
fi

if [ "${#warn[@]}" -gt 0 ]; then
    printf "%b⚠%b missing recommended (degraded features): %s\n" \
        "$YELLOW" "$RESET" "${warn[*]}"
fi

if [ -n "$quoted_lines" ]; then
    printf "%b✗%b some values are quoted — docker-compose may " \
        "$RED" "$RESET"
    printf "interpret the quotes literally; remove them:\n"
    printf "%s\n" "$quoted_lines"
fi

if [ -n "$crlf_lines" ]; then
    printf "%b✗%b file has CRLF line endings; convert to LF " \
        "$RED" "$RESET"
    printf "(\`dos2unix %s\` or \`sed -i 's/\\r$//' %s\`)\n" \
        "$ENV_FILE" "$ENV_FILE"
fi

if [ -n "$empty_lines" ]; then
    printf "%b⚠%b empty values (KEY= with nothing) — " \
        "$YELLOW" "$RESET"
    printf "intentional?\n%s\n" "$empty_lines"
fi

# Exit non-zero on any required miss or quote/CRLF problem.
if [ "${#missing[@]}" -gt 0 ] || [ -n "$quoted_lines" ] || [ -n "$crlf_lines" ]; then
    printf "\n%bFAIL%b — fix the above before \`docker compose up\`.\n" \
        "$RED" "$RESET"
    exit 1
fi

printf "\n%bOK%b — safe to \`docker compose up -d --force-recreate backend\`.\n" \
    "$GREEN" "$RESET"
exit 0
