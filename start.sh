#!/bin/bash

echo "=========================================="
echo "🚀 Starting CRISP Platform Stack..."
echo "=========================================="

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Ensure old servers are killed
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:8080 | xargs kill -9 2>/dev/null

echo "[1/2] Starting FastAPI Backend on port 8000..."
cd "$DIR/backend"

# Setup python virtual environment automatically if missing
if [ ! -d "venv" ]; then
    echo "⚙️  Setting up Python Virtual Environment..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

# Start uvicorn
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

sleep 2 # wait for database initialization

echo "[2/2] Starting Frontend Static Server on port 8080..."
cd "$DIR"
python3 -m http.server 8080 &
FRONTEND_PID=$!

sleep 1 

echo "[+] Opening the Crisis Dashboard and Mobile App mockups..."
open "http://localhost:8080/web-dashboard/src/index.html"
open "http://localhost:8080/mobile-app/src/index.html"

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")

echo ""
echo "Stack is running!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💻 Desktop (localhost):"
echo "   Dashboard : http://localhost:8080/web-dashboard/src/index.html"
echo "   Mobile App: http://localhost:8080/mobile-app/src/index.html"
echo "📱 On a real phone (same Wi-Fi, no GPS on HTTP):"
echo "   Dashboard : http://${LAN_IP}:8080/web-dashboard/src/index.html"
echo "   Mobile App: http://${LAN_IP}:8080/mobile-app/src/index.html"
echo "🔌 Backend API: http://localhost:8000/docs"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚠️  Note: GPS requires HTTPS. On a real phone use localhost via USB forwarding"
echo "   or serve over HTTPS for full GPS functionality."
echo "Press Ctrl+C to stop all servers."

# Wait for both
wait $FRONTEND_PID
