/**
 * Visual regression — uses Playwright's built-in toHaveScreenshot()
 * (no external service like Percy / Chromatic — keeps cost at $0).
 *
 * Snapshots are committed to the repo at e2e/tests/pwa/42-visual-
 * regression.spec.ts-snapshots/. On every PR, Playwright re-takes the
 * screenshots, diffs against the committed baselines, and fails if
 * the pixel diff exceeds `maxDiffPixelRatio: 0.02` (2% of pixels).
 *
 * To update baselines after an intentional UI change:
 *   cd e2e && npx playwright test 42-visual-regression --update-snapshots
 *
 * Why a 2% pixel-diff tolerance:
 *   • Anti-aliasing on text rendering varies subtly between Chromium
 *     versions and runner OSes (ubuntu vs macOS).
 *   • Map tiles (Mapbox/Leaflet) animate in over ~500ms; a small
 *     percentage diff handles the boundary case.
 *   • Tighter than 2% gives daily flake; looser than 5% misses
 *     real layout regressions.
 *
 * Phase 4 — bootstrap creates the baselines on first run. After that,
 * regressions are blocked unless `--update-snapshots` is intentional.
 */
import { test, expect, Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

// Snapshots are platform-specific (anti-aliasing differs between Linux,
// macOS, Windows). We commit ONLY the Linux baselines (matching CI's
// ubuntu-latest runner). Local dev runs on macOS / Windows will have
// `*-darwin.png` / `*-win32.png` files that should NEVER be committed
// (.gitignore filters them). To regenerate Linux baselines, run in CI
// with --update-snapshots and commit the resulting Linux pngs.
//
// Skip on non-Linux platforms unless CI=true (i.e. running in GH
// Actions with a Linux baseline). Local devs can still run with
// --update-snapshots to inspect their own rendering.
test.skip(
    process.platform !== 'linux' && !process.env.CI && !process.env.LH_VISUAL_FORCE,
    'Visual regression baselines are Linux-only (committed). Set CI=1 or LH_VISUAL_FORCE=1 to override locally.',
);

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
    // Wait for any async i18n loaders to settle so text doesn't
    // flicker between raw key + translated string.
    await page.waitForTimeout(800);
}

const STAGES = [
    'stage-home',
    'stage-v4-capture',
    'stage-v4-classify',
    'stage-v4-review',
    'stage-history',
    'stage-login',
];

test.describe('Visual regression — PWA stages', () => {
    for (const stage of STAGES) {
        test(`${stage} layout matches baseline`, async ({ page }) => {
            await bootPwa(page);
            await page.evaluate(
                (s) => (window as any).__crispGoToStage(s),
                stage,
            );
            // Allow stage-specific async paint to settle (BuildingSelect
            // map tiles, GPS resolve, impact metrics fetch, etc.).
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot(`${stage}.png`, {
                fullPage: false,
                maxDiffPixelRatio: 0.02,
                // Mask elements that legitimately animate every load
                // (timestamp, "Just now" text, GPS coords, impact counts).
                mask: [
                    page.locator('#home-lives-count'),
                    page.locator('#home-verified-count'),
                    page.locator('[data-i18n="v4_locating"]'),
                    page.locator('#v4-meta-location-text'),
                    page.locator('#v4-row-location-text'),
                    page.locator('#summary-time'),
                    page.locator('.connectivity-dot'),
                ],
                // Animations off — prevents flake on first paint of
                // CSS transitions.
                animations: 'disabled',
            });
        });
    }
});

test.describe('Visual regression — locale variants', () => {
    // Spot-check Arabic (RTL, longest layout shift) and Chinese (CJK,
    // tightest character density). If RTL flip + CJK render correctly,
    // the other 4 UN locales are very likely fine too.
    for (const lang of ['ar', 'zh']) {
        test(`stage-home renders correctly in ${lang}`, async ({ page }) => {
            await page.addInitScript((l) => {
                localStorage.setItem('crisp_privacy_consent',
                    JSON.stringify({ accepted: true, ts: Date.now() }));
                localStorage.setItem('crisp_landing_seen', '1');
                localStorage.setItem('crisp_lang_manual', l);
            }, lang);
            await page.goto('index.html');
            await page.waitForFunction(
                (l) => (window as any).state?.lang === l,
                lang,
                { timeout: 8000 },
            );
            await page.waitForTimeout(800);
            await expect(page).toHaveScreenshot(`stage-home-${lang}.png`, {
                fullPage: false,
                maxDiffPixelRatio: 0.03,  // slightly looser for translated text width
                mask: [
                    page.locator('#home-lives-count'),
                    page.locator('#home-verified-count'),
                    page.locator('.connectivity-dot'),
                ],
                animations: 'disabled',
            });
        });
    }
});
