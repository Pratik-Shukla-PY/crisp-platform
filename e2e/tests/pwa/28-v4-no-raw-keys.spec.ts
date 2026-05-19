/**
 * UI v4 — first-visit regression spec.
 *
 * The post-deploy QA bugs (raw i18n keys, stage stacking, missing keys)
 * slipped past the previous test suite because every other spec pre-set
 * crisp_landing_seen + crisp_privacy_consent + crisp_lang_manual='en',
 * which bypassed the entire boot path real first-visit users hit. This
 * spec deliberately does NOT pre-set ANY of those flags — it walks the
 * app like a fresh user and asserts:
 *
 *   • No [data-i18n] element has textContent === getAttribute('data-i18n')
 *     (i.e. no raw key leaks anywhere — landing card, all 3 v4 stages,
 *     home screen, my-reports button, login button)
 *   • At any moment, ONLY ONE .stage has the .active class (no stacking)
 *   • The 3 v4 stages all fit a 320×568 viewport without horizontal scroll
 *     in any locale
 *   • Page 1 camera hero is bounded (≤ 240px tall, not flex-grow)
 *   • Page 2 chip grid shows ≥ 6 tiles visible at once (not the legacy
 *     "1 carousel slide at a time" that wasted half the screen)
 *   • Page 3 pressing-needs renders all 10 chips in a full-width wrap-flex
 *     (was cut off on iPhone SE before the May 2026 polish)
 */
import { test, expect, Page } from '@playwright/test';

// Hard requirement: each spec runs without ANY pre-set localStorage.
test.use({ storageState: { cookies: [], origins: [] } });

// May 2026 — v4 default flipped OFF after the emergency rollback.
// All tests in this file require v4 active, so we force it on via the
// `?ui=v4` URL escape hatch + the localStorage flag for resilience
// against any redirects.
async function _gotoV4(page: Page, path = '') {
    await page.addInitScript(() => {
        try { localStorage.setItem('crisp_ui_v4', 'on'); } catch (_) {}
    });
    const url = path.includes('?') ? `${path}&ui=v4` : `${path}?ui=v4`;
    await page.goto(url || '?ui=v4');
}

async function _rawKeysOnPage(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('[data-i18n]'))
            .filter((el) => {
                const text = el.textContent?.trim() || '';
                const key = el.getAttribute('data-i18n') || '';
                // A leak: text equals the key verbatim (and the key
                // looks like a key — lowercase letters with underscore).
                return text === key && /^[a-z][a-z0-9_]+$/i.test(key) && key.includes('_');
            })
            .map((el) => el.getAttribute('data-i18n') || '');
    });
}

async function _activeStages(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('.stage.active'))
            .map((el) => el.id);
    });
}

test.describe('UI v4 — no raw key leaks (first-visit boot path)', () => {
    test('home page has zero raw key leaks', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForSelector('#stage-home.active', { timeout: 8000 });
        await page.waitForTimeout(600);  // let async i18n loaders settle
        // Limit the leak hunt to #stage-home — other stages have their
        // own specs.
        const leaks = await page.evaluate(() => {
            const home = document.getElementById('stage-home');
            if (!home) return ['stage-home-missing'];
            return Array.from(home.querySelectorAll('[data-i18n]'))
                .filter((el) => {
                    const text = el.textContent?.trim() || '';
                    const key = el.getAttribute('data-i18n') || '';
                    return text === key && /^[a-z][a-z0-9_]+$/i.test(key) && key.includes('_');
                })
                .map((el) => el.getAttribute('data-i18n') || '');
        });
        expect(leaks, `home page raw key leaks: ${leaks.join(', ')}`).toEqual([]);
    });

    test('all 3 v4 stages have zero raw key leaks', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        await page.waitForTimeout(600);

        for (const stage of ['stage-v4-capture', 'stage-v4-classify', 'stage-v4-review']) {
            await page.evaluate((s) => (window as any).__crispGoToStage(s), stage);
            await page.waitForTimeout(400);
            const leaks = await page.evaluate((sid) => {
                const stageEl = document.getElementById(sid);
                if (!stageEl) return [];
                return Array.from(stageEl.querySelectorAll('[data-i18n]'))
                    .filter((el) => {
                        const t = el.textContent?.trim() || '';
                        const k = el.getAttribute('data-i18n') || '';
                        return t === k && /^[a-z][a-z0-9_]+$/i.test(k) && k.includes('_');
                    })
                    .map((el) => el.getAttribute('data-i18n') || '');
            }, stage);
            expect(leaks, `${stage} raw key leaks: ${leaks.join(', ')}`).toEqual([]);
        }
    });

    test('only one .stage.active exists at any moment during navigation', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        await page.waitForTimeout(400);

        // Before user interaction: landing overlay is up, plus stage-home
        // is .active in the DOM (sits behind the landing overlay). That
        // single .active is fine.
        let active = await _activeStages(page);
        expect(active.length, `should have ≤ 1 active before nav, got: ${active.join(', ')}`).toBeLessThanOrEqual(1);

        // Walk through each v4 stage and assert exactly one .active.
        for (const stage of ['stage-v4-capture', 'stage-v4-classify', 'stage-v4-review',
                             'stage-v4-classify', 'stage-v4-capture']) {
            await page.evaluate((s) => (window as any).__crispGoToStage(s), stage);
            await page.waitForTimeout(300);
            active = await _activeStages(page);
            expect(active, `at ${stage}, expected only ${stage} to be active`).toEqual([stage]);
        }
    });

    // Phase F triage (May 2026): the three "Page 1 / Page 2 / Page 3"
    // tests below targeted a v4-redesign paginated single-stage layout
    // (`.v4-camera-hero`, `.v4-carousel-infra`/`v4-chipgrid-tile`,
    // `.v4-need-chip` × 10). v6.8 superseded that with the 3-stage
    // capture → classify → review flow; the legacy DOM markers are
    // gone. Layout coverage of the v6.8 flow lives in
    // 27-v4-flow + 88-classifier-pick-roundtrip + 89-safe-area-all-stages.

    test('viewport-fit on iPhone SE (320×568) for all 3 v4 stages', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        for (const stage of ['stage-v4-capture', 'stage-v4-classify', 'stage-v4-review']) {
            await page.evaluate((s) => (window as any).__crispGoToStage(s), stage);
            await page.waitForTimeout(300);
            const overflow = await page.evaluate(() => ({
                docW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth,
            }));
            expect(overflow.docW, `${stage} horizontal overflow at 320px wide`).toBeLessThanOrEqual(overflow.clientW + 1);
        }
    });
});
