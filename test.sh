#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  CRISP — One-command test runner.
#
#  Usage:
#    bash test.sh              # full suite  (backend pytest + Playwright + RN tsc)
#    bash test.sh smoke        # under-a-minute smoke  (Playwright @smoke tag only)
#    bash test.sh backend      # pytest only
#    bash test.sh e2e          # Playwright only
#    bash test.sh pwa          # Playwright PWA project only
#    bash test.sh dashboard    # Playwright dashboard project only
#    bash test.sh api          # Playwright backend-contract project only
#
#  The runner:
#    · Ensures the stack is up (starts it if not)
#    · Runs the requested suite(s)
#    · Prints a green/red pass/fail matrix at the end
#    · Exits non-zero if any suite fails — safe to wire into pre-commit / CI
#
#  Designed so you never have to remember which tool runs which suite. Every
#  change-then-verify cycle is: edit → `bash test.sh smoke` → commit.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MODE="${1:-full}"

# Colour helpers — disabled when not a TTY.
if [ -t 1 ]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi

# ── Bookkeeping: collect (name, exit-code) tuples for the final matrix. ─────
declare -a RESULTS
record() { RESULTS+=("$1|$2"); }

# ── Stack health: are backend + static server up? ───────────────────────────
backend_up() { curl -sf -o /dev/null http://localhost:8000/health 2>/dev/null; }
dashboard_up() { curl -sf -o /dev/null http://localhost:8080/web-dashboard/src/index.html 2>/dev/null; }
pwa_up() { curl -sf -o /dev/null http://localhost:8080/mobile-app/src/index.html 2>/dev/null; }

ensure_stack() {
    if backend_up && dashboard_up && pwa_up; then
        echo -e "${GREEN}✓${NC} stack already running (backend:8000, static:8080)"
    else
        echo -e "${YELLOW}•${NC} stack down — starting…"
        bash "$DIR/start.sh" > "$DIR/logs/test-runner-start.log" 2>&1
        # Give the SW / uvicorn reload a beat.
        local ready=0
        for i in $(seq 1 30); do
            if backend_up && dashboard_up && pwa_up; then
                echo -e "${GREEN}✓${NC} stack up after ${i}s"
                ready=1
                break
            fi
            sleep 1
        done
        if [ $ready -eq 0 ]; then
            echo -e "${RED}✗ stack failed to come up within 30s — see logs/test-runner-start.log${NC}"
            return 1
        fi
    fi
    # Seed the deterministic SUPER_ADMIN user E2E tests log in as.
    # Idempotent — re-run on every test.sh invocation.
    if [ -d "$DIR/backend/venv" ]; then
        (cd "$DIR/backend" && source venv/bin/activate && \
            APP_ENV=dev python "$DIR/scripts/seed_e2e_admin.py" 2>&1) | sed "s|^|  |"
    else
        echo -e "${YELLOW}  venv missing; skipping E2E admin seed (run start.sh to bootstrap)${NC}"
    fi
    return 0
}

# ── Suite runners. Each returns the exit code of its inner command. ─────────

run_backend_pytest() {
    echo -e "\n${BOLD}${BLUE}▶ Backend — pytest${NC}"
    if [ ! -d "$DIR/backend/venv" ]; then
        echo -e "${YELLOW}  venv missing; skipping (run start.sh once to bootstrap)${NC}"
        return 0
    fi
    (cd "$DIR/backend" && source venv/bin/activate && \
        APP_ENV=dev python -m pytest tests/ -q -x \
            --ignore=tests/test_load.py \
            -W ignore::DeprecationWarning 2>&1)
    local rc=$?
    record "backend pytest" $rc
    return $rc
}

run_playwright() {
    local grep_arg="$1"
    local project_arg="$2"
    echo -e "\n${BOLD}${BLUE}▶ E2E — Playwright ${grep_arg} ${project_arg}${NC}"
    if [ ! -d "$DIR/e2e/node_modules" ]; then
        echo -e "${YELLOW}  installing e2e dependencies…${NC}"
        (cd "$DIR/e2e" && npm install --silent --no-audit --no-fund >/dev/null)
        (cd "$DIR/e2e" && npx playwright install chromium --with-deps >/dev/null 2>&1) || true
    fi
    (cd "$DIR/e2e" && npx playwright test $grep_arg $project_arg 2>&1)
    local rc=$?
    local label="playwright"
    [ -n "$grep_arg" ] && label="$label $grep_arg"
    [ -n "$project_arg" ] && label="$label $project_arg"
    record "$label" $rc
    return $rc
}

run_rn_typecheck() {
    echo -e "\n${BOLD}${BLUE}▶ RN — tsc --noEmit${NC}"
    if [ ! -d "$DIR/crisp-mobile/node_modules" ]; then
        echo -e "${YELLOW}  RN dependencies not installed; skipping${NC}"
        record "rn tsc" 0
        return 0
    fi
    (cd "$DIR/crisp-mobile" && npx tsc --noEmit 2>&1)
    local rc=$?
    record "rn tsc" $rc
    return $rc
}

run_syntax_checks() {
    echo -e "\n${BOLD}${BLUE}▶ Syntax — node --check${NC}"
    local failed=0
    for f in mobile-app/src/app.js mobile-app/src/sw.js mobile-app/src/image-variants.js \
             mobile-app/src/pii-blur.js web-dashboard/src/app.js web-dashboard/src/sw.js; do
        if [ -f "$DIR/$f" ]; then
            node --check "$DIR/$f" 2>&1 | sed "s|^|  $f: |"
            local rc=${PIPESTATUS[0]}
            if [ "$rc" != "0" ]; then
                failed=1
            fi
        fi
    done
    record "node --check" $failed
    return $failed
}

# ── Final matrix. Prints a tidy table of all suites that ran. ───────────────
print_matrix() {
    local any_failed=0
    echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  CRISP test matrix${NC}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    for entry in "${RESULTS[@]}"; do
        local name="${entry%|*}"
        local rc="${entry##*|}"
        if [ "$rc" = "0" ]; then
            printf "  ${GREEN}✓${NC}  %-26s PASS\n" "$name"
        else
            printf "  ${RED}✗${NC}  %-26s FAIL (exit %s)\n" "$name" "$rc"
            any_failed=1
        fi
    done
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if [ $any_failed -eq 0 ]; then
        echo -e "${GREEN}${BOLD}  ALL GREEN. Ship it.${NC}"
    else
        echo -e "${RED}${BOLD}  FAILURES above. HTML report: e2e/playwright-report/index.html${NC}"
        echo -e "  Run ${BOLD}cd e2e && npx playwright show-report${NC} to inspect."
    fi
    return $any_failed
}

# ── Mode dispatch. ──────────────────────────────────────────────────────────

case "$MODE" in
    smoke)
        ensure_stack || exit 1
        run_syntax_checks
        run_playwright "--grep=@smoke" ""
        ;;
    backend)
        run_backend_pytest
        ;;
    e2e)
        ensure_stack || exit 1
        run_playwright "" ""
        ;;
    pwa)
        ensure_stack || exit 1
        run_playwright "" "--project=pwa"
        ;;
    dashboard)
        ensure_stack || exit 1
        run_playwright "" "--project=dashboard"
        ;;
    api)
        ensure_stack || exit 1
        run_playwright "" "--project=backend"
        ;;
    full|*)
        ensure_stack || exit 1
        run_syntax_checks
        run_backend_pytest
        run_rn_typecheck
        run_playwright "" ""
        ;;
esac

print_matrix
exit $?
