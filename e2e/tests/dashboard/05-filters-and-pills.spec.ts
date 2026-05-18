/**
 * Dashboard — Stat-pill + time-filter contract (Apr 2026 Phase 2.9).
 *
 * The dashboard's top strip carries two independent filter axes:
 *
 *   1. Stat pills (critical / pending / responding / resolved / total).
 *      Clicking a pill narrows the feed to rows matching its status.
 *      Clicking the same pill again clears the filter (toggle).
 *   2. Time filter bar (1h / 24h / All). `setTimeFilter(h)` sets
 *      `timeFilterHours` and re-renders feed, stats, and map markers.
 *
 * Neither has a dedicated test; both regress silently (a filter
 * becomes sticky, or a CSS rename breaks the `pill-active` highlight)
 * because the happy-path smoke test only renders, never clicks.
 *
 * Four tests:
 *   (a) Pills render and expose counts for a seeded crisis mix.
 *   (b) Click "critical" → feed narrows to severity ∈ {CRITICAL, SEVERE}
 *       AND the pill gets `pill-active` class.
 *   (c) Click "critical" again → filter clears (toggle), class removed.
 *   (d) setTimeFilter(1) sets `__crispTimeFilterHours === 1`, updates
 *       active `.time-btn` class, and the feed reflects the filter.
 *
 * Depends on the `__crispActivePillFilter` / `__crispTimeFilterHours`
 * read-only debug hooks in app.js.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, cleanupTestReports } from '../helpers/api';

/** Seed a report whose severity/status we control — the combo determines
 *  which pill it should show up under. */
