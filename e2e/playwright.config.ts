/**
 * CRISP — End-to-end Playwright config.
 *
 * Two projects target the two browser-facing surfaces:
 *   · pwa        → Field reporter app (mobile-app/src)
 *   · dashboard  → QRT Ops dashboard (web-dashboard/src)
 *
 * Tests hit a REAL running stack — backend on :8000, static server on :8080.
 * Start it with `bash start.sh` from the repo root before running.
 *
 * Tag `@smoke` on the handful of "is the app alive at all" checks so
 * `npm run test:smoke` can finish in well under a minute and run before
 * every commit. Full suite should stay under ~3 minutes.
 */
import { defineConfig, devices } from '@playwright/test';

// Host overrides via env make the same suite work against localhost and a
// remote staging box without editing the file. CI sets CRISP_BASE_URL_* to
// the ephemeral preview URLs.
// baseURL must be a directory (trailing slash) so goto('index.html') resolves
// cleanly. Pointing it at the full .html file breaks goto('/') — that URL
// would resolve to `http://localhost:8080/` which is the static server's
// directory listing, not the app.
const PWA_BASE = process.env.CRISP_BASE_URL_PWA ||
  'http://localhost:8080/mobile-app/src/';
const DASH_BASE = process.env.CRISP_BASE_URL_DASH ||
  'http://localhost:8080/web-dashboard/src/';
const BACKEND_BASE = process.env.CRISP_BACKEND_URL ||
  'http://localhost:8000';

export default defineConfig({
  testDir: './tests',
  // The stack is shared across all tests; running in parallel could create
  // non-deterministic report ordering. One worker keeps output readable and
  // the runtime is still fine (<3 min full suite).
  fullyParallel: false,
  workers: 1,
  // Fail fast in CI — no flaky-retry paper-over. Locally we allow 1 retry
  // for genuinely transient failures (e.g. slow PII blur on first capture).
  retries: process.env.CI ? 0 : 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  timeout: 60_000,        // generous — some capture flows include JPEG blur
  expect: { timeout: 10_000 },

  use: {
    // Mobile viewport by default — both surfaces are designed phone-first.
    ...devices['Pixel 7'],
    headless: true,
    ignoreHTTPSErrors: true,
    // Keep only traces from failed runs to avoid filling the disk; rerun
    // with `--trace on` to debug.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Grant geolocation + camera + mic up-front so capture flows don't
    // stall on permission prompts.
    geolocation: { latitude: 12.9716, longitude: 77.5946 },  // Bengaluru
    permissions: ['geolocation'],
  },

  projects: [
    {
      name: 'pwa',
      testMatch: /pwa\/.*\.spec\.ts$/,
      use: {
        baseURL: PWA_BASE,
      },
    },
    {
      name: 'dashboard',
      testMatch: /dashboard\/.*\.spec\.ts$/,
      use: {
        // Dashboard is desktop-first; override mobile viewport.
        ...devices['Desktop Chrome'],
        baseURL: DASH_BASE,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'backend',
      testMatch: /backend\/.*\.spec\.ts$/,
      use: {
        baseURL: BACKEND_BASE,
      },
    },
  ],
});
