#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$DIR/.crisp.pids"

echo "=========================================="
echo "  CRISP Platform — Starting..."
echo "=========================================="

# Kill any previously saved CRISP processes
if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
        kill "$pid" 2>/dev/null
    done < "$PID_FILE"
    rm -f "$PID_FILE"
fi

# Kill anything still on our ports
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:8080 | xargs kill -9 2>/dev/null
sleep 1

# ── Backend (FastAPI on :8000) ─────────────────────────────────────────────
echo "[1/2] Backend API (port 8000)..."
cd "$DIR/backend"
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt -q
pip install anthropic httpx python-dotenv -q 2>/dev/null
mkdir -p "$DIR/logs"

# Apr 2026 — CRISP is Postgres-only. If DATABASE_URL is unset, fall back
# to the local default that scripts/dev-setup.sh provisions. The backend
# refuses to boot on an unset/SQLite DSN (config.py), so setting it here
# is belt-and-braces — start.sh should Just Work for anyone who has
# already run dev-setup.sh.
if [ -z "${DATABASE_URL:-}" ]; then
    export DATABASE_URL="postgresql+psycopg2://crisp:crisp@localhost:5432/crisp"
    echo "  (DATABASE_URL defaulted to localhost crisp DB — override by exporting first)"
fi
export APP_ENV="${APP_ENV:-dev}"

# Bring the schema up to date BEFORE uvicorn starts. Running this in the
# foreground means a failed migration fails start.sh loudly instead of
# leaving uvicorn up against a stale schema.
echo "  Running alembic upgrade head..."
if ! alembic upgrade head 2>&1 | tail -20; then
    echo "  ✗ alembic upgrade failed — aborting. See output above."
    exit 1
fi

nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload \
    > "$DIR/logs/backend.log" 2>&1 &
BACKEND_PID=$!
disown $BACKEND_PID
sleep 3

# ── Static server for both UIs (:8080) ────────────────────────────────────
echo "[2/2] UI Server (port 8080)..."
cd "$DIR"

nohup python3 -m http.server 8080 \
    > "$DIR/logs/frontend.log" 2>&1 &
FRONTEND_PID=$!
disown $FRONTEND_PID
sleep 1

# Save PIDs so stop.sh can shut them down cleanly
echo "$BACKEND_PID"  > "$PID_FILE"
echo "$FRONTEND_PID" >> "$PID_FILE"

# ── Get LAN IP ─────────────────────────────────────────────────────────────
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")

echo ""
echo "=========================================="
echo "  CRISP is running! (background — persists after terminal close)"
echo "=========================================="
echo ""
echo "  Web Dashboard (QRT Ops):"
echo "  http://localhost:8080/web-dashboard/src/index.html"
echo ""
echo "  Mobile App (Field Reporter):"
echo "  http://localhost:8080/mobile-app/src/index.html"
echo ""
echo "  On same Wi-Fi (real phone):"
echo "  http://${LAN_IP}:8080/web-dashboard/src/index.html"
echo "  http://${LAN_IP}:8080/mobile-app/src/index.html"
echo ""
echo "  To stop:  bash stop.sh"
echo "  Logs:     tail -f logs/backend.log"
echo "=========================================="

# Open both in browser
open "http://localhost:8080/web-dashboard/src/index.html"
open "http://localhost:8080/mobile-app/src/index.html"
