#!/bin/bash
# CRISP — manual rollback script (runs on the EC2 host).
#
# Reverts the running stack to a specific commit SHA, runs Alembic
# downgrade IF the operator confirms (migration downgrades are usually
# the danger zone), and restarts containers.
#
# built as the manual companion to deploy.sh's auto-rollback.
# Use this when:
#   • The auto-rollback ran but landed on a bad earlier commit.
#   • A bug surfaces hours after a green deploy.
#   • You need to skip past a transient bad commit and pin to an
#     explicit known-good SHA.
#
# Usage:
#   bash scripts/rollback.sh <target-sha>
#   bash scripts/rollback.sh HEAD~1            # one commit back
#   bash scripts/rollback.sh main@{yesterday}  # git's date-based reflog
#
# Schema migrations are NOT auto-downgraded. If the bad commit added a
# migration, the new schema stays in place; the old code runs against
# it (additive migrations are fine to leave; subtractive ones may need
# a manual `alembic downgrade -1`). The script asks before doing
# anything irreversible.

set -euo pipefail

CRISP_HOME="${CRISP_HOME:-$HOME/crisp}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/health}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"

SKIP_CONFIRM="0"
TARGET=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --yes|-y)
            # Non-interactive mode — used by the auto-rollback job in
            # .github/workflows/deploy.yml when prod-smoke catches a
            # regression and we need to revert without a human at a
            # terminal to type 'y'.
            SKIP_CONFIRM="1"; shift ;;
        --*)
            echo "Unknown flag: $1" >&2; exit 64 ;;
        *)
            if [ -z "$TARGET" ]; then TARGET="$1"; shift
            else echo "Unexpected positional arg: $1" >&2; exit 64
            fi ;;
    esac
done

if [ -z "$TARGET" ]; then
    echo "Usage: $0 [--yes|-y] <target-sha>" >&2
    echo "  e.g. $0 8e53736" >&2
    echo "       $0 HEAD~1" >&2
    echo "       $0 --yes HEAD~1   # skip y/n prompt (CI rollback)" >&2
    exit 64
fi

cd "$CRISP_HOME"

CURRENT="$(git rev-parse HEAD)"
RESOLVED="$(git rev-parse "$TARGET")"

echo
echo "Rollback plan:"
echo "  Current : $CURRENT"
echo "  Target  : $RESOLVED ($TARGET)"
echo "  Diff    :"
git log --oneline "$RESOLVED..$CURRENT" | sed 's/^/    /'
echo

if [ "$SKIP_CONFIRM" != "1" ]; then
    read -r -p "Proceed with rollback? [y/N] " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "Aborted."
        exit 1
    fi
else
    echo "[--yes] Skipping confirmation prompt — non-interactive rollback."
fi

# ── 1. Reset code ──────────────────────────────────────────────────────
echo "[rollback] Resetting working tree to $RESOLVED"
git reset --hard --quiet "$RESOLVED"

# ── 2. Rebuild backend ─────────────────────────────────────────────────
echo "[rollback] Rebuilding backend image"
docker compose -f "$COMPOSE_FILE" build backend

# ── 3. Bring down + back up (skip migration — see header note) ─────────
echo "[rollback] Cycling stack"
docker compose -f "$COMPOSE_FILE" down
docker compose -f "$COMPOSE_FILE" up -d

# ── 4. Health probe ────────────────────────────────────────────────────
echo "[rollback] Waiting for health (up to ${HEALTH_TIMEOUT_S}s)"
DEADLINE=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if curl -fsS -o /dev/null --max-time 4 "$HEALTH_URL" 2>/dev/null; then
        echo "[rollback] Stack is healthy at $RESOLVED"
        # Update deploy.sh's marker so the NEXT deploy doesn't think the
        # bad-SHA is still the "current" deploy and skip the cycle.
        echo "$RESOLVED" > "$CRISP_HOME/.last-deployed-sha"
        echo "[rollback] Updated .last-deployed-sha → $RESOLVED"
        docker compose -f "$COMPOSE_FILE" ps
        exit 0
    fi
    sleep 3
done

echo "[rollback] Health probe never went green at $RESOLVED — manual debug needed" >&2
docker compose -f "$COMPOSE_FILE" ps
docker compose -f "$COMPOSE_FILE" logs backend --tail 50
exit 1
