/**
 * PWA — My Reports UX redesign (May 2026).
 *
 * Operator asks from the stage-history screenshot:
 *   1. "Filter option give in a drop down menu with All as default"
 *   2. "If there are no reports in 'in flight' don't show the space."
 *   3. "Submitted reports show 5 in one screen without scroll and give
 *       lazy loading for further."
 *   4. "By default give it in date wise collapsed accordions, only
 *       latest report show at the top."
 *
 * Implementation:
 *   1. `#mr-filter-select` <select> dropdown replaces the chip row.
 *      Default value 'all'. `change` event re-renders.
 *   2. `_renderPartialReports` sets `#history-inflight-section`
 *      display:'none' when 0 in-flight items, '' otherwise.
 *   3+4. `_renderSubmittedReports` wraps each non-empty date bucket in
 *      a `<details class="mr-date-group">` accordion. Only the latest
 *      non-empty bucket is `open` by default. Per-bucket pagination:
 *      first 5 cards visible, "Load 5 more · N more" button appends
 *      next 5. Older buckets render summary-only; cards lazy-render
 *      on first user-expand via the `toggle` event handler.
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        // Seed a device-hash so `_renderSubmittedReports` doesn't
        // early-return on `!deviceHash` (which hides #mr-controls).
        // The hash is what status-since uses as the cache key; the
        // monkey-patched window.fetch below ignores the URL anyway.
        localStorage.setItem('crisp_device_id_v2', 'test-device-hash-mr-spec');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
}

/** Build N synthetic submitted-report objects bucketed across date
 *  groups so the test can exercise the "Today" / "Yesterday" / etc.
 *  rendering deterministically. */
function makeReports(counts: { today: number; yesterday: number; thisWeek: number; older: number }) {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const out: any[] = [];
    let i = 0;
    const push = (whenOffset: number, label: string) => {
        i++;
        out.push({
            id: `r-${label}-${i}`,
            client_report_id: `r-${label}-${i}`,
            crisis_type: 'FLOOD',
            infrastructure_type: 'ROAD',
            status: 'PENDING',
            reviewer_verdict: 'NOT_REVIEWED',
            server_created_at: new Date(now - whenOffset).toISOString(),
            location: { latitude: 12.97, longitude: 77.59, user_location_name: 'Bangalore' },
            lives_impacted: 0,
            thumbnail_url: null,
        });
    };
    for (let k = 0; k < counts.today; k++)     push(60_000 * (k + 1), 'today');
    for (let k = 0; k < counts.yesterday; k++) push(oneDay + 60_000 * (k + 1), 'yest');
    for (let k = 0; k < counts.thisWeek; k++)  push(oneDay * 3 + 60_000 * (k + 1), 'week');
    for (let k = 0; k < counts.older; k++)     push(oneDay * 30 + 60_000 * (k + 1), 'old');
    return out;
}

