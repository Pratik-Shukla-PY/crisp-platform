/**
 * HC57 (May 2026) — Privacy & Consent onboarding modal.
 *
 * Operator: "Replace the current small consent checkbox/banner
 * experience with a proper Privacy & Consent onboarding modal before
 * the user starts using the app." Non-dismissible: must tap Accept &
 * Continue to proceed.
 *
 * Pre-HC57 the home stage carried a small `<label>` + `<input
 * type="checkbox">` row (`#home-consent` / `#home-consent-check`)
 * that gated btn-start until ticked. Easy to miss, low-visibility,
 * confusing — operator's UX feedback.
 *
 * HC57 fix: full first-visit modal at `#consent-onboarding`. Layout:
 *   · Sticky header (title + subtitle + brand shield icon)
 *   · Scrollable body (4 step cards + fine-print)
 *   · Sticky footer (Accept & Continue + Read full Privacy Policy)
 * Persistence: same `localStorage['crisp_privacy_consent']` key as
 * the legacy checkbox (backward-compatible — existing users on the
 * deployed build do NOT re-prompt across the upgrade).
 *
 * This spec pins:
 *   1. First-time visitor (no localStorage) → modal visible at frame 0
 *   2. Background scroll locked while modal is open
 *   3. Modal contains the 4 step cards in the documented order
 *   4. Tap "Accept & Continue" → modal hides, localStorage persists,
 *      `html.crisp-consented` class applied
 *   5. Returning visitor (localStorage seeded) → modal NEVER paints
 *   6. Esc key does NOT dismiss (non-dismissible)
 *   7. Tap outside the card does NOT dismiss
 *   8. The legacy `#home-consent` markup is gone (regression guard)
 */
import { test, expect } from '@playwright/test';

const EXPECTED_CARD_KEYS = [
    'consent_card_location_title',
    'consent_card_camera_title',
    'consent_card_offline_title',
    'consent_card_privacy_title',
];

async function gotoFirstVisit(page) {
    // No consent in localStorage — modal must paint.
    await page.addInitScript(() => {
        try {
            localStorage.removeItem('crisp_privacy_consent');
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang_manual', 'en');
        } catch (_) {}
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
}

async function gotoReturning(page) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem(
                'crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }),
            );
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang_manual', 'en');
        } catch (_) {}
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
}

test.describe('PWA — HC57 consent onboarding modal', () => {
    test('@smoke first-time visitor: modal is visible at frame 0', async ({ page }) => {
        await gotoFirstVisit(page);
        const modal = page.locator('#consent-onboarding');
        await expect(modal, 'modal must paint for first-time visitor').toBeVisible();
        // html does NOT carry the consented class (head IIFE didn't add it).
        const hasConsentedClass = await page.evaluate(
            () => document.documentElement.classList.contains('crisp-consented'),
        );
        expect(hasConsentedClass, 'html must NOT have crisp-consented class').toBe(false);
    });

    test('@smoke first-time visitor: background scroll is locked', async ({ page }) => {
        await gotoFirstVisit(page);
        const bodyOverflow = await page.evaluate(
            () => getComputedStyle(document.body).overflow,
        );
        expect(bodyOverflow, 'body overflow must be hidden').toBe('hidden');
    });

    test('@smoke modal contains the 4 step cards in priority order', async ({ page }) => {
        await gotoFirstVisit(page);
        const cardTitleKeys = await page.locator(
            '#consent-onboarding .consent-card-title',
        ).evaluateAll((els) =>
            els.map((el) => (el as HTMLElement).dataset.i18n),
        );
        expect(cardTitleKeys).toEqual(EXPECTED_CARD_KEYS);
    });

    test('@smoke Accept & Continue persists localStorage + hides modal + adds crisp-consented class', async ({ page }) => {
        await gotoFirstVisit(page);
        await page.locator('#consent-onboarding-accept-btn').click();

        // Modal hidden via display:none on the overlay.
        await expect(page.locator('#consent-onboarding')).toBeHidden();

        const hasConsentedClass = await page.evaluate(
            () => document.documentElement.classList.contains('crisp-consented'),
        );
        expect(hasConsentedClass).toBe(true);

        const stored = await page.evaluate(
            () => localStorage.getItem('crisp_privacy_consent'),
        );
        expect(stored, 'consent persisted in localStorage').not.toBeNull();
        const parsed = JSON.parse(stored as string);
        expect(parsed.accepted).toBe(true);
        expect(typeof parsed.ts).toBe('number');
    });

    test('@smoke returning visitor: modal NEVER paints (display: none from frame 0)', async ({ page }) => {
        await gotoReturning(page);
        // The head IIFE adds the class; the CSS rule keys off it.
        const hasConsentedClass = await page.evaluate(
            () => document.documentElement.classList.contains('crisp-consented'),
        );
        expect(hasConsentedClass, 'returning user must have crisp-consented class').toBe(true);

        // The overlay element exists in markup but is display:none.
        const overlayDisplay = await page.locator('#consent-onboarding').evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(overlayDisplay).toBe('none');

        // Background scroll is NOT locked.
        const bodyOverflow = await page.evaluate(
            () => getComputedStyle(document.body).overflow,
        );
        expect(bodyOverflow).not.toBe('hidden');
    });

    test('@smoke Esc key does NOT dismiss the modal', async ({ page }) => {
        await gotoFirstVisit(page);
        await page.locator('#consent-onboarding').focus();
        await page.keyboard.press('Escape');
        await expect(
            page.locator('#consent-onboarding'),
            'modal must remain visible after Esc',
        ).toBeVisible();
        const stored = await page.evaluate(
            () => localStorage.getItem('crisp_privacy_consent'),
        );
        expect(stored, 'no consent should be persisted from Esc').toBeNull();
    });

    test('@smoke tap on the dim backdrop does NOT dismiss', async ({ page }) => {
        await gotoFirstVisit(page);
        // Tap at the top-left corner of the overlay (outside the card,
        // which is centered with a 16px gutter). Use page.mouse so we
        // bypass the card's tap target.
        const overlay = page.locator('#consent-onboarding');
        const box = await overlay.boundingBox();
        if (!box) throw new Error('overlay has no bounding box');
        await page.mouse.click(box.x + 4, box.y + 4);
        await expect(overlay, 'modal must survive backdrop tap').toBeVisible();
    });

    test('@smoke legacy #home-consent markup is fully gone (regression guard)', async ({ page }) => {
        await gotoReturning(page);
        // The old checkbox / label combo must NOT exist anywhere on the page.
        await expect(page.locator('#home-consent')).toHaveCount(0);
        await expect(page.locator('#home-consent-check')).toHaveCount(0);
    });
});
