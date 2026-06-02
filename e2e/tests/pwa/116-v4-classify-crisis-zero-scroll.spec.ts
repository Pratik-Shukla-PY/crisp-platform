/**
 * HC63 (May 2026) — V4 Classify Stage 2 / Sub-view 3 ("What caused
 * it?" — crisis type) zero-scroll redesign.
 *
 * Operator (2026-05-25): "Apply the same single-screen zero-scroll
 * premium UX redesign principles to this Disaster Type selection
 * stage. Cards too tall, lots of unused vertical space, section
 * headings consume excessive height, grid alignment feels inconsistent,
 * icons oversized, lower tiles get clipped below fold."
 *
 * Pre-HC63: 9 tiles (Natural 5 + Tech 2 + Human 2) at 96 px min-height
 * each + 11 px section headers with 16 px inter-group gaps + 8 px
 * group-internal gaps = ~778 px total against a 589 px iPhone SE
 * usable budget (overflow ~189 px). The orphan Wildfire tile (5th in
 * Natural with a 2-col grid) also sat alone in the left column with
 * an empty right cell.
 *
 * HC63 cuts:
 *   1. Tile column-flex → side-icon grid (icon LEFT, label RIGHT,
 *      2-line clamp). Tile `min-height: 96 → 48`; icon `48 × 48 →
 *      32 × 32`; padding `14 → 6 / 12`.
 *   2. Section header `font 11 → 10`, color muted, tighter
 *      letter-spacing. Group gap `8 → 4`. Inter-group gap `16 → 6`.
 *   3. Orphan tile fix: `:last-child:nth-child(odd)` spans full
 *      width so Wildfire (5th in Natural) fills its row.
 *   4. Long labels ("Hurricane / Cyclone", "Civil unrest") clamp
 *      to 2 lines.
 *   5. Responsive cascade — only scale icon + typography.
 *
 * This spec pins:
 *   1. The crisis sub-view fits without vertical scroll at iPhone
 *      SE (375 × 667).
 *   2. All 9 crisis tiles are present + have non-zero rendered size.
 *   3. The 3 section headers exist (Natural / Technological /
 *      Human-made) — grouping preserved.
 *   4. Orphan-tile fix — Wildfire (last in Natural) spans both
 *      columns (its width matches the parent grid's width).
 *   5. Tile rendered offsetHeight ≥ 44 px (WCAG touch target).
 *   6. Zero-scroll holds for Arabic (RTL) and Hindi.
 */
import { test, expect, type Page } from './_fixtures';

const IPHONE_SE = { width: 375, height: 667 };

async function openCrisisView(page: Page, lang = 'en') {
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
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object',
        null,
        { timeout: 8000 },
    );
    await page.evaluate(() => {
        (window as any).state = (window as any).state || {};
        (window as any).state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        (window as any).state.v4Photos = [(window as any).state.photoDataUrl];
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).goToStage('stage-v4-classify');
    });
    await expect(page.locator('#stage-v4-classify.active'))
        .toBeVisible({ timeout: 3000 });
    // damage → infra (tap any damage option)
    await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 2000 });
    // infra → crisis (tap any infra tile that does NOT trigger the
    // OTHER text-input gate)
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]').click();
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 2000 });
    // The crisis grid is JS-rendered; wait for tiles to land.
    await page.waitForSelector('#v4-cause-grid .v4-cause-tile', { timeout: 3000 });
}

