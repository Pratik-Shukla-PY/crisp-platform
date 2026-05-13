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
  // Prod-smoke runs ONLY on mobile-chromium.
  //
  // Earlier this config also shipped a `mobile-safari` project (WebKit
  // on iPhone-14 viewport) — added in Apr 2026 after the building-select
  // 0×0-container regression that Chromium silently tolerated but Safari
  // rendered as a blank map. Dropped in May 2026 because the apt-get
  // install of WebKit's system deps (gstreamer, libavformat, libdv,
  // libpocketsphinx, ~100+ multimedia libs) consistently took 6-8 min
  // on the GitHub `ubuntu-latest` runner — exceeding the prod-smoke
  // job's 8-min `timeout-minutes` cap and getting cancelled BEFORE
  // any test ran. Net effect: prod-smoke produced no signal on every
  // PROD deploy.
  //
  // The actual smoke tests are engine-agnostic (CSP violations, asset
  // 404s, console-error capture, fetch-route audit) — none of them
  // exercise Safari-specific behaviour. WebKit coverage continues
  // for engine-divergent surfaces via:
  //   · spec 56 cross-browser flag rendering (chromium + firefox +
  //     webkit; runs locally + in CI not gating deploy)
  //   · visual-baselines.yml (chromium for now; can extend if needed)
  //   · the building-select-specific spec 53 + 51 (chromium + the
  //     Safari-specific double-rAF / preferCanvas fix is unit-tested
  //     against the layer creation, not the engine itself)
  //
  // If a future Safari-only regression is suspected on PROD, run
  // `npx playwright test --config=playwright.prod.config.ts --browser=webkit`
  // locally — Playwright supports a CLI browser override without a
  // config project.
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
