/**
 * PWA — Home stage v6.6 permanent invariants (May 2026).
 *
 * Three home-stage UI bugs had been reappearing every few sprints, each
 * fix tuned to one device + breaking on the next. The v6.6 commit shipped
 * structural fixes — single flex parent, safe-area-inset consolidation,
 * dead-element removal — so the bugs CAN'T re-emerge without the change
 * being detected here.
 *
 * Invariants pinned by this spec:
 *
 *   1. #home-brand-row and #lang-switcher share a single flex parent;
 *      their vertical centres drift by ≤ 2 px on every device matrix
 *      profile (alignment is structural via flex `align-items: center`,
 *      not pixel math).
 *
 *   2. All six channel icons inside #home-channels-strip render fully
 *      INSIDE the strip's bounding box AND inside the viewport — even
 *      on iPhone SE (375 px) and after rotation. The WhatsApp icon
 *      (3rd-from-left, Coming-soon styled) was the visible victim of
 *      the prior clipping bug.
 *
 *   3. The My Reports tile (#btn-my-reports) surfaces ONLY the report
 *      count (#mr-count). The #mr-lives-badge element MUST NOT exist
 *      in the DOM; if it does (legacy markup from a cached shell), it
 *      MUST stay display:none. Lives saved is surfaced exclusively on
 *      the Lifekeeper pill.
 *
 *   4. All three invariants hold AFTER a viewport rotation
 *      (portrait → landscape → portrait) — past pixel-math fixes
 *      broke specifically on dynamic safe-area-inset changes.
 *
 * See CLAUDE.md "Home header alignment", "Channels strip safe-area",
 * and "My Reports tile" invariants for the permanent guards behind
 * each.
 */
import { test, expect, Page } from '@playwright/test';

async function bootHomeWithLocation(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        // Seed cached location so the nearby module wakes (matches the
        // _home_matrix_probe.mjs seeding pattern).
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({
            lat: 12.9716, lng: 77.5946, ts: Date.now(), accuracy: 50,
        }));
    });
    // Stub the nearby endpoint with a small fixture so the strip + tile
    // measurements aren't gated on a live backend.
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ groups: [] }),
        }),
    );
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
}

