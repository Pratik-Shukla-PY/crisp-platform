/**
 * HC56 (May 2026) — Privacy & Safety + Help sheets: sticky header.
 *
 * Operator (2026-05-24): "In Privacy & Safety Modal also, freeze the
 * header with the close button on the top right corner. Only the list
 * will be scrollable." Matches the HC54 lang-picker pattern.
 *
 * Pre-HC56 the .nearby-sheet-card had overflow-y:auto and the close
 * button + title were absolutely / inline-positioned inside it, so
 * they scrolled away with the bullet list. Operator could lose access
 * to the close button after scrolling.
 *
 * HC56 fix: wrap the close button + handle + title in a new
 * `.home-info-sheet-header` div, position:sticky inside the scrolling
 * card. The bullet list scrolls under the header; the header stays
 * pinned at the top.
 *
 * This spec pins, for BOTH sheets (Privacy & Safety + Help):
 *   1. `.home-info-sheet-header` exists inside the card.
 *   2. Computed position is `sticky` (not `static`).
 *   3. The card carries the `nearby-sheet-card--sticky-header` modifier.
 *   4. The close button is INSIDE the sticky header (so it scrolls
 *      with the header, not away with the body).
 *   5. The bullet list is the only flow sibling of the header.
 */
import { test, expect } from '@playwright/test';

const SHEETS = [
    {
        name: 'Privacy & Safety',
        trigger: '#btn-home-privacy',
        sheetId: '#home-privacy-sheet',
        closeId: '#home-privacy-sheet-close',
    },
    {
        name: 'Help',
        trigger: '#btn-home-help',
        sheetId: '#home-help-sheet',
        closeId: '#home-help-sheet-close',
    },
];

async function openHome(page) {
    await page.addInitScript(() => {
        localStorage.setItem(
            'crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }),
        );
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
}

test.describe('PWA — HC56 info-sheet sticky header', () => {
    for (const { name, trigger, sheetId, closeId } of SHEETS) {
        test(`@smoke ${name}: header has position:sticky and contains the X close button`, async ({ page }) => {
            await openHome(page);
            await page.locator(trigger).click();
            await expect(page.locator(sheetId)).toBeVisible();

            // Card carries the sticky-header modifier.
            const card = page.locator(`${sheetId} .nearby-sheet-card`);
            await expect(card).toHaveClass(/nearby-sheet-card--sticky-header/);

            // Header element exists.
            const header = page.locator(`${sheetId} .home-info-sheet-header`);
            await expect(header).toHaveCount(1);
            const position = await header.evaluate(
                (el) => getComputedStyle(el).position,
            );
            expect(position, `${name} header must be position:sticky`).toBe('sticky');

            // Close button is INSIDE the sticky header.
            const closeInsideHeader = page.locator(
                `${sheetId} .home-info-sheet-header ${closeId}`,
            );
            await expect(
                closeInsideHeader,
                `${name} close button must live inside the sticky header`,
            ).toHaveCount(1);
            await expect(closeInsideHeader).toBeVisible();
        });

        test(`@smoke ${name}: card scroll-container + sticky header anchor the close button`, async ({ page }) => {
            await openHome(page);
            await page.locator(trigger).click();
            await expect(page.locator(sheetId)).toBeVisible();

            // Header + bullet list are the only flex children of the card.
            // (Markup comments don't count as element children.)
            const childCount = await page.locator(`${sheetId} .nearby-sheet-card`)
                .evaluate((el) =>
                    Array.from(el.children).filter(
                        (c) => c.nodeType === 1 && c.tagName !== 'TEMPLATE',
                    ).length,
                );
            expect(
                childCount,
                `${name} card should have exactly 2 children: header + list`,
            ).toBe(2);

            await expect(
                page.locator(`${sheetId} .home-info-sheet-points`),
                `${name} body must be the .home-info-sheet-points list`,
            ).toHaveCount(1);

            // The pinning behaviour is fully described by two CSS facts:
            //   (a) the card is the scroll container — `overflow-y: auto`,
            //   (b) the header is `position: sticky` with `top: 0`.
            // Asserting both is animation-immune (the slide-in transform
            // doesn't change either property) AND content-immune (we
            // don't need to know whether the bullet list overflows the
            // current viewport on this device).
            const cardOverflow = await page
                .locator(`${sheetId} .nearby-sheet-card`)
                .evaluate((el) => getComputedStyle(el).overflowY);
            expect(cardOverflow, `${name} card must be scroll container`).toBe('auto');

            const headerCSS = await page
                .locator(`${sheetId} .home-info-sheet-header`)
                .evaluate((el) => {
                    const s = getComputedStyle(el);
                    return { position: s.position, top: s.top };
                });
            expect(headerCSS.position, `${name} header must be position:sticky`).toBe('sticky');
            expect(headerCSS.top, `${name} header top offset must be 0px`).toBe('0px');
        });

        // ── HC59 (May 2026) — padding/handle tightening ────────────────
        //
        // Operator screenshot 2026-05-25 (Hindi Privacy & Safety): the
        // sticky header had ~36 px of dead space above the title because
        // `.nearby-sheet-handle` (`margin: -10px auto 14px`, leftover
        // from the pre-HC56 non-sticky layout) sat above the title
        // inside the now-sticky header. The X close button at
        // `top: 14px` already provides explicit dismissal affordance —
        // the drag handle was redundant signalling.
        //
        // HC59:
        //   · `.nearby-sheet-handle` inside the sticky-header variant
        //     is `display: none`.
        //   · header `padding-top` ≤ 16 px (was 24 px — too loose,
        //     especially in Devanagari / Arabic scripts whose ascenders
        //     visually consume more vertical real estate).

        test(`@smoke ${name}: HC59 handle is hidden inside sticky header`, async ({ page }) => {
            await openHome(page);
            await page.locator(trigger).click();
            await expect(page.locator(sheetId)).toBeVisible();

            const handle = page.locator(
                `${sheetId} .home-info-sheet-header .nearby-sheet-handle`,
            );
            // Handle markup still exists (kept for non-sticky callers'
            // copy-paste parity), but it MUST be display:none in the
            // sticky variant.
            await expect(handle).toHaveCount(1);
            const display = await handle.evaluate(
                (el) => getComputedStyle(el).display,
            );
            expect(
                display,
                `${name} sticky-header handle must be display:none (HC59)`,
            ).toBe('none');
        });

        test(`@smoke ${name}: HC59 header top padding is tightened`, async ({ page }) => {
            await openHome(page);
            await page.locator(trigger).click();
            await expect(page.locator(sheetId)).toBeVisible();

            const paddingTopPx = await page
                .locator(`${sheetId} .home-info-sheet-header`)
                .evaluate((el) =>
                    parseFloat(getComputedStyle(el).paddingTop) || 0,
                );
            // Was 24 px pre-HC59. Tightened to ≤ 16 px so the title
            // baseline sits much closer to the modal top edge. The
            // X close button at `top: 14px` sets the visual top
            // register; the header padding-top now matches it.
            expect(
                paddingTopPx,
                `${name} header padding-top must be ≤ 16 px (HC59)`,
            ).toBeLessThanOrEqual(16);
            // Guard rail — must still leave breathing room above
            // the title (avoid 0 px / cramped layout if a future
            // refactor accidentally zeroes it).
            expect(
                paddingTopPx,
                `${name} header padding-top must be ≥ 10 px`,
            ).toBeGreaterThanOrEqual(10);
        });
    }
});
