FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Apr 2026 — copy messaging-bot/ BEFORE backend/ so the symlink at
# `backend/messaging_bot -> ../messaging-bot` has its target available
# at the moment Docker COPYs backend/. Without this, every prod build
# silently shipped a dangling symlink, which made the Telegram /
# WhatsApp / SMS / IVR bots fail their import at startup with
# `No module named 'messaging_bot'` — and silently degraded
# `/api/v1/reports/geocode/describe` (which imports
# `messaging_bot.sms.geocoder`). Discovered Apr-27 via prod-log
# review of `Telegram bot not loaded: No module named 'messaging_bot'`.
COPY messaging-bot/ ./messaging-bot/

# Copy backend source (includes the messaging_bot symlink → ../messaging-bot)
COPY backend/ ./backend/

# Repair the symlink with an absolute path so it can't dangle regardless
# of how Docker preserved the relative symlink during COPY. After this:
#   /app/backend/messaging_bot  →  /app/messaging-bot  (dir, real)
# Python's import machinery follows the symlink and resolves
# `import messaging_bot` against the messaging-bot/ package contents.
RUN rm -f /app/backend/messaging_bot && \
    ln -s /app/messaging-bot /app/backend/messaging_bot

# Create uploads directory and non-root user
RUN mkdir -p /app/backend/uploads && \
    useradd -m -u 1000 crisp && \
    chown -R crisp:crisp /app

# Drop root privileges
USER crisp

EXPOSE 8000

WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
