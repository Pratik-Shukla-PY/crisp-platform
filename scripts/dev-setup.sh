#!/usr/bin/env bash
# dev-setup.sh — one-shot Postgres provisioning for CRISP local dev.
#
# CRISP is Postgres-only. This script gets you from a clean
# `git clone` to a running backend in under 2 minutes on macOS + Linux.
#
# Two paths, tried in order:
#   1. Docker Compose — if `docker compose` is available, spin up the
#      postgres service from docker-compose.yml. Zero host install.
#   2. Homebrew (macOS) — install postgresql@15, start the cluster,
#      create the `crisp` role + database.
#
# If neither is available, prints the manual steps and exits 1.
#
# After provisioning, this script:
#   - exports DATABASE_URL to your current shell if sourced
#   - echoes the line to paste into .env if you prefer persistent config
#   - runs `alembic upgrade head` to bring the schema up to date
#
# Usage:
#   bash scripts/dev-setup.sh
#   # OR
#   source scripts/dev-setup.sh    # to get DATABASE_URL exported
set -euo pipefail

CRISP_DB="${CRISP_DB:-crisp}"
CRISP_USER="${CRISP_USER:-crisp}"
CRISP_PASS="${CRISP_PASS:-crisp}"
CRISP_HOST="${CRISP_HOST:-localhost}"
CRISP_PORT="${CRISP_PORT:-5432}"
CRISP_DSN="postgresql+psycopg2://${CRISP_USER}:${CRISP_PASS}@${CRISP_HOST}:${CRISP_PORT}/${CRISP_DB}"

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT_DIR"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
ok()   { color "32" "✓ $1"; }
warn() { color "33" "! $1"; }
info() { color "36" "→ $1"; }
die()  { color "31" "✗ $1"; exit 1; }

info "CRISP dev setup — target DSN: $CRISP_DSN"

# ─── Path 1: Docker Compose ─────────────────────────────────────────────────
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    info "Docker Compose detected — using docker-compose.yml Postgres service."
    # Check if the db service is already up (healthy/running).
    if docker compose ps --services --filter "status=running" | grep -q "^db$"; then
        ok "Postgres already running via docker compose."
    else
        info "Starting db service (background)..."
        docker compose up -d db
        # Wait up to 30s for pg_isready through the container.
        for i in $(seq 1 30); do
            if docker compose exec -T db pg_isready -U "$CRISP_USER" >/dev/null 2>&1; then
                ok "Postgres ready after ${i}s."
                break
            fi
            sleep 1
            if [ "$i" -eq 30 ]; then
                die "Postgres service did not become ready within 30s. Check \`docker compose logs db\`."
            fi
        done
    fi
    # Ensure the crisp DB exists — compose may have created it via POSTGRES_DB, but be safe.
    docker compose exec -T db psql -U "$CRISP_USER" -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$CRISP_DB'" | grep -q "1 row" || \
        docker compose exec -T db createdb -U "$CRISP_USER" "$CRISP_DB" || true
    PROVISIONED=1
fi

# ─── Path 2: Homebrew (macOS) ───────────────────────────────────────────────
if [ -z "${PROVISIONED:-}" ] && [ "$(uname)" = "Darwin" ]; then
    if ! command -v brew >/dev/null; then
        die "Docker Compose not found and Homebrew not found. Install one:
     - Docker Desktop: https://www.docker.com/products/docker-desktop/
     - Homebrew:       https://brew.sh"
    fi
    if ! brew list postgresql@15 >/dev/null 2>&1; then
        info "Installing postgresql@15 via Homebrew (~2 min)..."
        brew install postgresql@15
    fi
    export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
    if ! pg_isready -h "$CRISP_HOST" -p "$CRISP_PORT" >/dev/null 2>&1; then
        info "Starting Postgres 15 cluster..."
        export LC_ALL="en_US.UTF-8"
        pg_ctl -D /opt/homebrew/var/postgresql@15 -l /tmp/crisp-pg15.log start >/dev/null 2>&1 || true
        sleep 2
        pg_isready -h "$CRISP_HOST" -p "$CRISP_PORT" >/dev/null 2>&1 \
            || die "Postgres failed to start — check /tmp/crisp-pg15.log"
    fi
    ok "Postgres is up at $CRISP_HOST:$CRISP_PORT"
    # Role + DB — idempotent.
    psql -U "$USER" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$CRISP_USER'" | grep -q 1 || \
        psql -U "$USER" -d postgres -c "CREATE ROLE $CRISP_USER WITH LOGIN PASSWORD '$CRISP_PASS' SUPERUSER;"
    psql -U "$USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$CRISP_DB'" | grep -q 1 || \
        createdb -U "$USER" -O "$CRISP_USER" "$CRISP_DB"
    PROVISIONED=1
fi

# ─── Fallback: nothing available ────────────────────────────────────────────
if [ -z "${PROVISIONED:-}" ]; then
    die "No Docker Compose and no Homebrew — can't auto-provision. Install one of:
     - Docker Desktop: https://www.docker.com/products/docker-desktop/
     - Homebrew:       https://brew.sh
   Or install Postgres 15+ manually and create the 'crisp' database + role."
fi

ok "Provisioned $CRISP_DB@$CRISP_HOST:$CRISP_PORT"

# ─── Run alembic migrations ─────────────────────────────────────────────────
if [ -d "backend/venv" ]; then
    info "Running alembic upgrade head..."
    cd backend
    # shellcheck disable=SC1091
    source venv/bin/activate
    export DATABASE_URL="$CRISP_DSN"
    export APP_ENV=dev
    alembic upgrade head || die "alembic upgrade head failed."
    deactivate 2>/dev/null || true
    cd ..
    ok "Schema up to date (alembic head)."
else
    warn "backend/venv not found — skipping alembic. Create the venv first:
     python3 -m venv backend/venv
     source backend/venv/bin/activate
     pip install -r backend/requirements.txt
   Then re-run this script."
fi

# ─── Print the line the dev needs in their shell / .env ─────────────────────
printf "\n"
color "36" "── Next step ─────────────────────────────────────────────────────────"
printf "Export to your shell:\n"
printf "  \033[32mexport DATABASE_URL=%q\033[0m\n" "$CRISP_DSN"
printf "\n"
printf "Or persist in .env at repo root:\n"
printf "  \033[32mDATABASE_URL=%s\033[0m\n" "$CRISP_DSN"
printf "\n"
info "Start the backend:  cd backend && source venv/bin/activate && uvicorn app.main:app --reload"
