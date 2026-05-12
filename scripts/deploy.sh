#!/bin/bash
# CRISP — production deploy script (runs on the EC2 host).
#
# single-host Docker Compose deploy. Pulls the latest commit
# on a branch, optionally rebuilds the backend image, runs Alembic
# migrations, brings the stack up, and waits for the health endpoint.
# If health doesn't go green within HEALTH_TIMEOUT_S, the script rolls
# back to the previous SHA and re-deploys before exiting non-zero.
#
# Invoked by:
#   • .github/workflows/deploy.yml over SSH (CI/CD path).
#   • Operator manually (recovery path):
#         ssh ec2-user@<host>
#         cd ~/crisp && bash scripts/deploy.sh
#
# Env knobs (all optional):
#   CRISP_HOME        — repo path on EC2 (default: $HOME/crisp)
#   DEPLOY_BRANCH     — branch to deploy (default: main)
#   COMPOSE_FILE      — compose file (default: docker-compose.prod.yml)
#   HEALTH_URL        — local health probe (default: http://127.0.0.1:8000/health)
#   PUBLIC_HEALTH_URL — extra probe through ALB after local goes green
#                       (default: empty — skipped)
#   HEALTH_TIMEOUT_S  — max wait for health (default: 120)
#   SKIP_REBUILD      — set "1" to skip backend image rebuild even if
#                       backend/* changed (uses existing image; fast path)
#
# Exit codes:
#   0 — deploy succeeded
#   1 — deploy failed, rollback succeeded (production at OLD_SHA)
#   2 — deploy AND rollback failed (production is in undefined state —
#       page on-call immediately)

set -euo pipefail

CRISP_HOME="${CRISP_HOME:-$HOME/crisp}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/health}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
SKIP_REBUILD="${SKIP_REBUILD:-0}"

log() { printf '\n[deploy] %s\n' "$*"; }
err() { printf '\n[deploy] ERROR: %s\n' "$*" >&2; }

# ── Prereq checks ──────────────────────────────────────────────────────
if [ ! -d "$CRISP_HOME" ]; then
    err "CRISP_HOME=$CRISP_HOME does not exist"
    exit 2
fi

cd "$CRISP_HOME"

if ! command -v docker >/dev/null 2>&1; then
    err "docker not on PATH on EC2"
    exit 2
fi

if [ ! -f "$COMPOSE_FILE" ]; then
    err "compose file $COMPOSE_FILE not found in $CRISP_HOME"
    exit 2
fi

# ── 1. Capture state via a "last-deployed" marker file ─────────────────
# We can't compare working-tree HEAD vs origin to detect "anything to do?"
# because the workflow's bootstrap-pull (in .github/workflows/deploy.yml)
# already advances HEAD to TARGET_SHA before this script runs — that
# pull is needed so this script EXISTS on disk to be invoked. So
# `git rev-parse HEAD` would always equal `origin/<branch>` and the
# old "nothing to do" early-exit fired on every run, skipping the
# docker compose down+up — which meant bind-mounted nginx.conf changes
# silently never reached the running container.
#
# The marker file records the SHA that was last successfully deployed
# (set after the health probe goes green at the end of THIS script).
# Subsequent runs compare to the marker, not to working-tree HEAD.
DEPLOYED_MARKER="$CRISP_HOME/.last-deployed-sha"
LAST_DEPLOYED_SHA=""
if [ -f "$DEPLOYED_MARKER" ]; then
    LAST_DEPLOYED_SHA="$(cat "$DEPLOYED_MARKER" 2>/dev/null || true)"
fi
log "Last successfully-deployed SHA on this host: ${LAST_DEPLOYED_SHA:-<none>}"

# ── 2. Fetch + identify target ─────────────────────────────────────────
log "Fetching origin/$DEPLOY_BRANCH"
git fetch --quiet origin "$DEPLOY_BRANCH"
TARGET_SHA="$(git rev-parse "origin/$DEPLOY_BRANCH")"
log "Target SHA on remote: $TARGET_SHA"
WORKING_TREE_SHA="$(git rev-parse HEAD)"
OLD_SHA="${LAST_DEPLOYED_SHA:-$WORKING_TREE_SHA}"
log "Rollback anchor (OLD_SHA): $OLD_SHA"

if [ -n "$LAST_DEPLOYED_SHA" ] && [ "$LAST_DEPLOYED_SHA" = "$TARGET_SHA" ]; then
    log "Already deployed $TARGET_SHA per marker. Nothing to do."
    exit 0
fi