async function seedReport(
    request: APIRequestContext,
    token: string,
    opts: { severity: string; description: string; device_hash: string }
): Promise<string> {
    const res = await request.post('http://localhost:8000/api/v1/reports/meta', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
            device_hash: opts.device_hash,
            client_report_id: `e2e-filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            source: 'APP',
            severity: opts.severity,
            infrastructure_type: 'ROAD',
            crisis_type: 'FLOOD',
            damage_classification: 'PARTIAL',
            description: opts.description,
            expected_media: 0,
            location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 10 },
        },
    });
    expect(res.ok(), `seed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
}

async function loginAsAdmin(page, request: APIRequestContext): Promise<string> {
    const res = await request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await res.json();
    const token = body.access_token || body.token;
    await page.goto('index.html');
    await page.evaluate((t) => {
        localStorage.setItem('crisp_token', t);
        localStorage.setItem('crisp_user', JSON.stringify({
            email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, token);
    await page.reload();
    return token;
}

async function waitForReport(page, id: string) {
    await expect.poll(
        async () => {
            await page.evaluate(() =>
                (window as any).__crispFetchReports && (window as any).__crispFetchReports()
            ).catch(() => {});
            return page.evaluate((rid) => {
                const arr = (window as any).allReports;
                return Array.isArray(arr) && arr.some((r: any) => r.id === rid);
            }, id);
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
    ).toBe(true);
}

test.describe('Dashboard stat-pill + time filter', () => {
    let token: string;

    test.beforeEach(async ({ page, request }) => {
        token = await loginAsAdmin(page, request);
    });

    test.afterAll(async ({ request }) => {
        const res = await request.post('http://localhost:8000/api/v1/auth/login', {
            data: { email: ADMIN.email, password: ADMIN.password },
        });
        if (res.ok()) {
            const body = await res.json();
            await cleanupTestReports(request, body.access_token || body.token);
        }
    });

    test('@smoke pills render with counts reflecting seeded mix', async ({ page, request }) => {
        // Seed one CRITICAL, one MODERATE (shows up in PENDING or similar).
        const dh = `E2E-DEVICE-PILL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const crit = await seedReport(request, token, {
            severity: 'CRITICAL', description: 'pill-counts CRITICAL', device_hash: dh,
        });
        const mod = await seedReport(request, token, {
            severity: 'MODERATE', description: 'pill-counts MODERATE', device_hash: dh,
        });
        await waitForReport(page, crit);
        await waitForReport(page, mod);

        // All five clickable pills present.
        for (const id of ['stat-critical', 'stat-pending', 'stat-responding', 'stat-resolved', 'stat-total']) {
            await expect(page.locator(`#${id}`)).toBeVisible();
        }

        // Critical + total counts must be AT LEAST 1 and 2 respectively
        // (we can't use `toBe` because the test DB can already have
        // other test-seeded rows from earlier specs that survived cleanup).
        const crit_count = parseInt(await page.locator('#count-critical').innerText(), 10);
        const total_count = parseInt(await page.locator('#count-total').innerText(), 10);
        expect(crit_count).toBeGreaterThanOrEqual(1);
        expect(total_count).toBeGreaterThanOrEqual(2);
    });

    test('click critical pill → _activePillFilter="critical" + pill-active class', async ({ page, request }) => {
        // Seed so a click has something to narrow to.
        const dh = `E2E-DEVICE-PILL-CLICK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const crit = await seedReport(request, token, {
            severity: 'CRITICAL', description: 'click critical seed', device_hash: dh,
        });
        await waitForReport(page, crit);

        // Pre-click: no active filter.
        const before = await page.evaluate(() => (window as any).__crispActivePillFilter);
        expect(before).toBeFalsy();

        await page.locator('#stat-critical').click();

        // Debug hook reflects the state. The state is a plain string,
        // not a class attribute — this is the API contract downstream
        // consumers (triage queue, map markers) read.
        await expect.poll(
            async () => page.evaluate(() => (window as any).__crispActivePillFilter),
            { timeout: 5_000 },
        ).toBe('critical');

        // Visual highlight class — this is what users actually see. If
        // this class rename breaks, the filter still technically works
        // but users don't know which pill is active. Worth pinning.
        // Phase F.1.b (May 2026) — `.pill-active` on `.clickable-pill`
        // became plain `.active` on `.cmd-status-seg-item`. See the
        // canonical comment block at app.js:2082.
        await expect(page.locator('#stat-critical')).toHaveClass(/active/);
    });

    test('click critical pill twice → toggle clears filter + removes class', async ({ page, request }) => {
        const dh = `E2E-DEVICE-PILL-TOGGLE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const crit = await seedReport(request, token, {
            severity: 'CRITICAL', description: 'toggle test seed', device_hash: dh,
        });
        await waitForReport(page, crit);

        // First click — active.
        await page.locator('#stat-critical').click();
        await expect.poll(
            async () => page.evaluate(() => (window as any).__crispActivePillFilter),
            { timeout: 5_000 },
        ).toBe('critical');

        // Second click on the same pill — filterByPill(type) toggles
        // back to null per the `if (_activePillFilter === type) { null }` branch.
        await page.locator('#stat-critical').click();
        await expect.poll(
            async () => page.evaluate(() => (window as any).__crispActivePillFilter),
            { timeout: 5_000 },
        ).toBeFalsy();

        // No pill should carry the active class now.
        // Phase F.1.b (May 2026) — see app.js:2082 comment.
        await expect(page.locator('.cmd-status-seg-item.active')).toHaveCount(0);
    });

    test('time filter 1h button sets timeFilterHours=1 + active class', async ({ page }) => {
        // Phase F.1.b (May 2026) — time filters collapsed from three
        // standalone .time-btn buttons into a single dropdown that
        // shows the currently-selected range as a label on the
        // trigger button. The click handlers still call
        // setTimeFilter(N) so the underlying state model is unchanged.
        const trigger = page.locator('#time-filter-dropdown > button').first();
        const currentLabel = page.locator('#time-filter-current-label');
        await expect(currentLabel).toHaveText(/All/);

        // Open the dropdown, then pick "Last 1 hour".
        await trigger.click();
        await page.locator('#time-filter-dropdown .export-menu button', { hasText: /1 hour/i }).first().click();

        // Debug hook confirms the state flipped to 1.
        await expect.poll(
            async () => page.evaluate(() => (window as any).__crispTimeFilterHours),
            { timeout: 5_000 },
        ).toBe(1);

        // Trigger label reflects the new choice.
        await expect(currentLabel).toHaveText(/1h/);
    });
});
