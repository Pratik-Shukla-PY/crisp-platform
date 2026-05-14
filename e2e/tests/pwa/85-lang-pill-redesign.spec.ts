/**
 * PWA — Language pill v6.1 redesign (May 2026).
 *
 * Operator screenshot: the top-right language switcher looked flat
 * (rgba(0,0,0,0.3) chip + 6px green halo) and "ugly" — wanted a
 * premium, modern capsule that reads as live (LED green dot + cyan
 * ambient glow) and that visually anchors the home stage's top-right.
 *
 * v6 (v171) shipped the visual reskin but the operator pinged again:
 * the cyan halo at alpha 0.18 was perceptually invisible against the
 * dark home bg, and border-radius 24 + the pill's short content
 * height left the corners reading squarish. v6.1 (v172) fixes both:
 *
 * v6.1 tokens:
 *   · .lang-switcher  — navy linear-gradient(180deg, #1b2a44, #0e1828)
 *                       border-radius 999 (full capsule), padding 7/14,
 *                       right: 24 (was 20, breathing room for the halo
 *                       before .mobile-screen overflow:hidden clips it),
 *                       4-layer shadow: cyan halo (alpha 0.45, blur 28,
 *                       spread 2) + grounding + inset top + inset bottom
 *   · connectivity-dot — 12px, radial-gradient LED core, 3-layer green
 *                        halo (4px tight + 10px medium + 22px diffuse)
 *   · .lps-flag / .lps-code — 1rem flag, 0.78rem code, pure white,
 *                              tighter letter-spacing for "EN"
 *
 * Structure unchanged — #connectivity-dot + #btn-lang-current
 * (containing .lps-flag + .lps-code) — so the install-prompt offset
 * (right: 158px from the pill), the RTL flip, and every existing
 * spec that clicks the pill (incl. 56-flag-rendering) still works.
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

    test('@smoke pill renders with dot + flag + code in the expected order', async ({ page }) => {
        const pill = page.locator('#lang-switcher');
        await expect(pill).toBeVisible();
        // Dot before button — the pill reads left-to-right "dot · flag · code".
        await expect(pill.locator('#connectivity-dot')).toBeVisible();
        const btn = pill.locator('#btn-lang-current');
        await expect(btn).toBeVisible();
        await expect(btn.locator('.lps-flag[data-cc="gb"]')).toHaveCount(1);
        await expect(btn.locator('.lps-code')).toContainText('EN');
    });

    // ── Pill container — navy gradient + multi-shadow ──────────────────

    test('@smoke pill uses the navy gradient (not the old flat black chip)', async ({ page }) => {
        const bgImage = await page.locator('#lang-switcher').evaluate((el) => {
            return getComputedStyle(el).backgroundImage;
        });
        // Gradients show up in `background-image`, not `background-color`.
        // The exact RGB serialisation varies by browser but the linear-
        // gradient direction (180deg / "to bottom") + two navy stops are
        // stable: both stops use the same hex tokens across engines.
        expect(bgImage, `lang-switcher background-image: ${bgImage}`).toMatch(/linear-gradient/);
        // Both navy stops should be present (Chrome serialises hex as
        // rgb(); match the rgb() equivalents of #1b2a44 and #0e1828).
        expect(bgImage).toMatch(/rgb\(27,\s*42,\s*68\)/);   // #1b2a44
        expect(bgImage).toMatch(/rgb\(14,\s*24,\s*40\)/);   // #0e1828
    });

    test('pill has the cyan ambient glow (v6.1 visibility pass) + grounding + inset highlights', async ({ page }) => {
        const boxShadow = await page.locator('#lang-switcher').evaluate((el) => {
            return getComputedStyle(el).boxShadow;
        });
        // Four layered shadows in v6.1 (cyan + grounding + inset top + inset bottom).
        expect(boxShadow.split(/,\s*(?![^()]*\))/).length).toBeGreaterThanOrEqual(4);
        // Cyan glow — #09D1C7 at alpha 0.45 (was 0.18 in v6).
        expect(boxShadow).toMatch(/rgba?\(\s*9,\s*209,\s*199/);
        // Inset on at least one side — distinguishes from outer-only shadow.
        expect(boxShadow).toMatch(/inset/);
        // v6.1 — alpha 0.45 not 0.18. Use a regex that matches "0.45" or
        // "0.449"/"0.451" tolerance to allow for browser rounding.
        expect(boxShadow).toMatch(/0\.4[0-9]/);
    });

    test('pill is a full capsule (999px radius) with v6.1 roomier padding', async ({ page }) => {
        const tokens = await page.locator('#lang-switcher').evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                borderRadius: cs.borderRadius,
                paddingTop: cs.paddingTop,
                paddingLeft: cs.paddingLeft,
            };
        });
        // v6.1 — full capsule. Some browsers serialise 999px verbatim;
        // others may serialise to a smaller value when clamped. Accept
        // anything ≥ 100px (clearly "fully rounded", not a 24px square).
        expect(parseInt(tokens.borderRadius, 10)).toBeGreaterThanOrEqual(100);
        expect(tokens.paddingTop).toBe('7px');
        expect(tokens.paddingLeft).toBe('14px');
    });

    test('pill stays compact (max-width 140px) and single-line', async ({ page }) => {
        const geom = await page.locator('#lang-switcher').evaluate((el) => {
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                maxWidth: cs.maxWidth,
                whiteSpace: cs.whiteSpace,
                width: rect.width,
                height: rect.height,
            };
        });
        expect(geom.maxWidth).toBe('140px');
        expect(geom.whiteSpace).toBe('nowrap');
        // Width should be well under the cap with a 2-char code.
        expect(geom.width).toBeLessThanOrEqual(140);
        // Single-line height — sanity bound to catch any future wrap regression.
        expect(geom.height).toBeLessThan(40);
    });

    // ── Connectivity dot — 11px, radial-gradient LED, layered halo ─────

    test('@smoke connectivity dot is 12px with a radial-gradient LED core', async ({ page }) => {
        const dot = await page.locator('#connectivity-dot').evaluate((el) => {
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                width: rect.width,
                height: rect.height,
                bgImage: cs.backgroundImage,
                borderRadius: cs.borderRadius,
            };
        });
        // v6.1 — 12 ± small subpixel tolerance.
        expect(Math.round(dot.width)).toBe(12);
        expect(Math.round(dot.height)).toBe(12);
        // Radial gradient — distinguishes the v6 LED from the old flat fill.
        expect(dot.bgImage, `dot background-image: ${dot.bgImage}`).toMatch(/radial-gradient/);
        // Perfectly round
        expect(dot.borderRadius).toBe('50%');
    });

    test('connectivity dot (online) has the 3-layer green halo (v6.1)', async ({ page }) => {
        // The connectivity probe can flip the dot to offline if the
        // backend isn't reachable. Force-online for the assertion so
        // the test doesn't depend on test infra connectivity.
        await page.evaluate(() => {
            const d = document.getElementById('connectivity-dot');
            if (d) {
                d.classList.remove('connectivity-offline');
                d.classList.add('connectivity-online');
            }
        });
        const shadow = await page.locator('#connectivity-dot').evaluate((el) => {
            return getComputedStyle(el).boxShadow;
        });
        // v6.1 — three layered shadows (tight bright + medium + diffuse).
        expect(shadow.split(/,\s*(?![^()]*\))/).length).toBeGreaterThanOrEqual(3);
        // Green colour — #80EE98 = rgb(128, 238, 152).
        expect(shadow).toMatch(/rgba?\(\s*128,\s*238,\s*152/);
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

    // ── Positional guard — alignment-rhythm pass is preserved ─────────

    test('pill is anchored at top: 16px, right: 24px (v6.1 — bumped from 20 so the halo isn\'t clipped)', async ({ page }) => {
        const tokens = await page.locator('#lang-switcher').evaluate((el) => {
            const cs = getComputedStyle(el);
            return { position: cs.position, top: cs.top, right: cs.right };
        });
        expect(tokens.position).toBe('absolute');
        expect(tokens.top).toBe('16px');
        // v6.1 — right was 20 in v6; bumped to 24 so the cyan halo has
        // breathing room before .mobile-screen overflow:hidden clips it.
        expect(tokens.right).toBe('24px');
    });
});
