/**
 * PWA — home v5 redesign layout invariants (May 2026).
 *
 * Pins the structural + visual contract of the v5 home redesign so
 * a future refactor doesn't silently regress:
 *
 *   Phase 1 — hero-card grouping (Lifekeeper pill + consent + CTA +
 *             reassurance helper inside .home-hero-card)
 *   Phase 2 — deep navy radial bg on .home-stage; cyan glow on the
 *             hero card via ::before
 *   Phase 3 — pulse stat block (.home-impact-pulse) with animated
 *             halo + caption; respects prefers-reduced-motion
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
        // English baseline string — alt translations are validated
        // by node scripts/validate-i18n.mjs not here.
        expect(txt.toLowerCase()).toContain('offline');
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

    // ── Phase 3 — pulse stat block ────────────────────────────────

    test('@smoke .home-impact carries the .home-impact-pulse modifier', async ({ page }) => {
        const card = page.locator('#home-impact');
        await expect(card).toHaveClass(/home-impact-pulse/);
    });

    test('.hi-caption is rendered and bound to home_pulse_label', async ({ page }) => {
        const caption = page.locator('#home-impact .hi-caption');
        await expect(caption).toBeVisible();
        const txt = (await caption.textContent() || '').trim();
        expect(txt.length).toBeGreaterThan(0);
        // English baseline — "through verified reports". Any
        // sub-string match keeps the test resilient to copy tweaks.
        expect(txt.toLowerCase()).toMatch(/verified|reports/);
    });

    test('lives count tile is still present + i18n-bound', async ({ page }) => {
        // Phase 3 only added decoration; the original counter element
        // + label remain so the data flow is unchanged.
        await expect(page.locator('#home-lives-count')).toBeVisible();
        const label = page.locator('#home-impact .hi-label');
        await expect(label).toBeVisible();
        const labelText = (await label.textContent() || '').toLowerCase();
        expect(labelText).toMatch(/lives|life|saved/);
    });

    test('reduced-motion users get a static halo (no animation)', async ({ page, context }) => {
        // Emulate prefers-reduced-motion: reduce. The :before ring
        // continues to render but with animation-name: none.
        await context.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        await page.waitForLoadState('networkidle');

        const animName = await page.locator('#home-impact .hi-cell-lives').evaluate((el) =>
            getComputedStyle(el as HTMLElement, '::before').animationName,
        );
        // Either "none" or the CSS keyword empty string indicates
        // the animation is gated.
        expect(['none', '', 'normal']).toContain(animName.toLowerCase());
    });

    // ── Stage-active invariant ─────────────────────────────────────

    test('exactly one .stage.active at the home v5 boot — no stacking', async ({ page }) => {
        const active = page.locator('.stage.active');
        await expect(active).toHaveCount(1);
        await expect(active).toHaveId('stage-home');
    });
});
