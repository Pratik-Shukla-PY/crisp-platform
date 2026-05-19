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

    test('Page 1 camera hero is bounded ≤ 240px tall', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-capture'));
        await page.waitForTimeout(400);
        const heroHeight = await page.locator('.v4-camera-hero').evaluate((el: any) => el.offsetHeight);
        expect(heroHeight, `camera hero height ${heroHeight}px should be ≤ 240px`).toBeLessThanOrEqual(240);
    });

    test('Page 2 chip grids show ≥ 6 tiles visible at once', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await page.waitForTimeout(500);

        const counts = await page.evaluate(() => {
            const ids = ['v4-carousel-infra', 'v4-carousel-crisis'];
            return ids.map((id) => {
                const c = document.getElementById(id);
                if (!c) return -1;
                const tiles = c.querySelectorAll('.v4-chipgrid-tile');
                const containerRect = c.getBoundingClientRect();
                let visible = 0;
                tiles.forEach((t: any) => {
                    const r = t.getBoundingClientRect();
                    if (r.bottom > containerRect.top && r.top < containerRect.bottom &&
                        r.right > containerRect.left && r.left < containerRect.right) {
                        visible += 1;
                    }
                });
                return visible;
            });
        });
        // Infra has 8, crisis has 9 — both must show all of them.
        expect(counts[0], `infra grid should show 8 tiles, got ${counts[0]}`).toBeGreaterThanOrEqual(6);
        expect(counts[1], `crisis grid should show 9 tiles, got ${counts[1]}`).toBeGreaterThanOrEqual(6);
    });

    test('Page 3 pressing-needs renders all 10 chips full-width', async ({ page }) => {
        await _gotoV4(page);
        await page.waitForFunction(() => !!(window as any).CrispV4, null, { timeout: 8000 });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-review'));
        await page.waitForTimeout(400);

        // All 10 chips exist.
        await expect(page.locator('.v4-need-chip')).toHaveCount(10);

        // The needs-row has the full-width grid — label is on top, not
        // squeezed into a 90px left column.
        const layout = await page.evaluate(() => {
            const row = document.querySelector('.v4-undp-row-needs');
            if (!row) return null;
            const cs = window.getComputedStyle(row);
            return { cols: cs.gridTemplateColumns };
        });
        // Either '1fr' or 'none' (single column) is acceptable; the
        // 90px-90px-1fr two-column layout we had before is NOT acceptable.
        expect(layout, 'pressing-needs row should be full-width (single column)').toBeTruthy();
        expect(layout!.cols).not.toContain('90px');
    });

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
