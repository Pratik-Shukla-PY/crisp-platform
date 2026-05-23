/**
 * HC33 (May 23, 2026) — sync chip is a queue-presence indicator, not an
 * always-on connectivity dot.
 *
 * HC30 wired #home-sync-chip as an always-on chip (green dot when
 * online, etc). Operator review noted the green dot above the
 * Report-an-Incident CTA on iPhone SE / Galaxy small (where the
 * label collapses) read as noise — the brand-mark connectivity dot
 * (#connectivity-dot pinned to the "P" of CRISP) already covers the
 * at-a-glance state. HC33 narrowed the chip to surface ONLY when the
 * IDB queue has unsent reports.
 *
 * Invariants pinned here:
 *  1. On a fresh boot with no queued reports the chip is `hidden` and
 *     occupies no layout slot.
 *  2. No `data-state` attribute is present on the chip while it's hidden.
 *
 * The "shows when queue > 0" path is harder to mock end-to-end
 * (requires injecting an IDB row via window.getAllQueued + a
 * synthetic crisp:queue-changed event) and is covered by the manual
 * smoke each time the painter is touched; this spec only guards the
 * empty-queue default state.
 */
import { test, expect } from '@playwright/test';

test.describe('PWA — HC33 sync chip is queue-presence only', () => {
    test('@smoke chip is hidden on first paint with no queued reports', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');
        // Give the home-screen painter + queue read a moment to settle.
        await page.waitForTimeout(500);

        const chip = page.locator('#home-sync-chip');
        // The element exists in the DOM (CLS-stable) but is hidden via
        // the `hidden` attribute when there's nothing to communicate.
        const isHidden = await chip.evaluate((el) => el.hasAttribute('hidden'));
        expect(isHidden, 'sync chip must be hidden when no reports are queued').toBe(true);
        const dataState = await chip.getAttribute('data-state');
        expect(dataState, 'no data-state should be set while chip is hidden').toBeNull();
    });
});