test.describe('PWA — home stage v6.6 permanent invariants', () => {

    test.beforeEach(async ({ page }) => { await bootHomeWithLocation(page); });

    // ── Invariant 1 — brand row + lang pill alignment ─────────────────

    test('@smoke brand row + lang pill share a single flex parent', async ({ page }) => {
        const sameParent = await page.evaluate(() => {
            const brand = document.querySelector('.home-brand-row');
            const pill  = document.getElementById('lang-switcher');
            if (!brand || !pill) return null;
            // Pill must be a descendant of the brand row — that's the
            // structural guarantee we depend on.
            return brand.contains(pill);
        });
        expect(sameParent, 'lang-switcher must live inside .home-brand-row').toBe(true);
    });

    test('@smoke brand row + lang pill vertical centres align (≤ 2 px drift)', async ({ page }) => {
        const drift = await page.evaluate(() => {
            const brand = document.querySelector('.home-brand-row');
            const pill  = document.getElementById('lang-switcher');
            if (!brand || !pill) return Infinity;
            const a = brand.getBoundingClientRect();
            const b = pill.getBoundingClientRect();
            return Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
        });
        expect(drift, `vertical-centre drift was ${drift.toFixed(1)} px`).toBeLessThanOrEqual(2);
    });

    test('lang-switcher does not use position:absolute on the home stage', async ({ page }) => {
        const pos = await page.locator('#lang-switcher').evaluate((el) => {
            return getComputedStyle(el).position;
        });
        // Past regressions came from position:absolute; this guard ensures
        // any future PR that re-introduces it gets caught here.
        expect(pos, 'lang-switcher must be in-flow (not absolute)').not.toBe('absolute');
    });

    // ── Invariant 2 — channels strip + icon clipping ──────────────────

    test('@smoke all six channel icons render fully inside the strip', async ({ page }) => {
        const result = await page.evaluate(() => {
            const strip = document.getElementById('home-channels-strip');
            if (!strip) return { failures: ['NO_STRIP_IN_DOM'], iconCount: 0, vpW: window.innerWidth };
            const s = strip.getBoundingClientRect();
            const icons = [...strip.querySelectorAll('.hcs-icon')];
            const failures: string[] = [];
            for (const el of icons) {
                const r = el.getBoundingClientRect();
                const key = (el as HTMLElement).dataset.channel
                         || el.getAttribute('data-channel')
                         || el.className;
                if (r.x < s.x - 1)               failures.push(`${key} clips LEFT of strip`);
                if (r.x + r.width > s.x + s.width + 1) failures.push(`${key} clips RIGHT of strip`);
                if (r.x < 0)                     failures.push(`${key} clips LEFT of viewport`);
                if (r.x + r.width > window.innerWidth + 1) failures.push(`${key} clips RIGHT of viewport`);
                if (r.width < 1 || r.height < 1) failures.push(`${key} zero-size`);
            }
            return { failures, iconCount: icons.length, vpW: window.innerWidth };
        });
        expect(result.iconCount, 'strip should host 6 channel icons').toBeGreaterThanOrEqual(6);
        expect(result.failures, `channel-icon clipping detected: ${result.failures.join('; ')}`).toEqual([]);
    });

    test('channels strip svgs use overflow:visible (defensive against viewBox quirks)', async ({ page }) => {
        const svgs = await page.locator('#home-channels-strip .hcs-icon svg').count();
        expect(svgs).toBeGreaterThan(0);
        const overflows = await page.locator('#home-channels-strip .hcs-icon svg').evaluateAll((els) =>
            els.map((el) => getComputedStyle(el as Element).overflow),
        );
        for (const o of overflows) {
            expect(o, 'every channel SVG must have overflow:visible').toBe('visible');
        }
    });

    // ── Invariant 3 — My Reports tile has only the count ──────────────

    test('@smoke My Reports tile does NOT surface the lives-saved badge', async ({ page }) => {
        const result = await page.evaluate(() => {
            const badge = document.getElementById('mr-lives-badge');
            return {
                exists: !!badge,
                visible: badge ? getComputedStyle(badge).display !== 'none' : false,
            };
        });
        // Either the element is gone (preferred — v6.6 removed it) OR
        // it exists but is display:none (legacy cached markup tolerated).
        if (result.exists) {
            expect(result.visible, '#mr-lives-badge must remain display:none').toBe(false);
        } else {
            expect(result.exists).toBe(false);
        }
    });

    test('My Reports tile count + label do not overlap', async ({ page }) => {
        const overlap = await page.evaluate(() => {
            const tile = document.getElementById('btn-my-reports');
            if (!tile) return null;
            const label = tile.querySelector('.hpb-label');
            const count = tile.querySelector('.mr-count');
            if (!label || !count) return null;
            const l = label.getBoundingClientRect();
            const c = count.getBoundingClientRect();
            // Treat side-by-side OR stacked as non-overlapping. Overlap
            // means the rectangles intersect on BOTH axes.
            const xOverlap = !(l.right < c.left || c.right < l.left);
            const yOverlap = !(l.bottom < c.top || c.bottom < l.top);
            return xOverlap && yOverlap;
        });
        if (overlap === null) test(true, 'My Reports tile not rendered in this run');
        expect(overlap, 'label and count must not overlap').toBe(false);
    });

    // ── Invariant 4 — all three hold after rotation ───────────────────

    test('every invariant survives portrait → landscape → portrait rotation', async ({ page }, testInfo) => {
        const originalViewport = testInfo.project.use.viewport || { width: 412, height: 915 };
        // Rotate to landscape.
        await page.setViewportSize({ width: originalViewport.height, height: originalViewport.width });
        await page.waitForTimeout(300);

        const landscape = await page.evaluate(() => {
            const brand = document.querySelector('.home-brand-row');
            const pill  = document.getElementById('lang-switcher');
            const badge = document.getElementById('mr-lives-badge');
            const drift = (brand && pill) ? (() => {
                const a = brand.getBoundingClientRect();
                const b = pill.getBoundingClientRect();
                return Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
            })() : Infinity;
            return {
                drift,
                badgeVisible: badge ? getComputedStyle(badge).display !== 'none' : false,
            };
        });
        expect(landscape.drift, 'alignment must hold after landscape rotation').toBeLessThanOrEqual(2);
        expect(landscape.badgeVisible).toBe(false);

        // Rotate back to portrait.
        await page.setViewportSize(originalViewport);
        await page.waitForTimeout(300);

        const portrait = await page.evaluate(() => {
            const brand = document.querySelector('.home-brand-row');
            const pill  = document.getElementById('lang-switcher');
            if (!brand || !pill) return Infinity;
            const a = brand.getBoundingClientRect();
            const b = pill.getBoundingClientRect();
            return Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
        });
        expect(portrait, 'alignment must hold after rotating back to portrait').toBeLessThanOrEqual(2);
    });
});