test.describe('PWA — HC63 V4 Classify "What caused it?" zero-scroll', () => {
    test('@smoke iPhone SE: crisis sub-view fits without vertical scroll', async ({ page }) => {
        await openCrisisView(page);
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-classify .v4-body') as HTMLElement | null;
            if (!body) return null;
            return body.scrollHeight - body.clientHeight;
        });
        expect(overflow, 'v4-body should exist').not.toBeNull();
        expect(
            overflow,
            `v4-body overflow must be ≤ 2 px (got ${overflow})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke all 9 crisis tiles are present AND have non-zero size', async ({ page }) => {
        await openCrisisView(page);
        const tiles = page.locator('#v4-cause-grid .v4-cause-tile');
        await expect(tiles, 'all 9 crisis tiles must be present').toHaveCount(9);
        const dims = await tiles.evaluateAll((nodes) =>
            (nodes as HTMLElement[]).map((el) => ({
                w: el.offsetWidth, h: el.offsetHeight,
                value: el.getAttribute('data-value'),
            })),
        );
        for (const d of dims) {
            expect(d.w, `tile ${d.value} width must be > 0`).toBeGreaterThan(0);
            expect(d.h, `tile ${d.value} height must be > 0`).toBeGreaterThan(0);
        }
    });

    test('@smoke 3 section groups preserved (Natural / Technological / Human-made)', async ({ page }) => {
        await openCrisisView(page);
        const groups = page.locator('#v4-cause-grid .v4-cause-group');
        await expect(
            groups,
            'must have exactly 3 cause-groups',
        ).toHaveCount(3);
        // Each group has a header element.
        const headers = await page.locator('#v4-cause-grid .v4-cause-group-header').count();
        expect(headers, 'must have 3 section headers').toBe(3);
    });

    test('@smoke HC64 every cause tile is full-width (single-column flex-fill)', async ({ page }) => {
        await openCrisisView(page);
        // HC64 — every tile lives in its own row (single-column flex
        // column inside its group). All 9 tiles' widths should match
        // the grid container's content width (within a few px of
        // sub-pixel rounding).
        const gridWidth = await page.locator('#v4-cause-grid').evaluate(
            (el) => (el as HTMLElement).clientWidth,
        );
        const widths = await page.locator('#v4-cause-grid .v4-cause-tile').evaluateAll(
            (nodes) => (nodes as HTMLElement[]).map((el) => el.offsetWidth),
        );
        expect(widths.length, 'must have all 9 tiles').toBe(9);
        for (let i = 0; i < widths.length; i++) {
            expect(
                Math.abs(widths[i] - gridWidth),
                `tile #${i} width (${widths[i]}) must match grid container width (${gridWidth})`,
            ).toBeLessThanOrEqual(2);
        }
    });

    test('@smoke HC64 tiles in same group share equal height (flex: 1 1 0)', async ({ page }) => {
        await openCrisisView(page);
        // Each group's tiles use `flex: 1 1 0` so they split their
        // group's allotted height equally. Pin the contract by
        // checking heights within each group are within 2 px.
        for (const groupClass of ['v4-cause-group-natural', 'v4-cause-group-tech', 'v4-cause-group-human']) {
            const heights = await page.locator(
                `#v4-cause-grid .${groupClass} .v4-cause-tile`,
            ).evaluateAll(
                (nodes) => (nodes as HTMLElement[]).map((el) => el.offsetHeight),
            );
            expect(heights.length, `${groupClass} must have tiles`).toBeGreaterThan(0);
            const min = Math.min(...heights);
            const max = Math.max(...heights);
            expect(
                max - min,
                `${groupClass}: tiles must share equal height (got spread ${max - min} px across ${heights.length} tiles)`,
            ).toBeLessThanOrEqual(2);
        }
    });

    test('@smoke HC64 substep label hidden on crisis view', async ({ page }) => {
        await openCrisisView(page);
        // HC64 — substep label "WHAT CAUSED IT · 3 OF 3" is hidden
        // via inline style on the crisis view to free the ~26 px the
        // label was costing. Damage + infra views keep it.
        const display = await page.locator('#v4-substep-label').evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(
            display,
            'v4-substep-label must be hidden on crisis view',
        ).toBe('none');
    });

    test('@smoke tile rendered height meets WCAG 44 px touch-target floor', async ({ page }) => {
        await openCrisisView(page);
        const heights = await page.locator('#v4-cause-grid .v4-cause-tile').evaluateAll(
            (nodes) => (nodes as HTMLElement[]).map((el) => el.offsetHeight),
        );
        for (let i = 0; i < heights.length; i++) {
            expect(
                heights[i],
                `tile #${i} rendered height must be ≥ 44 px (WCAG); got ${heights[i]}`,
            ).toBeGreaterThanOrEqual(44);
        }
    });

    // ── RTL + Devanagari zero-scroll guards ──────────────────────────
    for (const lang of ['ar', 'hi'] as const) {
        test(`@smoke ${lang}: crisis sub-view still fits without vertical scroll`, async ({ page }) => {
            await openCrisisView(page, lang);
            await page.waitForFunction(
                (target) => document.documentElement.lang === target,
                lang,
                { timeout: 5000 },
            );
            const overflow = await page.evaluate(() => {
                const body = document.querySelector('#stage-v4-classify .v4-body') as HTMLElement | null;
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
