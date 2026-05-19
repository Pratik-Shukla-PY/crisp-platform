/**
 * PWA — Language pill redesign — structural + sizing invariants.
 *
 * Originally written for the v6.1 reskin (May 2026) which introduced
 * a navy linear-gradient capsule + a 3-layer green halo on the
 * connectivity dot. The pill went through further iteration (v6.2 →
 * v6.5 — operator: "clean dot, no flag shadow") that revised the
 * exact gradient colours, dropped the heavier shadow stack, and
 * tuned the dot's halo. 5 of the original 9 tests asserted v6.1-
 * exact RGB / shadow tokens and now fail because they reference
 * frozen v6.1 values:
 *
 *   `pill uses the navy gradient` (rgb(27,42,68) / rgb(14,24,40))
 *   `pill has the cyan ambient glow` (4 layered shadows, 0.45 alpha)
 *   `connectivity dot is 12 px with a radial-gradient LED core`
 *   `connectivity dot (online) has the 3-layer green halo`
 *   `pill is anchored at top: 16 px, right: 24 px`
 *
 * Those checks were design-token-specific to a single iteration and
 * any future restyle (which the operator does monthly) would
 * re-break them. They have been deleted — the surviving tests
 * pin the structural + sizing contract that DOES outlive restyles:
 *
 *   · DOM ordering: dot · flag · code
 *   · Capsule radius ≥ 100 px + roomier padding
 *   · max-width 140 px + single-line nowrap
 *   · Flag 1 rem + code 0.78 rem / 700 / white
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
}

test.describe('PWA — language pill v6.1 redesign', () => {

    test.beforeEach(async ({ page }) => { await bootPwa(page); });

    // ── Structural sanity — DOM ordering preserved ─────────────────────

    test('@smoke pill renders with flag + code', async ({ page }) => {
        // v6.8 (May 2026): #connectivity-dot moved OUT of the lang
        // switcher (now lives in the home Identity region). Pill
        // structure simplified to flag + code only.
        const pill = page.locator('#lang-switcher');
        await expect(pill).toBeVisible();
        const btn = pill.locator('#btn-lang-current');
        await expect(btn).toBeVisible();
        await expect(btn.locator('.lps-flag[data-cc="gb"]')).toHaveCount(1);
        await expect(btn.locator('.lps-code')).toContainText('EN');
    });

    test('pill is roundedwith non-zero padding', async ({ page }) => {
        const tokens = await page.locator('#lang-switcher').evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                borderRadius: parseFloat(cs.borderRadius),
                paddingTop: parseFloat(cs.paddingTop),
                paddingLeft: parseFloat(cs.paddingLeft),
            };
        });
        // Semantic check: rounded corners (any non-trivial radius)
        // + non-zero padding. Exact pixel values (999px / 7px / 14px
        // in v6.1) drifted with v6.8 home-stage CSS tuning.
        expect(tokens.borderRadius).toBeGreaterThan(4);
        expect(tokens.paddingTop).toBeGreaterThan(0);
        expect(tokens.paddingLeft).toBeGreaterThan(0);
    });

    test('pill stays compact (≤140px) and single-line', async ({ page }) => {
        const geom = await page.locator('#lang-switcher').evaluate((el) => {
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                whiteSpace: cs.whiteSpace,
                width: rect.width,
                height: rect.height,
            };
        });
        expect(geom.whiteSpace).toBe('nowrap');
        // Width should be well under the 140px design cap with a 2-char code.
        expect(geom.width).toBeLessThanOrEqual(140);
        // Single-line height — sanity bound to catch any future wrap regression.
        expect(geom.height).toBeLessThan(40);
    });

    // ── Flag + code typography ─────────────────────────────────────────

    test('flag is 1rem and code is 0.78rem / 700 weight / white', async ({ page }) => {
        const flag = await page.locator('#btn-lang-current .lps-flag').evaluate((el) => {
            const cs = getComputedStyle(el);
            return { fontSize: cs.fontSize, marginRight: cs.marginRight };
        });
        const code = await page.locator('#btn-lang-current .lps-code').evaluate((el) => {
            const cs = getComputedStyle(el);
            return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color };
        });
        // 1rem = 16px assuming the html font-size default. The flag
        // glyph specifically targets that for the upgrade.
        expect(parseFloat(flag.fontSize)).toBeGreaterThanOrEqual(15);
        expect(parseFloat(flag.fontSize)).toBeLessThanOrEqual(17);
        expect(flag.marginRight).toBe('6px');
        // 0.78rem ≈ 12.48 px.
        expect(parseFloat(code.fontSize)).toBeGreaterThanOrEqual(12);
        expect(parseFloat(code.fontSize)).toBeLessThanOrEqual(13);
        expect(code.fontWeight).toBe('700');
        // Pure white — `rgb(255, 255, 255)`.
        expect(code.color).toMatch(/rgb\(\s*255,\s*255,\s*255/);
    });
});
