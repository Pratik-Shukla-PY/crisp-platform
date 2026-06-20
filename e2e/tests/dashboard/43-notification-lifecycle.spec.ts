/**
 * Dashboard — Notification lifecycle redesign (Jun 2026).
 *
 * Product defect this guards: notification toasts re-appeared on every
 * navigation between Home / Operations / Incidents (and after refresh), even
 * hours after the event. Root cause: the notify path left NO durable
 * "displayed" marker, so an operation-scope full-refresh that evicts knownIds
 * made already-seen reports look new again and re-flash.
 *
 * The fix:
 *   - SHOW-ONCE: _addNotification now writes the report id into the persisted
 *     _seenIds ledger AT NOTIFY TIME, so the poll's producer gate suppresses
 *     every future re-delivery (scope switch / refresh / route change).
 *   - DURABLE CENTER: the bell is backed by a persisted _notifCenter holding
 *     read + unread history (survives refresh); the badge is the UNREAD count.
 *   - SESSION SUMMARY: one "since your last visit: +N" banner per browser
 *     session instead of replaying old alerts.
 *   - CATEGORIES: CRITICAL = Important (B); Urgent (C) is persistent-until-ack.
 *
 * The spec drives the REAL producer path via window.__crispApplyReportsForTest
 * (no 4s-poll wait): replace:true routes through _replaceReportData (the
 * knownIds-evicting scope-switch path), else _applyReportData (delta upsert).
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';
let _adminToken: string | null = null;

function mkReport(id: string, over: Record<string, any> = {}) {
    return {
        id, client_report_id: `c-${id}`, device_id: 'notif-dev', source: 'APP',
        status: 'PENDING', sync_status: 'SYNCED', severity: 'MINOR',
        infrastructure_type: 'ROAD', damage_classification: 'PARTIAL', crisis_type: 'FLOOD',
        description: `notif ${id}`, expected_media: 0, received_media: 0,
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: {
            latitude: 12.97, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59,
            user_location_name: 'Testville',
        },
        media: [], submitted_as_anonymous_due_to_expired_token: false,
        crisis_event_id: null, crisis_event_name: null,
        ...over,
    };
}

// Stub the data endpoints so boot is deterministic + offline. `rows` is what the
// initial poll returns (boot batch is silently "seen", never toasted).
async function stubReports(page: Page, rows: any[] = []) {
    await page.route(/\/api\/v1\/analytics\/summary/, (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify({ total_reports: rows.length, counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} }),
    }));
    await page.route(/\/api\/v1\/reports\/markers/, (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '[]',
    }));
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) { await route.continue(); return; }
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(rows.length),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"notif-${Date.now()}-${Math.round(Math.random() * 1e6)}"`,
            },
            body: JSON.stringify(rows),
        });
    });
}

async function boot(page: Page, request: any, opts: { rows?: any[]; initWatermark?: string } = {}) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    if (opts.initWatermark) {
        // Per-operator last-visit watermark. The test user blob carries no id /
        // username, so the namespaced key resolves to the 'anon' fallback.
        await page.addInitScript((iso) => {
            localStorage.setItem('crisp_last_visit_anon', iso as string);
        }, opts.initWatermark);
    }
    await stubReports(page, opts.rows || []);
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({ email, role: 'SUPER_ADMIN', full_name: 'E2E Admin' }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(
        () => typeof (window as any).__crispNotifDebug === 'function'
            && (window as any).__crispNotifDebug().initialLoadDone === true,
        null, { timeout: 15000 });
}

const dbg = (page: Page) => page.evaluate(() => (window as any).__crispNotifDebug());
const apply = (page: Page, rows: any[], replace = false) =>
    page.evaluate(({ rows, replace }) => (window as any).__crispApplyReportsForTest(rows, { replace }), { rows, replace });


test.describe('Notification lifecycle — show-once + no replay', () => {
    test('a new report notifies once AND writes the durable show-once marker', async ({ page, request }) => {
        await boot(page, request);                       // empty boot → seenIds 0
        expect((await dbg(page)).seenIds).toBe(0);

        await apply(page, [mkReport('r1')]);             // genuinely new → notify

        // Toast appeared once.
        await expect(page.locator('#notif-stack .notif-stack-card[data-id="r1"]')).toBeVisible({ timeout: 2000 });
        // Bell badge = 1 unread; durable center holds it.
        await expect(page.locator('#notif-count')).toHaveText('1');
        const d = await dbg(page);
        expect(d.unreadCount).toBe(1);
        expect(d.center.map((n: any) => n.id)).toContain('r1');
        // THE FIX: the notify path recorded r1 as displayed (was 0 before).
        expect(d.seenIds).toBe(1);
    });

    test('operation-scope switch (knownIds eviction) does NOT replay the toast', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('r1')]);
        expect((await dbg(page)).unreadCount).toBe(1);

        // Simulate an operation open → full-refresh that evicts r1 from knownIds…
        await apply(page, [], true);
        // …then the return navigation re-delivers r1.
        await apply(page, [mkReport('r1')]);

        // No second notification: the producer gate short-circuits on _seenIds.
        const d = await dbg(page);
        expect(d.center.filter((n: any) => n.id === 'r1').length).toBe(1);
        expect(d.unreadCount).toBe(1);
    });

    test('history + read-state survive a full page refresh', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('r1'), mkReport('r2')]);
        expect((await dbg(page)).unreadCount).toBe(2);

        await page.reload();
        await page.waitForFunction(
            () => typeof (window as any).__crispNotifDebug === 'function'
                && (window as any).__crispNotifDebug().initialLoadDone === true,
            null, { timeout: 15000 });

        // Center rehydrated from localStorage; nothing replayed as a toast.
        const d = await dbg(page);
        expect(d.center.map((n: any) => n.id).sort()).toEqual(['r1', 'r2']);
        expect(d.unreadCount).toBe(2);
        await expect(page.locator('#notif-stack .notif-stack-card')).toHaveCount(0);
    });
});


test.describe('Notification center — read model + categories', () => {
    test('opening a notification marks it read but keeps it in history', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('r1')]);

        await page.evaluate(() => (window as any).openNotif('r1'));

        const d = await dbg(page);
        expect(d.unreadCount).toBe(0);                              // badge cleared
        const rec = d.center.find((n: any) => n.id === 'r1');
        expect(rec).toBeTruthy();                                   // still in history
        expect(rec.read).toBe(true);
    });

    test('CRITICAL = Important (B); routine = Informational (A)', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('crit', { severity: 'CRITICAL' }), mkReport('minor', { severity: 'MINOR' })]);

        const d = await dbg(page);
        expect(d.center.find((n: any) => n.id === 'crit').cat).toBe('B');
        expect(d.center.find((n: any) => n.id === 'minor').cat).toBe('A');
    });

    test('Urgent (C) broadcast is persistent until acknowledged', async ({ page, request }) => {
        await boot(page, request);
        await page.evaluate(() => (window as any).crispUrgentBroadcast({ title: 'System outage', body: 'IVR degraded' }));

        const banner = page.locator('#notif-urgent-banner');
        await expect(banner).toBeVisible();
        // Still up after the 5s toast lifespan would have elapsed.
        await page.waitForTimeout(5200);
        await expect(banner).toBeVisible();

        await banner.locator('.nub-ack').click();
        await expect(banner).toBeHidden();
        const rec = (await dbg(page)).center.find((n: any) => n.cat === 'C');
        expect(rec.acknowledged).toBe(true);
    });
});


test.describe('Notification center — session summary', () => {
    test('shows a once-per-session "since your last visit" banner, not on route change', async ({ page, request }) => {
        await boot(page, request, {
            rows: [mkReport('s1', { severity: 'CRITICAL' }), mkReport('s2')],
            initWatermark: '2020-01-01T00:00:00Z',          // everything is "new" since then
        });

        // Banner appears on entry…
        await expect(page.locator('#notif-session-summary')).toBeVisible({ timeout: 4000 });
        // …and is recorded in the center exactly once.
        const before = (await dbg(page)).center.filter((n: any) => String(n.id).startsWith('__session'));
        expect(before.length).toBe(1);
        expect(before[0].body).toContain('new report');

        // A route change must NOT spawn a second summary.
        await page.evaluate(() => { window.location.hash = '#/incidents'; });
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.location.hash = '#/'; });
        await page.waitForTimeout(300);
        const after = (await dbg(page)).center.filter((n: any) => String(n.id).startsWith('__session'));
        expect(after.length).toBe(1);
    });
});


test.describe('Notification center — age gate (no historical replay)', () => {
    const agoIso = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

    test('a HISTORICAL report (hours old) lands silently in the bell — no toast', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('old1', { server_created_at: agoIso(130) })]);

        // No center-screen pop-up for the historical report…
        await expect(page.locator('#notif-stack .notif-stack-card[data-id="old1"]')).toHaveCount(0);
        // …but it IS captured in the Notification Center (reviewable, unread).
        const d = await dbg(page);
        expect(d.center.map((n: any) => n.id)).toContain('old1');
        expect(d.unreadCount).toBe(1);
    });

    test('a REAL-TIME report still pops a toast', async ({ page, request }) => {
        await boot(page, request);
        await apply(page, [mkReport('rt1', { server_created_at: new Date().toISOString() })]);
        await expect(page.locator('#notif-stack .notif-stack-card[data-id="rt1"]')).toBeVisible({ timeout: 2000 });
    });

    test('a backlog of historical reports on a scope full-refresh shows ONE summary banner, not N toasts', async ({ page, request }) => {
        await boot(page, request);
        // replace:true → _replaceReportData (the operation-scope-switch path).
        await apply(page, [
            mkReport('bk1', { server_created_at: agoIso(200) }),
            mkReport('bk2', { server_created_at: agoIso(210) }),
            mkReport('bk3', { server_created_at: agoIso(220) }),
        ], true);

        await expect(page.locator('#notif-session-summary')).toBeVisible({ timeout: 4000 });
        await expect(page.locator('#notif-session-summary')).toContainText('3 new reports');
        // None of the historical reports popped an individual toast.
        await expect(page.locator('#notif-stack .notif-stack-card')).toHaveCount(0);
        // All three are in the center for review.
        const ids = (await dbg(page)).center.map((n: any) => n.id);
        expect(ids).toEqual(expect.arrayContaining(['bk1', 'bk2', 'bk3']));
    });
});
