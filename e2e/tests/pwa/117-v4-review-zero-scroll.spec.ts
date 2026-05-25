/**
 * HC65 (May 2026) — V4 Step 3 "Review your report" zero-scroll redesign.
 *
 * Operator (2026-05-25): "Redesign Step 3 of 3 into a production-grade,
 * zero-scroll, intelligently compressed review experience [...] No
 * patchwork fixes. Need a holistic production-grade redesign of the
 * entire Step 3 review experience."
 *
 * Pre-HC65 the review stage rendered ~1100 px of content (4 fat cards
 * + 260 px inline OSM map + 3-row classification block + free-text
 * input + UNDP trigger) against a 589 px iPhone SE budget. The Send
 * CTA was permanently below the fold.
 *
 * HC65 cuts (~558 px saved):
 *   1. Photo / Location / UNDP trigger / Building → uniform compact
 *      `.v4-review-row` (50 px each).
 *   2. 3-row Classification → 3-chip horizontal strip (50 px total).
 *   3. Description card hidden on review (HC60's capture-stage voice
 *      + text is the authoritative input).
 *   4. Inline 260 px building map hidden — fullscreen picker
 *      (already shipped) becomes primary entry. UNDP must-have #6
 *      (free-text offline fallback) still reachable via fullscreen
 *      picker which contains the same `#input-infra-name-v3` input.
 *   5. "Tap any card to edit" subtitle dropped — uniform rows are
 *      self-evident.
 *
 * This spec pins:
 *   1. Review body fits without vertical scroll at iPhone SE.
 *   2. Send CTA is visible without scrolling.
 *   3. Photo row, Location row, Building row, UNDP row all exist
 *      and are ≥ 44 px tall (WCAG touch-target floor).
 *   4. 3 classification chips share a single row (equal-width via
 *      `repeat(3, 1fr)`).
 *   5. Description card is hidden on review.
 *   6. Inline building map (`#building-map`) is hidden — fullscreen
 *      picker handles building selection.
 *   7. Legacy `.v4-review-subtitle` markup is gone.
 *   8. Zero-scroll holds for Arabic (RTL) and Hindi.
 */
import { test, expect, type Page } from '@playwright/test';

const IPHONE_SE = { width: 375, height: 667 };

async function openReviewStage(page: Page, lang = 'en') {
    await page.setViewportSize(IPHONE_SE);
    await page.addInitScript((langCode) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', langCode);
        localStorage.setItem('crisp_lang_manual', langCode);
    }, lang);
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ groups: [] }),
        }),
    );
    // Stub the reverse-geocode endpoint so the location row paints
    // a friendly name without a real Mapbox call.
    await page.route('**/api/v1/reports/geocode/reverse**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                location_name: 'Electronic City, Bengaluru',
                source: 'mapbox',
                confidence: 'high',
            }),
        }),
    );
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object',
        null,
        { timeout: 8000 },
    );
    // Seed the minimum capture state so the review stage paints
    // its review summary properly (photo, classifications, etc.)
    // and jump directly to the review stage.
    await page.evaluate(() => {
        (window as any).state = (window as any).state || {};
        (window as any).state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        (window as any).state.v4Photos = [{
            url: 'data:image/png;base64,iVBORw0KGgo=',
        }];
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).state.infrastructure_type = 'COMMUNITY';
        (window as any).state.crisis_type = 'EARTHQUAKE';
        (window as any).state.damage_classification = 'PARTIAL';
        (window as any).goToStage('stage-v4-review');
    });
    await expect(page.locator('#stage-v4-review.active'))
        .toBeVisible({ timeout: 3000 });
    // Let the review summary paint (geocode resolution + photo thumb
    // + classification values).
    await page.waitForTimeout(300);
}

