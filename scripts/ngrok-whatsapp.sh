#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  CRISP — Secure ngrok tunnel for WhatsApp webhook testing
#
#  This script:
#  1. Reads the webhook secret path from .env
#  2. Starts ngrok on port 8000
#  3. Prints the full webhook URL to configure in Meta
#  4. Opens ngrok dashboard for debugging
#
#  SECURITY: Only the /api/v1/whatsapp/webhook/<secret> path
#  should be configured in Meta. ngrok exposes the full server
#  but only the webhook path is non-guessable.
# ══════════════════════════════════════════════════════════════

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# Read webhook secret from .env
SECRET=$(grep WHATSAPP_WEBHOOK_PATH_SECRET "$DIR/.env" 2>/dev/null | cut -d= -f2)
if [ -z "$SECRET" ]; then
    echo "❌ WHATSAPP_WEBHOOK_PATH_SECRET not found in .env"
    echo "   Add it to .env or let the server auto-generate one."
    exit 1
fi

VERIFY_TOKEN=$(grep WHATSAPP_VERIFY_TOKEN "$DIR/.env" 2>/dev/null | cut -d= -f2)

echo "══════════════════════════════════════════════"
echo "  CRISP WhatsApp Webhook — ngrok Setup"
echo "══════════════════════════════════════════════"
echo ""
echo "  Starting ngrok tunnel on port 8000..."
echo ""

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
    echo "❌ ngrok not installed."
    echo "   Install: brew install ngrok"
    echo "   Or: https://ngrok.com/download"
    exit 1
fi

# Start ngrok in background
ngrok http 8000 --log=stdout > /dev/null 2>&1 &
NGROK_PID=$!
sleep 3

# Get the public URL from ngrok API
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tunnels = data.get('tunnels', [])
    for t in tunnels:
        if t.get('proto') == 'https':
            print(t['public_url'])
            break
except:
    pass
" 2>/dev/null)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Could not get ngrok URL. Is ngrok running?"
    echo "   Check: http://localhost:4040"
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

WEBHOOK_URL="${NGROK_URL}/api/v1/whatsapp/webhook/${SECRET}"

echo "══════════════════════════════════════════════"
echo "  ✅ ngrok tunnel active!"
echo "══════════════════════════════════════════════"
echo ""
echo "  🔗 Webhook URL (paste in Meta WhatsApp settings):"
echo "  $WEBHOOK_URL"
echo ""
echo "  🔑 Verify Token:"
echo "  $VERIFY_TOKEN"
echo ""
echo "  📊 ngrok Dashboard:"
echo "  http://localhost:4040"
echo ""
echo "  ⚠️  SECURITY NOTES:"
echo "  • Only configure the full webhook URL above in Meta"
echo "  • The path includes a non-guessable secret"
echo "  • Stop ngrok when testing is done (Ctrl+C)"
echo "  • Do NOT use for production or real user data"
echo ""
echo "══════════════════════════════════════════════"
echo "  Press Ctrl+C to stop ngrok"
echo "══════════════════════════════════════════════"

# Test the webhook verification
echo ""
echo "  Testing webhook verification..."
VERIFY_RESULT=$(curl -s "${NGROK_URL}/api/v1/whatsapp/webhook/${SECRET}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test123")
if [ "$VERIFY_RESULT" = "test123" ]; then
    echo "  ✅ Webhook verification working!"
else
    echo "  ❌ Verification failed. Result: $VERIFY_RESULT"
    echo "  Make sure the backend is running (bash start.sh)"
fi

# Apr 2026 — single-quote the trap body so $NGROK_PID expands when the
# trap FIRES, not when it's registered (SC2064). Functionally identical
# here (NGROK_PID is set before this line) but matches shellcheck's
# safer-default expectation, and keeps the script copy-paste-correct
# if anyone ever moves the assignment below the trap.
trap 'kill "$NGROK_PID" 2>/dev/null; echo ""; echo "ngrok stopped."' EXIT
wait "$NGROK_PID"