# Detect changed paths so we can skip the rebuild when nothing changed
# in backend/. Saves ~2 min on docs/PWA/dashboard-only commits.
# Diff against the LAST DEPLOYED SHA, not working-tree HEAD (because
# the workflow's bootstrap-pull may have already advanced HEAD).
DIFF_FROM="${LAST_DEPLOYED_SHA:-$WORKING_TREE_SHA}"
CHANGED_FILES="$(git diff --name-only "$DIFF_FROM" "$TARGET_SHA" 2>/dev/null || echo "")"
NEED_BACKEND_BUILD="no"
NEED_FRONTEND_RESTART="yes"  # default: always restart nginx so bind-mount changes apply
if [ "$SKIP_REBUILD" != "1" ]; then
    if echo "$CHANGED_FILES" | grep -qE "^(backend/|Dockerfile$|docker-compose|requirements)"; then
        NEED_BACKEND_BUILD="yes"
    fi
fi
log "Backend rebuild required: $NEED_BACKEND_BUILD"
log "Frontend restart required: $NEED_FRONTEND_RESTART"

# Make sure the working tree IS at the target. The workflow's
# bootstrap-pull usually has done this, but be defensive — the script
# is also run manually for recovery.
log "Checking out + fast-forwarding $DEPLOY_BRANCH to $TARGET_SHA"
git checkout --quiet "$DEPLOY_BRANCH" 2>/dev/null || git checkout --quiet -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
git reset --hard --quiet "$TARGET_SHA"

# ── 3. Build backend image if backend/ changed ─────────────────────────
if [ "$NEED_BACKEND_BUILD" = "yes" ]; then
    log "Building backend image"
    docker compose -f "$COMPOSE_FILE" build backend
fi

# ── 4. Stop, run migrations, restart ───────────────────────────────────
log "Stopping current stack"
docker compose -f "$COMPOSE_FILE" down

log "Running alembic upgrade head"
# APP_ENV=migrate skips the production-strict guards in main.py during
# the migration container's brief lifetime — DATABASE_URL is the only
# thing it needs, and that comes from .env.production via env_file.
docker compose -f "$COMPOSE_FILE" run --rm \
    -e APP_ENV=migrate \
    backend alembic upgrade head

log "Starting stack"
docker compose -f "$COMPOSE_FILE" up -d

# ── 5. Wait for health ─────────────────────────────────────────────────
log "Waiting for health (up to ${HEALTH_TIMEOUT_S}s) on $HEALTH_URL"
DEADLINE=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
HEALTHY="no"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if curl -fsS -o /dev/null --max-time 4 "$HEALTH_URL" 2>/dev/null; then
        HEALTHY="yes"
        break
    fi
    sleep 3
done

if [ "$HEALTHY" != "yes" ]; then
    err "Health probe never went green. Initiating rollback to $OLD_SHA."

    docker compose -f "$COMPOSE_FILE" down
    git reset --hard --quiet "$OLD_SHA"

    if [ "$NEED_BACKEND_BUILD" = "yes" ]; then
        log "Rebuilding image at OLD_SHA $OLD_SHA"
        docker compose -f "$COMPOSE_FILE" build backend
    fi

    docker compose -f "$COMPOSE_FILE" up -d

    sleep 15
    if curl -fsS -o /dev/null --max-time 4 "$HEALTH_URL" 2>/dev/null; then
        log "Rollback to $OLD_SHA succeeded — production is back online."
        exit 1
    else
        err "ROLLBACK ALSO FAILED. Production is in an undefined state."
        err "Manual intervention required. Last good SHA: $OLD_SHA"
        docker compose -f "$COMPOSE_FILE" ps
        docker compose -f "$COMPOSE_FILE" logs backend --tail 50
        exit 2
    fi
fi

# ── 6. Optional public-URL probe (proves the ALB + cert path works) ────
if [ -n "$PUBLIC_HEALTH_URL" ]; then
    log "Probing public URL: $PUBLIC_HEALTH_URL"
    if ! curl -fsS -o /dev/null --max-time 8 "$PUBLIC_HEALTH_URL"; then
        err "Public health probe failed. Local backend is healthy but ALB → EC2 path is not."
        # Don't auto-rollback here — local was healthy, so the issue is
        # network-layer (SG, ALB target, DNS), not the new release.
        # Surface it but leave the new SHA running.
        exit 1
    fi
fi

# ── 7. Mark this SHA as successfully deployed ──────────────────────────
# Written ONLY after the health probe + optional public probe both pass.
# A failed deploy that auto-rolls back leaves the marker at the previous
# good SHA, so the next deploy attempts a real cycle (not a no-op).
echo "$TARGET_SHA" > "$DEPLOYED_MARKER"
log "Wrote deployed-marker: $DEPLOYED_MARKER → $TARGET_SHA"

# ── 8. Done ────────────────────────────────────────────────────────────
log "Deploy complete: $OLD_SHA → $TARGET_SHA"
docker compose -f "$COMPOSE_FILE" ps