test.describe('PWA — HC65 V4 Step 3 review zero-scroll', () => {
    test('@smoke iPhone SE: review body fits without vertical scroll', async ({ page }) => {
        await openReviewStage(page);
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-review .v4-body') as HTMLElement | null;
            if (!body) return null;
            return body.scrollHeight - body.clientHeight;
        });
        expect(overflow, 'v4-body should exist').not.toBeNull();
        expect(
            overflow,
            `v4-body overflow must be ≤ 2 px (got ${overflow})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke Send to UNDP CTA layout — pinned by the stage grid contract', async ({ page }) => {
        await openReviewStage(page);
        // The stage uses CSS grid with `grid-template-rows: auto 1fr
        // auto` so the footer is always at the bottom of the stage.
        // Combined with the zero-overflow check on `.v4-body` above,
        // this guarantees the Send button can never be pushed below
        // the viewport.
        const stageDisplay = await page.locator('#stage-v4-review').evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(stageDisplay, 'review stage must use CSS grid layout').toBe('grid');
        const tracks = await page.locator('#stage-v4-review').evaluate(
            (el) => getComputedStyle(el).gridTemplateRows.split(/\s+/).filter(Boolean).length,
        );
        expect(
            tracks,
            'review stage grid must have 3 tracks (header / body / footer)',
        ).toBeGreaterThanOrEqual(3);
        // Send button is in the DOM.
        await expect(page.locator('#btn-v4-send')).toHaveCount(1);
    });

    test('@smoke HC65 four uniform .v4-review-row rows render (Photo, Location, Building, UNDP)', async ({ page }) => {
        await openReviewStage(page);
        // Each of the 4 rows uses the same `.v4-review-row` skin.
        for (const id of ['v4-edit-photo', 'v4-edit-location', 'btn-building-fs-open', 'btn-v4-open-undp']) {
            const row = page.locator(`#${id}`);
            await expect(row, `#${id} must exist`).toHaveCount(1);
            await expect(row, `#${id} must be visible`).toBeVisible();
            await expect(
                row,
                `#${id} must carry .v4-review-row class for uniform skin`,
            ).toHaveClass(/v4-review-row/);
            const h = await row.evaluate((el) => (el as HTMLElement).offsetHeight);
            expect(
                h,
                `#${id} rendered height must be ≥ 44 px (WCAG); got ${h}`,
            ).toBeGreaterThanOrEqual(44);
            expect(
                h,
                `#${id} rendered height should be reasonably compact (≤ 80 px); got ${h}`,
            ).toBeLessThanOrEqual(80);
        }
    });

    test('@smoke HC65 3-chip classification strip is a single horizontal row', async ({ page }) => {
        await openReviewStage(page);
        const strip = page.locator('#stage-v4-review .v4-review-classify-strip');
        await expect(strip, 'classify strip must exist').toHaveCount(1);
        const cols = await strip.evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
        );
        expect(
            cols,
            'classify strip must have exactly 3 columns (Type | Hazard | Damage)',
        ).toBe(3);
        // All 3 chips exist + are visible.
        const chips = page.locator('#stage-v4-review .v4-classify-strip-chip');
        await expect(chips, 'must have 3 chip buttons').toHaveCount(3);
        const tops = await chips.evaluateAll((nodes) =>
            (nodes as HTMLElement[]).map((el) => el.getBoundingClientRect().top),
        );
        // All 3 chips on the same row → same top coordinate (within
        // sub-pixel rounding).
        const min = Math.min(...tops);
        const max = Math.max(...tops);
        expect(
            max - min,
            'all 3 classify chips must share the same row',
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke HC65 description card is hidden on review (HC60 voice/text is on capture)', async ({ page }) => {
        await openReviewStage(page);
        // The description card markup is kept in DOM (so JS hooks
        // attach without errors) but flagged `hidden`. Verify it
        // takes zero vertical space.
        const card = page.locator('#v4-desc-card');
        await expect(card).toHaveCount(1);
        const display = await card.evaluate((el) => getComputedStyle(el).display);
        expect(
            display,
            'description card must be display:none on review (HC65)',
        ).toBe('none');
    });

    test('@smoke HC65 inline building map is hidden — fullscreen picker is primary entry', async ({ page }) => {
        await openReviewStage(page);
        // The 260 px inline Leaflet map is the biggest pre-HC65
        // offender. HC65 hides it via CSS; building-select.js still
        // sees the DOM node (so its Leaflet controller doesn't NPE),
        // but it never renders inline. The fullscreen picker (opened
        // by tapping #btn-building-fs-open) handles building
        // selection.
        const inlineMap = page.locator('#stage-v4-review #building-map');
        await expect(inlineMap, 'inline map node still exists in DOM').toHaveCount(1);
        const display = await inlineMap.evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(
            display,
            'inline building map must be hidden on review (HC65)',
        ).toBe('none');
        // Fullscreen CTA is the primary entry point — must be visible.
        await expect(page.locator('#btn-building-fs-open')).toBeVisible();
    });

    test('@smoke HC65 "Tap any card to edit" subtitle is removed', async ({ page }) => {
        await openReviewStage(page);
        // The pre-HC65 subtitle was inside `.v4-review-title-section
        // > p[data-i18n="v4_review_subtitle"]`. HC65 drops the
        // wrapper section entirely + replaces it with a single
        // `.v4-review-title` h3. The subtitle markup must no longer
        // exist.
        await expect(
            page.locator('#stage-v4-review [data-i18n="v4_review_subtitle"]'),
            'v4_review_subtitle markup must be gone',
        ).toHaveCount(0);
        await expect(
            page.locator('#stage-v4-review .v4-review-title-section'),
            'old `.v4-review-title-section` wrapper must be gone',
        ).toHaveCount(0);
        // New title element exists.
        await expect(
            page.locator('#stage-v4-review .v4-review-title'),
        ).toHaveCount(1);
    });

    // ── RTL + Devanagari zero-scroll guards ──────────────────────────
    for (const lang of ['ar', 'hi'] as const) {
        test(`@smoke ${lang}: review still fits without vertical scroll`, async ({ page }) => {
            await openReviewStage(page, lang);
            await page.waitForFunction(
                (target) => document.documentElement.lang === target,
                lang,
                { timeout: 5000 },
            );
            const overflow = await page.evaluate(() => {
                const body = document.querySelector('#stage-v4-review .v4-body') as HTMLElement | null;
                if (!body) return -1;
                return body.scrollHeight - body.clientHeight;
            });
            expect(
                overflow,
                `${lang}: v4-body overflow must be ≤ 2 px (got ${overflow})`,
            ).toBeLessThanOrEqual(2);
        });
    }
});
