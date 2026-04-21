# CRISP — End-to-End Test Suite

Run every feature check with **one command**: `bash test.sh` from the repo root.

## What's covered

| Surface | Framework | What | File(s) |
|---|---|---|---|
| Backend API contract | `pytest` | Auth, security, schema validation, PII blur (synthetic fixtures) | `backend/tests/*.py` |
| Backend lifecycle | Playwright | meta → chunks → assembly → review → timestamps → delete | `e2e/tests/backend/*.spec.ts` |
| PWA landing screen | Playwright | hero, CTA, My Reports, language toggle, anti-regression (no 4-card roadmap) | `e2e/tests/pwa/01-landing.spec.ts` |
| PWA capture flow | Playwright | photo → audio → review → send, flow-progress state transitions, Apr 2026 audio UX copy | `e2e/tests/pwa/02-capture-flow.spec.ts` |
| Dashboard login + feed | Playwright | login form, feed render, LIVE chip, offline banner (stays hidden on healthy stack) | `e2e/tests/dashboard/01-login-feed.spec.ts` |
| Dashboard regions admin | Playwright | create, toggle, edit, delete region; public `/regions/enabled` reflects admin state | `e2e/tests/dashboard/02-regions-admin.spec.ts` |
| Dashboard reviewer workflow | Playwright | Mark Accepted/Rejected, action_taken enforcement, Dispatched/Arrived timestamps, computed response_time | `e2e/tests/dashboard/03-reviewer-workflow.spec.ts` |
| RN | `tsc --noEmit` | Compile-time safety. No E2E (device-level Detox is deferred) | — |

## Quick start

```bash
# From the repo root:
bash test.sh                   # full suite (~3 min)
bash test.sh smoke             # under-a-minute smoke — before every commit
bash test.sh backend           # pytest only (fastest)
bash test.sh e2e               # Playwright only (no pytest)
bash test.sh pwa               # PWA specs only
bash test.sh dashboard         # Dashboard specs only
bash test.sh api               # Backend contract specs only
```

The runner:

1. **Ensures the stack is up** — if backend/dashboard/PWA aren't responding,
   it calls `bash start.sh` for you.
2. **Seeds a deterministic admin user** (`e2e-admin@crisp.test`) on first run.
3. **Cleans up** after itself — test-only regions (`E2E …`) and reports
   (`E2E-DEVICE-*`) are deleted in `afterAll`.
4. **Prints a tidy pass/fail matrix** at the end. Exit code is non-zero if
   any suite failed, so you can wire it into `pre-commit` or CI unchanged.

## Headed / UI debugging

```bash
cd e2e
npx playwright test --headed                 # watch the browser
npx playwright test --ui                     # interactive UI mode
npx playwright test --debug                  # step through with inspector
npx playwright show-report                   # open the HTML report after a run
```

Failed runs keep traces, screenshots, and videos under `e2e/playwright-report/`.
Open them to see exactly what the browser saw at the moment of failure.

## Adding a new test

Drop a `*.spec.ts` under one of:
- `e2e/tests/pwa/`        — mobile viewport, `baseURL` = PWA
- `e2e/tests/dashboard/`  — desktop viewport, `baseURL` = Dashboard
- `e2e/tests/backend/`    — no browser, `baseURL` = backend

Tag smoke-critical checks with `@smoke` in the test name; they'll run under
`bash test.sh smoke` (target: the full smoke set finishes in < 60 s).

Use helpers from `tests/helpers/api.ts`:
- `ensureAdminAndLogin(request)` → returns a JWT to thread into `Authorization`
- `cleanupTestRegions(request, token)` / `cleanupTestReports(...)` → teardown
- `TEST_JPEG_BASE64` → deterministic small photo for upload flows

## CI

`test.sh` is CI-safe:
- `retries: 0` in CI (set `CI=1`)
- Exit-code-only signalling (no interactive prompts)
- Stack lifecycle is its responsibility — no assumed running server

Example GitHub Actions step:

```yaml
- name: Run CRISP test suite
  run: bash test.sh
  env:
    CI: "1"
    JWT_SECRET: ${{ secrets.CRISP_TEST_JWT_SECRET }}
```

## Why Playwright (not Cypress / Selenium / Detox)

- Single binary download, no browser-driver juggling.
- Real cross-context support (geolocation, camera permission, multi-tab)
  matches CRISP's actual runtime.
- Traces + screenshots + videos are cheap and on by default for failed runs —
  when a test fails at 2 a.m. you see **exactly** what the browser saw.
- Same syntax for browser E2E and backend HTTP contract tests; one tool for
  both halves of the stack.

Device-level RN testing (Detox) is deferred — the service layer
(database.ts, syncEngine.ts, regionCache.ts, i18n.ts) is already covered by
`tsc --noEmit` and the backend contract tests cover everything those
services call. If we ship a native-only feature later, Detox can layer in.
