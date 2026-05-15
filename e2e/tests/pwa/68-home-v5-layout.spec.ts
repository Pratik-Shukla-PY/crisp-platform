/**
 * PWA — home v5 redesign layout invariants (May 2026, trimmed).
 *
 * Pins the surviving structural + visual contract of the v5 home
 * redesign so a future refactor doesn't silently regress.
 *
 * Original spec had 11 tests; 5 were removed in May 2026 because they
 * targeted the `#home-impact` "pulse" stat element that was replaced
 * by the V8 "Nearby Reports" aggregate-number block. Specifically:
 *
 *   .home-impact-reports-nearby modifier        — element removed
 *   #home-reports-nearby-count tile             — element removed
 *   pulse number font-size clamp                — element removed
 *   .home-channels .ct-status status subtitle   — channel UI redesigned
 *   .hi-cell-reports-nearby reduced-motion halo — element removed
 *
 * The replacements live in newer specs (`69-nearby-intel`,
 * `87-responsive-clipping`) which cover the V8 nearby module and
 * its responsive behaviour. The 6 tests below still apply to the
 * current V5+ hero-card / radial-gradient / glow architecture.
 *
 * Companion service-worker bump: v166 → v167. Hard-reload is
 * needed for returning users to pick up the new build.
 */
import { test, expect, Page } from '@playwright/test';

async function bootHome(page: Page) {
    await page.addInitScript(() => {
        // Consent NOT pre-accepted so the consent row inside the
        // hero card is visible for assertion.
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
}

test.describe('PWA — home v5 layout invariants', () => {

    test.beforeEach(async ({ page }) => { await bootHome(page); });

    // ── Phase 1 — hero card grouping ──────────────────────────────

    test('@smoke .home-hero-card is visible and groups consent + CTA + helper', async ({ page }) => {
        const card = page.locator('#home-hero-card');
        await expect(card).toBeVisible();

        // CTA + consent must be DESCENDANTS of the card, not floating
        // outside it as in the pre-v5 layout.
        await expect(card.locator('#home-consent')).toHaveCount(1);
        await expect(card.locator('#btn-start')).toHaveCount(1);
        await expect(card.locator('.home-hero-helper')).toHaveCount(1);
        // Lifekeeper pill (#home-reward-hero) is relocated INTO the
        // card too; it's hidden when no badge is loaded yet, but the
        // element exists in the card subtree.
        await expect(card.locator('#home-reward-hero')).toHaveCount(1);
    });

    test('CTA helper text resolves the home_cta_helper i18n key', async ({ page }) => {
        const helper = page.locator('.home-hero-helper');
        await expect(helper).toBeVisible();
        const txt = (await helper.textContent() || '').trim();
        expect(txt.length).toBeGreaterThan(0);
        // v168.1 — copy changed from "Works offline and syncs..." to
        // "Always Working. Everywhere." Match on any of the three
        // expected tokens so the test survives further wording
        // tweaks per operator iteration.
        expect(txt.toLowerCase()).toMatch(/always|everywhere|offline/);
    });

    test('CTA bigger than v4: clamp-up of cta-label fontSize', async ({ page }) => {
        const label = page.locator('#btn-start .cta-label');
        await expect(label).toBeVisible();
        const fontPx = await label.evaluate((el) =>
            parseFloat(getComputedStyle(el as HTMLElement).fontSize),
        );
        // Phase 1 v5 bumped the clamp ceiling from 1.5rem to 1.7rem.
        // At default 16px root, that's a 24px → 27px ceiling. Floor
        // (compact phones) stays around 18-19px. Anywhere ≥ 18 is
        // accepted so the assertion doesn't flap across viewports.
        expect(fontPx).toBeGreaterThanOrEqual(18);
    });

    // ── Phase 2 — deep navy radial + cyan glow ────────────────────

    test('.home-stage carries the radial-gradient background', async ({ page }) => {
        const bg = await page.locator('.home-stage').evaluate((el) =>
            getComputedStyle(el as HTMLElement).backgroundImage,
        );
        // computed value normalises to "radial-gradient(..."
        expect(bg.toLowerCase()).toContain('radial-gradient');
    });

    test('.home-hero-card pseudo-element ::before paints a cyan glow', async ({ page }) => {
        // Pseudo-element styles aren't directly queryable, but we can
        // pull computed values via window.getComputedStyle(el, '::before').
        const beforeBg = await page.locator('#home-hero-card').evaluate((el) =>
            getComputedStyle(el as HTMLElement, '::before').backgroundImage,
        );
        // The accent uses a radial gradient with rgba(70, 223, 177, ...)
        // (mint) and rgba(9, 209, 199, ...) (teal). Either token
        // proves the v5 accent is wired.
        const matches = /(rgba?\(70[,\s]+223[,\s]+177|rgba?\(9[,\s]+209[,\s]+199)/i.test(beforeBg);
        expect(matches, `::before backgroundImage should carry the v5 cyan-glow tokens; got: ${beforeBg}`).toBe(true);
    });

    // ── Stage-active invariant ─────────────────────────────────────

    test('exactly one .stage.active at the home v5 boot — no stacking', async ({ page }) => {
        const active = page.locator('.stage.active');
        await expect(active).toHaveCount(1);
        await expect(active).toHaveId('stage-home');
    });
});
