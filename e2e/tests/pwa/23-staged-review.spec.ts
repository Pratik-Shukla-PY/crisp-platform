/**
 * UI v2: 3-page stage-review split (Apr 2026).
 *
 * Pins the new low-literacy flow shipped in this sprint:
 *
 *  - Page 1 "What happened?" — crisis + damage + what-damaged chips.
 *  - Page 2 "How bad + where?" — severity + location + optional service status.
 *  - Page 3 "Review & send"   — description, optional building, Submit.
 *
 * Feature flag `localStorage.crisp_ui_v2` defaults to `on`; setting it to
 * `off` reverts to the pre-v2 monolithic review flow. Both branches pinned
 * below so accidental flip-flops surface in CI before hitting the field.
 *
 * No backend calls — we drive the stage machine with the testability hooks
 * wired in app.js (`__crispGoToStage`, `__crispGoToReviewV2Page`,
 * `__crispUiV2`). All DOM assertions run against a locally-loaded PWA page.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
    await page.goto('index.html');
    await page.evaluate(() => {
        // Pre-seed consent + device + the v2 flag default so the stage
        // machine boots without modal interrupts.
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_device_hash', 'DEV-E2E-V2REVIEW');
    });
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
        const c = document.getElementById('consent-overlay');
        if (c) c.style.display = 'none';
    });
}

async function jumpToReview(page) {
    // Skip capture stages and land directly on stage-review — the page
    // split is what we're pinning; the capture flow is covered by 02/06.
    await page.evaluate(() => {
        const g: any = (window as any).__crispGoToStage;
        if (typeof g === 'function') g('stage-review');
    });
    await expect(page.locator('#stage-review')).toBeVisible({ timeout: 5_000 });
}

test.describe('UI v2 — 3-page stage-review split', () => {

    test('@smoke feature flag defaults to ON + test hooks exposed', async ({ page }) => {
        await openPwa(page);
        const flags = await page.evaluate(() => ({
            uiV2: (window as any).__crispUiV2,
            goToPage: typeof (window as any).__crispGoToReviewV2Page,
            iconPack: typeof (window as any).crispIconFor,
        }));
        expect(flags.uiV2).toBe(true);
        expect(flags.goToPage).toBe('function');
        expect(flags.iconPack).toBe('function');
    });

    test('v2 review stage shows 3 distinct pages, one at a time', async ({ page }) => {
        await openPwa(page);
        await jumpToReview(page);

        // Page 1 — "What happened?" — only [data-v2-page="1"] blocks visible.
        await page.evaluate(() => (window as any).__crispGoToReviewV2Page(1));
        const pagesVisible = async () => page.evaluate(() => {
            const rows: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
            document.querySelectorAll('#stage-review [data-v2-page]').forEach((el: any) => {
                const p = el.getAttribute('data-v2-page');
                const visible = el.offsetParent !== null;
                if (p && visible) rows[p] = (rows[p] || 0) + 1;
            });
            return rows;
        });
        let v = await pagesVisible();
        expect(v['1']).toBeGreaterThan(0);
        expect(v['2']).toBe(0);
        expect(v['3']).toBe(0);

        // Page 2 — "How bad + where?"
        await page.evaluate(() => (window as any).__crispGoToReviewV2Page(2));
        v = await pagesVisible();
        expect(v['2']).toBeGreaterThan(0);
        expect(v['1']).toBe(0);
        expect(v['3']).toBe(0);

        // Page 3 — "Review & send"
        await page.evaluate(() => (window as any).__crispGoToReviewV2Page(3));
        v = await pagesVisible();
        expect(v['3']).toBeGreaterThan(0);
        expect(v['1']).toBe(0);
        expect(v['2']).toBe(0);
    });

    test('v2 chips render colour SVG icons (no FontAwesome fallback)', async ({ page }) => {
        await openPwa(page);
        await jumpToReview(page);
        await page.evaluate(() => (window as any).__crispGoToReviewV2Page(1));

        // Every chip that has a data-type or data-crisis should now carry
        // an injected <span class="chip-ic"><svg ...></span>. The old
        // <i class="fa-solid"> may still be present but must be hidden
        // via CSS (body[data-ui-v2] rule).
        const hasSvg = await page.evaluate(() => {
            const out: Array<{ key: string; svg: boolean }> = [];
            document.querySelectorAll('#stage-review .chip-btn[data-type], #stage-review .chip-btn[data-crisis]').forEach((el: any) => {
                const k = el.getAttribute('data-type') || el.getAttribute('data-crisis') || '?';
                const svg = !!el.querySelector('.chip-ic svg');
                out.push({ key: k, svg });
            });
            return out;
        });
        // At minimum, half the chips on page 1 must have a hydrated SVG.
        const withSvg = hasSvg.filter((r) => r.svg);
        expect(withSvg.length).toBeGreaterThan(0);
        // Every entry that lacks an SVG should be called out for a fix.
        const missing = hasSvg.filter((r) => !r.svg);
        expect(missing, `Chips missing SVG icon: ${missing.map((m) => m.key).join(',')}`).toEqual([]);
    });

    test('flag glyph fallback: every language tile carries an ISO code', async ({ page }) => {
        await openPwa(page);
        // The language picker lives on stage-home; first-boot popup may
        // auto-close — re-open it.
        await page.evaluate(() => {
            const g: any = (window as any).__crispGoToStage;
            if (typeof g === 'function') g('stage-home');
        });
        // Count .lpf-iso siblings across the picker. Must match the .lpf-glyph count.
        const counts = await page.evaluate(() => {
            const glyphs = document.querySelectorAll('.lpf-glyph').length;
            const isos = document.querySelectorAll('.lpf-iso').length;
            return { glyphs, isos };
        });
        expect(counts.glyphs).toBeGreaterThan(0);
        expect(counts.isos).toBe(counts.glyphs);
    });

    test('sticky header: review-page-header stays pinned + z-index ≥ 10', async ({ page }) => {
        await openPwa(page);
        await jumpToReview(page);
        const style = await page.evaluate(() => {
            const h = document.getElementById('review-page-header');
            if (!h) return null;
            const cs = getComputedStyle(h);
            return { position: cs.position, zIndex: cs.zIndex, backdrop: cs.backdropFilter };
        });
        expect(style).not.toBeNull();
        expect(style!.position).toBe('sticky');
        const z = parseInt(style!.zIndex || '0', 10);
        expect(z).toBeGreaterThanOrEqual(10);
    });

    test('v1 rollback: setting crisp_ui_v2=off restores legacy 2-page flow', async ({ page }) => {
        await page.goto('index.html');
        await page.evaluate(() => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_device_hash', 'DEV-E2E-V2OFF');
            localStorage.setItem('crisp_ui_v2', 'off');
        });
        await page.reload();
        const v2 = await page.evaluate(() => (window as any).__crispUiV2);
        expect(v2).toBe(false);

        // With v2 off, [data-v2-page] attributes should NOT gate visibility;
        // the classic two-page review flow takes over.
        const legacyOk = await page.evaluate(() => {
            // Count legacy review-page divs — the pre-v2 code uses
            // [data-review-page], not [data-v2-page].
            const legacyPages = document.querySelectorAll('#stage-review .review-page').length;
            return legacyPages >= 2;
        });
        expect(legacyOk, 'legacy review-page wrappers should exist for rollback').toBe(true);
    });
});
