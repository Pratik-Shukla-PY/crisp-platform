/**
 * CRISP — Playwright config for the LIVE PROD smoke suite.
 *
 * Different from playwright.config.ts:
 *   • Hits the real prod URL — never localhost.
 *   • Only loads tests under tests/prod/ (read-only audit, never mutates DB).
 *   • Faster timeouts so failures surface in seconds, not after retries.
 *   • Allows 1 retry — DNS or transient network blips shouldn't go red on
 *     a single dropped packet, but a real CSP regression is deterministic
 *     and will fail both attempts.
 *
 * Run:
 *   cd e2e && npm run check:prod
 *   CRISP_PROD_BASE_URL=https://staging.example.com npm run check:prod
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/prod',
  fullyParallel: true,
  workers: 4,
  retries: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-prod', open: 'never' }],
  ],
  use: {
    headless: true,
    ignoreHTTPSErrors: false,  // prod has a real cert — fail loud if it's broken
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Geolocation pre-granted so capture flow tests don't hang on permission
    // prompts. Fixed coords (Bengaluru) keep results deterministic.
    geolocation: { latitude: 12.9716, longitude: 77.5946 },
    permissions: ['geolocation'],
  },
  // Apr 2026 — run the full suite against BOTH Chromium and WebKit
  // (Safari's engine) on a mobile viewport. Caught the building-select
  // 0×0-container regression that Chromium silently tolerated but Safari
  // rendered as a blank map. Adds ~30s to total runtime; cheaper than a
  // user-reported "doesn't work in Safari" bug.
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
});
