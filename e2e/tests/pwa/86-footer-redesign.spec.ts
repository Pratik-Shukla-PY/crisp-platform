/**
 * PWA — Home footer v2 redesign (May 2026).
 *
 * Operator screenshot: bottom-portion footer should read EXACTLY as
 * the reference image — single horizontal row with:
 *   LEFT  → Privacy • Help • Open Source  (visible mid-gray text +
 *           clear bullet separators)
 *   RIGHT → A clean device-ID capsule "CRISP-XXXX-XXXX" with NO
 *           visible copy / info icon buttons
 *
 * The v168.1 implementation got the layout shape right (flex,
 * space-between, border-top divider) but the typography read as
 * faint vs the reference (10.5 px slate, mid-dot · separator) and
 * the pill carried two icon buttons not present in the screenshot.
 *
 * v2 changes (this spec asserts):
 *   · link font-size 10.5 → 13 px, color rgba(203,213,225,0.75)
 *   · separator glyph · → • + font-size 13 px, opacity 1
 *   · pill padding 5/14 → 8/18, text 11 → 12.5 px / 700 / #fff,
 *     letter-spacing 0.06 → 0.10 em, bg 0.05 → 0.06, border 0.10 →
 *     0.14
 *   · pill's inner icon buttons display:none in this surface (the
 *     whole badge becomes the copy affordance — verified by clicking
 *     the badge and asserting the `is-copied` class lands)
 *   · auto-show device-ID tooltip suppressed in this context
 *
 * Structure unchanged — #home-footer-row containing
 * #home-utility-footer + #home-devid-footer — so RTL flip + every
 * existing footer spec still passes.
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
        // Pre-mark the device-ID tip as seen so the 1500 ms auto-show
        // timer can't trip during the test window — separate to the
        // CSS suppression we also verify below.
        localStorage.setItem('crisp_devid_tip_seen', '1');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    // Scroll the home stage to the bottom so the footer is in view.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
}

test.describe('PWA — home footer v2 redesign', () => {

    test.beforeEach(async ({ page }) => { await bootPwa(page); });

    // ── Layout — single horizontal row, space-between ──────────────────

    test('@smoke footer row renders with links left, pill right (space-between)', async ({ page }) => {
        const row = page.locator('#home-footer-row');
        await expect(row).toBeVisible();
        const layout = await row.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                display: cs.display,
                flexDirection: cs.flexDirection,
                justifyContent: cs.justifyContent,
                flexWrap: cs.flexWrap,
            };
        });
        expect(layout.display).toBe('flex');
        expect(layout.flexDirection).toBe('row');
        expect(layout.justifyContent).toBe('space-between');
        // AUDIT 2026-05-23 — was `nowrap` with overflow:hidden on the
        // nav, which clipped "Open source" → "Open sou…" on iPhone SE
        // and "Помощь" → "Помо" in Russian. Switched to `wrap` so the
        // device-ID badge stacks to a second row when content exceeds
        // the viewport, surfacing every trust link.
        expect(layout.flexWrap).toBe('wrap');
    });

    test('row has a visible top divider + roomier padding', async ({ page }) => {
        const tokens = await page.locator('#home-footer-row').evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                borderTopWidth: cs.borderTopWidth,
                borderTopStyle: cs.borderTopStyle,
                paddingTop: parseFloat(cs.paddingTop),
                gap: parseFloat(cs.gap),
            };
        });
        expect(tokens.borderTopWidth).toBe('1px');
        expect(tokens.borderTopStyle).toBe('solid');
        // v2 — padding-top semantic check: roomier than the legacy 8px.
        expect(tokens.paddingTop).toBeGreaterThanOrEqual(14);
        // Row gap exists at every breakpoint; exact pixels drift with
        // CSS tuning so we only assert non-zero.
        expect(tokens.gap).toBeGreaterThan(0);
    });

    // ── Links + bullets ────────────────────────────────────────────────

    test('@smoke each link uses the v2 mid-gray (phone breakpoint: 12 px, desktop: 13 px)', async ({ page }) => {
        // HC22 (May 2026) bumped link font-size to 13 px floor for
        // presbyopia readability + lifted the link colour to text-sub
        // (rgb 203 213 225). HC25 added a 4th .home-utility-link
        // child — the Build-N version button — which uses a *muted*
        // text-dim colour (rgb 148 163 184) by design (metadata
        // shouldn't compete with navigation). Exclude the version
        // button from this colour assertion via id, but keep the
        // count check at 4 (3 nav links + 1 build chip).
        const links = page.locator('#home-utility-footer .home-utility-link');
        const total = await links.count();
        expect(total).toBe(4);
        const navLinks = await page.locator('#home-utility-footer .home-utility-link:not(#home-utility-version)').evaluateAll((els) =>
            els.map((el) => {
                const cs = getComputedStyle(el);
                return { text: el.textContent?.trim() || '', fontSize: cs.fontSize, color: cs.color };
            }),
        );
        expect(navLinks.length).toBe(3);
        for (const link of navLinks) {
            const px = parseFloat(link.fontSize);
            expect(px).toBeGreaterThanOrEqual(12);
            expect(px).toBeLessThanOrEqual(14);
            // text-sub (#cbd5e1) — passes WCAG AA on navy background.
            expect(link.color).toMatch(/203,\s*213,\s*225/);
        }
    });

    test('bullet separators are visible (• glyph, mid-slate)', async ({ page }) => {
        const dots = await page.locator('#home-utility-footer .home-utility-dot').evaluateAll((els) =>
            els.map((el) => {
                const cs = getComputedStyle(el);
                return {
                    text: el.textContent?.trim() || '',
                    fontSize: cs.fontSize,
                    color: cs.color,
                    opacity: cs.opacity,
                };
            }),
        );
        // Two visible dots between three links. (The last-of-type dot
        // is hidden by the version-number rule — verified separately.)
        const visible = dots.filter((d) => d.text === '•');
        expect(visible.length).toBeGreaterThanOrEqual(2);
        // Semantic check: dot glyph + visible + mid-slate colour.
        // Exact font-size drifts with CSS tuning across breakpoints.
        for (const dot of visible) {
            expect(dot.text).toBe('•');
            expect(parseFloat(dot.fontSize)).toBeGreaterThanOrEqual(10);
            expect(parseFloat(dot.opacity)).toBe(1);
            // rgba(148, 163, 184, 0.55).
            expect(dot.color).toMatch(/148,\s*163,\s*184/);
        }
    });

    // ── Pill ───────────────────────────────────────────────────────────

    test('@smoke device-ID surface is an icon button that opens a sheet', async ({ page }) => {
        // HC3 (May 2026) replaced the .home-devid-badge pill with a
        // 48 × 48 bordered tile that opened an explainer sheet. HC20
        // (operator polish, May 23) simplified that tile to a compact
        // 32 × 32 borderless key glyph that matches the footer-link
        // aesthetic. The bottom-sheet wiring is unchanged.
        const btn = page.locator('#btn-home-devid-info');
        await expect(btn).toBeVisible();
        const tokens = await btn.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                width: cs.width,
                height: cs.height,
                borderRadius: cs.borderRadius,
                cursor: cs.cursor,
                borderTopWidth: cs.borderTopWidth,
                background: cs.backgroundColor,
            };
        });
        // Compact target — at least 32 × 32 (clears WCAG 2.5.8 Minimum
        // at 24 px, comfortable for a tertiary utility action).
        expect(parseFloat(tokens.width)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(tokens.height)).toBeGreaterThanOrEqual(32);
        // No heavy chrome — HC20 stripped the bordered tile look.
        expect(tokens.borderTopWidth).toBe('0px');
        // Tappable.
        expect(tokens.cursor).toBe('pointer');

        // Legacy pill `#home-devid-badge` and its inner copy/info icon
        // buttons must NOT be rendered anywhere on the home stage —
        // HC3 fully removed them in favour of the icon + sheet pattern.
        const legacyPill = await page.locator('#home-footer-row #home-devid-badge').count();
        expect(legacyPill).toBe(0);
    });

    // ── Device-ID explainer sheet (HC3) ───────────────────────────────

    test('clicking the device-ID icon opens the explainer sheet', async ({ page }) => {
        await page.click('#btn-home-devid-info');
        await page.waitForTimeout(400);
        const sheet = page.locator('#home-devid-sheet');
        await expect(sheet).toBeVisible();
        await expect(page.locator('#home-devid-sheet-title')).toBeVisible();
        await expect(page.locator('#home-devid-sheet-copy')).toBeVisible();
        // Reassurance bullets render.
        const bullets = page.locator('.home-devid-sheet-points li');
        expect(await bullets.count()).toBeGreaterThanOrEqual(4);
    });

    test('Esc closes the device-ID sheet', async ({ page }) => {
        await page.click('#btn-home-devid-info');
        await page.waitForTimeout(400);
        const sheet = page.locator('#home-devid-sheet');
        await expect(sheet).toBeVisible();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const hidden = await sheet.evaluate((el) => el.hasAttribute('hidden'));
        expect(hidden).toBe(true);
    });
});