async function seedAndOpenMyReports(page: Page, reports: any[]) {
    // Inject the synthetic reports into the in-memory cache and force
    // a re-render via openMyReports(). Patches window.fetch so the
    // status-since fetch returns our reports regardless of URL match.
    await page.evaluate((reports) => {
        (window as any)._submittedCache = reports;
        // Clear the _singleFlightFetch cache — otherwise a cached
        // response from a previous test would be served instead of
        // our patched fetch.
        try {
            if (typeof (window as any).__crispClearFetchCache === 'function') {
                (window as any).__crispClearFetchCache();
            }
        } catch (_) {}
        // Stub the status-since fetcher so `_renderSubmittedReports`
        // doesn't try to hit the backend.
        const origFetch = window.fetch.bind(window);
        window.fetch = ((url: any, ...rest: any[]) => {
            const u = String(url || '');
            if (u.includes('/reports/device/') && u.includes('/status-since')) {
                return Promise.resolve(new Response(JSON.stringify(reports), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            return origFetch(url, ...rest);
        }) as any;
    }, reports);
    await page.evaluate(() => (window as any).openMyReports());
    // Settle async renders (status-since fetch + reconcile + paint).
    await page.waitForTimeout(400);
}

test.describe('PWA — My Reports dropdown + accordion + lazy-load', () => {

    test.beforeEach(async ({ page }) => { await bootV4(page); });

    // ── Fix 1 — filter dropdown ────────────────────────────────────────

    test('@smoke filter chips replaced with native <select>; default value is "all"', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 2, yesterday: 0, thisWeek: 0, older: 0 }));
        // The chip-row markup must be gone.
        await expect(page.locator('.mr-filter-chip')).toHaveCount(0);
        // The dropdown must be present with value "all".
        const sel = page.locator('#mr-filter-select');
        await expect(sel).toBeVisible();
        const value = await sel.inputValue();
        expect(value).toBe('all');
    });

    test('changing the dropdown re-filters and resets pagination', async ({ page }) => {
        // Mix of statuses so the filter has something to do.
        const reports = makeReports({ today: 2, yesterday: 0, thisWeek: 0, older: 0 });
        reports[0].reviewer_verdict = 'ACCEPTED';
        await seedAndOpenMyReports(page, reports);
        await page.locator('#mr-filter-select').selectOption('accepted');
        await page.waitForTimeout(150);
        // Only the ACCEPTED card should be visible.
        const cards = page.locator('.mr-card');
        await expect(cards).toHaveCount(1);
    });

    // ── Fix 2 — empty IN FLIGHT section is hidden ──────────────────────

    test('@smoke empty IN FLIGHT section is fully hidden (no header, no placeholder)', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 2, yesterday: 0, thisWeek: 0, older: 0 }));
        const sec = page.locator('#history-inflight-section');
        // The renderer sets style.display='none' on empty.
        const display = await sec.evaluate((el) => (el as HTMLElement).style.display);
        expect(display, 'IN FLIGHT section must be display:none when empty').toBe('none');
    });

    // ── Fix 3+4 — date accordions + lazy-load ──────────────────────────

    test('@smoke date-grouped <details> accordions render with only "Today" open', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 3, yesterday: 4, thisWeek: 6, older: 8 }));
        const groups = page.locator('details.mr-date-group');
        // 4 non-empty buckets → 4 accordions.
        await expect(groups).toHaveCount(4);
        // Today: open. Others: closed.
        await expect(page.locator('details.mr-date-group[data-mr-bucket="today"]'))
            .toHaveAttribute('open', /.*/);
        for (const bucket of ['yesterday', 'this_week', 'older']) {
            const det = page.locator(`details.mr-date-group[data-mr-bucket="${bucket}"]`);
            const isOpen = await det.evaluate((el) => (el as HTMLDetailsElement).open);
            expect(isOpen, `${bucket} must be closed by default`).toBe(false);
        }
    });

    test('"Today" with >5 reports shows first 5 cards + a "Load more" button', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 14, yesterday: 0, thisWeek: 0, older: 0 }));
        // Inside the today bucket, count rendered cards.
        const today = page.locator('details.mr-date-group[data-mr-bucket="today"]');
        await expect(today).toBeVisible();
        const cardCount = await today.locator('.mr-card').count();
        expect(cardCount, `expected 5 cards initially; got ${cardCount}`).toBe(5);
        // Load-more button must be present and show the remaining count.
        const loadMore = today.locator('.mr-load-more');
        await expect(loadMore).toBeVisible();
        const text = await loadMore.textContent();
        expect(text, `load-more should show 9 remaining; got "${text}"`).toMatch(/\b9\b/);
    });

    test('"Load more" appends the next 5 cards in the same group', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 14, yesterday: 0, thisWeek: 0, older: 0 }));
        const today = page.locator('details.mr-date-group[data-mr-bucket="today"]');
        await today.locator('.mr-load-more').click();
        await page.waitForTimeout(150);
        const cardCount = await today.locator('.mr-card').count();
        expect(cardCount, `after one load-more click expected 10; got ${cardCount}`).toBe(10);
    });

    test('older buckets lazy-render their cards on first expand', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 1, yesterday: 8, thisWeek: 0, older: 0 }));
        const yest = page.locator('details.mr-date-group[data-mr-bucket="yesterday"]');
        // Initially closed: no cards rendered inside.
        const before = await yest.locator('.mr-card').count();
        expect(before, `yesterday must have 0 cards before expand; got ${before}`).toBe(0);
        // Click summary to open.
        await yest.locator('summary').click();
        await page.waitForTimeout(200);
        const after = await yest.locator('.mr-card').count();
        expect(after, `yesterday must lazy-render 5 cards after expand; got ${after}`).toBe(5);
    });

    test('only the latest non-empty bucket opens by default when "today" is empty', async ({ page }) => {
        // No "today" reports → yesterday becomes the initial open.
        await seedAndOpenMyReports(page, makeReports({ today: 0, yesterday: 3, thisWeek: 5, older: 1 }));
        const yest = page.locator('details.mr-date-group[data-mr-bucket="yesterday"]');
        await expect(yest).toHaveAttribute('open', /.*/);
        // Today bucket shouldn't even render (0 items).
        await expect(page.locator('details.mr-date-group[data-mr-bucket="today"]')).toHaveCount(0);
        // this_week + older render but are closed.
        const week = page.locator('details.mr-date-group[data-mr-bucket="this_week"]');
        const weekOpen = await week.evaluate((el) => (el as HTMLDetailsElement).open);
        expect(weekOpen).toBe(false);
    });

    // ── May 2026 second-pass UX — single-stat Lives Saved card ─────────

    test('@smoke impact card shows only Lives Saved (no Resolved, no In-Flight)', async ({ page }) => {
        // Seed two reports so the impact card paints (it hides on
        // 0 reports / empty deviceHash).
        await seedAndOpenMyReports(page, makeReports({ today: 2, yesterday: 0, thisWeek: 0, older: 0 }));
        const card = page.locator('#history-impact-card');
        await expect(card).toBeVisible();
        // Single-stat modifier class is applied.
        await expect(card).toHaveClass(/history-impact-single/);
        // Exactly ONE cell inside (Lives Saved), wrapped in .hi-cell-lives.
        await expect(card.locator('.hi-cell-lives')).toHaveCount(1);
        // The two retired tiles must NOT be present.
        await expect(page.locator('#hi-resolved')).toHaveCount(0);
        await expect(page.locator('#hi-pending')).toHaveCount(0);
        // The Lives-Saved number element survives.
        await expect(page.locator('#hi-lives')).toBeVisible();
        // Heart icon decorates the cell.
        await expect(card.locator('.hi-heart')).toHaveCount(1);
        // Label is the home-screen i18n key.
        const labelKey = await card.locator('.hi-label').getAttribute('data-i18n');
        expect(labelKey).toBe('home_metric_lives');
    });

    test('filter dropdown carries the teal/navy theme overrides', async ({ page }) => {
        await seedAndOpenMyReports(page, makeReports({ today: 2, yesterday: 0, thisWeek: 0, older: 0 }));
        const sel = page.locator('#mr-filter-select');
        const styles = await sel.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return {
                borderColor: cs.borderColor,
                backgroundColor: cs.backgroundColor,
            };
        });
        // Border + background must reference the teal palette (not the
        // washed-out neutral/light-mode values the page used to inherit
        // from .v4-select). The exact rgba is what we set in styles.css;
        // compare on the channel breakdown so a future tweak to the
        // alpha doesn't break the test, but a regression back to the
        // grey neutral chrome would.
        // Border: rgba(9, 209, 199, *) — teal-leaning.
        expect(styles.borderColor).toMatch(/9, 209, 199/);
        // Background: rgba(12, 100, 120, *) — dark-teal surface.
        expect(styles.backgroundColor).toMatch(/12, 100, 120/);
    });
});
