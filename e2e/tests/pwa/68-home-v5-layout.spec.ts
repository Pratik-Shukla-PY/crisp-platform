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

    // ── Phase 3 — pulse stat block ────────────────────────────────

    test('@smoke .home-impact carries the .home-impact-reports-nearby modifier', async ({ page }) => {
        // Bottom-portion refresh (May 2026) — pulse block repurposed
        // for "verified reports nearby". The .home-impact-pulse
        // base class still travels alongside for shared decoration.
        const card = page.locator('#home-impact');
        await expect(card).toHaveClass(/home-impact-reports-nearby/);
        await expect(card).toHaveClass(/home-impact-pulse/);
    });

    test('reports-nearby count tile renders a static 24 + i18n-bound label', async ({ page }) => {
        // The pulse block now shows a static "24" (backend wiring is
        // a separate commit per operator: "make it static now we
        // will dvelop it soon"). Label binds to home_reports_nearby.
        const count = page.locator('#home-reports-nearby-count');
        await expect(count).toBeVisible();
        const countText = (await count.textContent() || '').trim();
        expect(countText).toBe('24');

        const label = page.locator('#home-impact .hi-label');
        await expect(label).toBeVisible();
        const labelText = (await label.textContent() || '').toLowerCase();
        expect(labelText).toMatch(/verified|reports|nearby/);
    });

    test('pulse number renders at the v5 dominant scale (≥ 40px)', async ({ page }) => {
        // The bottom-portion refresh bumps the pulse font-size clamp
        // ceiling to 4.2rem (~67px) so it dominates the centre of the
        // bottom half. Compact phones clamp down to 2.8rem (~45px).
        // Any value ≥ 40 px is accepted across viewports.
        const fontPx = await page.locator('#home-reports-nearby-count').evaluate((el) =>
            parseFloat(getComputedStyle(el as HTMLElement).fontSize),
        );
        expect(fontPx).toBeGreaterThanOrEqual(40);
    });

    test('channels render with a status subtitle (Live now / Coming soon / etc.)', async ({ page }) => {
        // The screenshot shows a small status line on every tile.
        // Pin that home-screen.js's _renderChannels() now emits
        // .ct-status nodes per tile.
        const statuses = page.locator('#home-channels .ct-status');
        await expect(statuses.first()).toBeVisible();
        const count = await statuses.count();
        expect(count, 'every channel tile should carry a status subtitle').toBeGreaterThanOrEqual(6);
    });

    test('reduced-motion users get a static halo (no animation)', async ({ page, context }) => {
        // Emulate prefers-reduced-motion: reduce. The outer ring's
        // animation is disabled; the inner halo stays as a static
        // radial-gradient.
        await context.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        await page.waitForLoadState('networkidle');

        const animName = await page.locator('#home-impact .hi-cell-reports-nearby').evaluate((el) =>
            getComputedStyle(el as HTMLElement, '::after').animationName,
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
