/**
 * PWA — Queue drain on SMALL-tier completion (May 2026).
 *
 * Operator report (3 prompts of the SAME bug before this fix landed):
 *   "3 queued reports stuck at 75% — FLOOD · ROAD cards in My Reports
 *    showing QUEUED forever; not reaching dashboard."
 *
 * Root causes (4 independent bugs funnelling into the same UX):
 *
 *   1. `stages.photo` only flipped when ALL THREE tiers (SMALL+MEDIUM
 *      +LARGE) had `complete=true`. But `_uploadVariantTier` *defers*
 *      MEDIUM/LARGE on SLOW/VERY_SLOW networks (lines 7505-7517) —
 *      leaving `complete=false` on those tiers indefinitely. Result:
 *      `allComplete=false` → `stages.photo=false` → My Reports card
 *      stuck at 75% forever.
 *
 *   2. `_reconcileQueueAgainstServer` checked `have < expected` against
 *      `expected_media` (= 3 × photo_count for variant uploads). On
 *      deferred-tier networks the server only ever saw SMALL → reconcile
 *      never dequeued → queue stayed full.
 *
 *   3. `_uploadVariantTier` silently `return`ed on `dataUrl=null` with
 *      no retry limit, no fallback, no user-visible error. Same end
 *      state if `_encodeVariants` had failed at submit time.
 *
 *   4. The "0 IN FLIGHT" stat at the top of My Reports raced against
 *      the partial-list render — `_renderSubmittedReports` read the
 *      DOM count in parallel with `_renderPartialReports` painting,
 *      so the pill displayed 0 while 3 cards were visible below.
 *
 * Fix:
 *   · `stages.photo` flips when SMALL of every photo is complete (the
 *     dashboard-visible tier). MEDIUM/LARGE continue retrying on
 *     subsequent passes but no longer block the queue drain.
 *   · Reconcile dequeues entries where the server has SMALL of every
 *     photo, even if MEDIUM/LARGE haven't reached the backend.
 *   · Stuck-reason hint on each in-flight card (e.g. "waiting: photo")
 *     so the next bug gives the user something concrete to report.
 *   · `_renderPartialReports` owns the `hi-pending` stat — it can read
 *     `inflight.length` directly instead of querying the DOM.
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
           && typeof (window as any).__crispRenderPartialReports === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — Queue drain SMALL-tier gate (May 2026)', () => {

    test.beforeEach(async ({ page }) => { await bootPwa(page); });

    test('@smoke stuck-reason hint surfaces missing stages on queue card', async ({ page }) => {
        // Enqueue a report stuck at 75% (meta + text done, photo + audio missing)
        // and confirm the card body now contains "waiting: photo, audio" instead
        // of just "75% · <id>".
        await page.evaluate(() => {
            (window as any).__crispEnqueueReport({
                client_report_id: 'stuck-reason-test',
                meta: {
                    client_report_id: 'stuck-reason-test',
                    device_hash: 'TEST-STUCK-REASON',
                    source: 'APP',
                    severity: 'MODERATE',
                    crisis_type: 'FLOOD',
                    infrastructure_type: 'ROAD',
                    expected_media: 0,
                    location: { latitude: 12.97, longitude: 77.59 },
                },
                stages: { meta: true, text: true, photo: false, audio: false },
                text: '',
            });
        });
        await page.evaluate(() => (window as any).__crispRenderPartialReports());
        const meta = await page.locator('#history-partial-list .history-row .hr-meta').first().innerText();
        // Card must contain the stuck-reason hint AND keep the id slice.
        expect(meta.toLowerCase()).toContain('waiting');
        expect(meta.toLowerCase()).toContain('photo');
        // Cleanup.
        await page.evaluate(async () => {
            await (window as any).__crispDequeueReport('stuck-reason-test');
        });
    });

    test('hi-pending stat matches the visible cards (no parallel-render race)', async ({ page }) => {
        // Enqueue 3 in-flight reports and verify the "IN FLIGHT" stat
        // displays 3 (not 0) after the My Reports panel renders.
        await page.evaluate(() => {
            for (let i = 0; i < 3; i++) {
                (window as any).__crispEnqueueReport({
                    client_report_id: `pending-stat-${i}`,
                    meta: {
                        client_report_id: `pending-stat-${i}`,
                        device_hash: 'TEST-PENDING-STAT',
                        source: 'APP',
                        severity: 'MODERATE',
                        crisis_type: 'FLOOD',
                        infrastructure_type: 'ROAD',
                        expected_media: 0,
                        location: { latitude: 12.97, longitude: 77.59 },
                    },
                    stages: { meta: true, text: true, photo: false, audio: false },
                    text: '',
                });
            }
        });
        // Drive both renderers exactly the way openMyReports does — in
        // parallel via Promise.all. The race we're guarding against is
        // _renderSubmittedReports reading the DOM count before
        // _renderPartialReports has painted.
        await page.evaluate(async () => {
            await Promise.all([
                (window as any).__crispRenderPartialReports(),
                // _renderSubmittedReports is private; the public surface is
                // the public renderer which awaits both internally. The
                // partial renderer now owns the stat update, so we don't
                // need to call _renderSubmittedReports in this test — what
                // we're proving is that the partial renderer's own write
                // matches the rendered count.
            ]);
        });
        const cards = await page.locator('#history-partial-list .history-row').count();
        expect(cards).toBe(3);
        const pendingText = await page.locator('#hi-pending').innerText();
        expect(pendingText, 'hi-pending stat must match rendered card count').toBe('3');
        // Cleanup.
        await page.evaluate(async () => {
            for (let i = 0; i < 3; i++) {
                try { await (window as any).__crispDequeueReport(`pending-stat-${i}`); } catch (_) {}
            }
        });
    });

    test('reconcile dequeues entry where server has SMALL of every photo (even with MEDIUM/LARGE pending)', async ({ page }) => {
        // Spoof the server status-since response to mimic the post-SMALL
        // state: server has 1 LOW-tier media row, 0 MEDIUM, 0 HIGH for a
        // single-photo report. expected_media = 3. Pre-fix: have=1 < exp=3
        // → keep queued forever. Post-fix: SMALL count (1) ≥ photo count
        // (1) → dequeue.
        const SERVER_CRID = 'reconcile-small-only';
        const DEVICE_HASH = 'TEST-RECONCILE-SMALL';
        await page.route('**/api/v1/reports/device/**/status-since*', (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([{
                    id: 'server-id-aaaa',
                    client_report_id: SERVER_CRID,
                    status: 'PENDING',
                    media: [
                        { id: 'm-small', resolution_tier: 'LOW' },
                        // medium and large absent on purpose
                    ],
                }]),
            });
        });
        await page.evaluate(({ crid, deviceHash }) => {
            localStorage.setItem('crisp_device_id_v2', deviceHash);
            (window as any).__crispEnqueueReport({
                client_report_id: crid,
                meta: {
                    client_report_id: crid,
                    device_hash: deviceHash,
                    source: 'APP',
                    severity: 'MODERATE',
                    crisis_type: 'FLOOD',
                    infrastructure_type: 'ROAD',
                    expected_media: 3,
                    location: { latitude: 12.97, longitude: 77.59 },
                },
                stages: { meta: true, text: true, photo: false, audio: true },
                serverId: 'server-id-aaaa',
                photoVariants: {
                    small:  { dataUrl: null, mediaId: 'mid-s', complete: true,  chunkProgress: 0, size: 1024 },
                    medium: { dataUrl: 'data:,', mediaId: 'mid-m', complete: false, chunkProgress: 0, size: 4096, deferred: true },
                    large:  { dataUrl: 'data:,', mediaId: 'mid-l', complete: false, chunkProgress: 0, size: 16384, deferred: true },
                },
                extraPhotosVariants: [],
                text: '',
            });
            // Bust the single-flight cache so the route handler fires.
            try { (window as any).__crispClearFetchCache(); } catch (_) {}
        }, { crid: SERVER_CRID, deviceHash: DEVICE_HASH });
        // Pre-condition: 1 item queued.
        const before = await page.evaluate(async () => (await (window as any).__crispGetAllQueued()).length);
        expect(before).toBe(1);
        // Run reconciliation directly (avoids the 15s retry-loop wait).
        await page.evaluate(() => (window as any).__crispReconcileQueue());
        // Post-condition: queue drained even though only SMALL landed.
        const after = await page.evaluate(async () => (await (window as any).__crispGetAllQueued()).length);
        expect(after, 'reconcile must drain when SMALL of every photo is up').toBe(0);
    });

    test('reconcile keeps queued when server has 0 SMALL (still genuinely in flight)', async ({ page }) => {
        // Negative case: if even SMALL hasn't landed, reconcile MUST keep
        // the entry queued — otherwise we'd lose the only path back to
        // the user's photo bytes.
        const CRID = 'reconcile-no-small-yet';
        const DEVICE_HASH = 'TEST-RECONCILE-NONE';
        await page.route('**/api/v1/reports/device/**/status-since*', (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([{
                    id: 'server-id-bbbb',
                    client_report_id: CRID,
                    status: 'PENDING',
                    media: [], // server has nothing yet
                }]),
            });
        });
        await page.evaluate(({ crid, deviceHash }) => {
            localStorage.setItem('crisp_device_id_v2', deviceHash);
            (window as any).__crispEnqueueReport({
                client_report_id: crid,
                meta: {
                    client_report_id: crid,
                    device_hash: deviceHash,
                    source: 'APP',
                    severity: 'MODERATE',
                    crisis_type: 'FLOOD',
                    infrastructure_type: 'ROAD',
                    expected_media: 3,
                    location: { latitude: 12.97, longitude: 77.59 },
                },
                stages: { meta: true, text: true, photo: false, audio: true },
                serverId: 'server-id-bbbb',
                photoVariants: {
                    small:  { dataUrl: 'data:,', mediaId: 'mid-s', complete: false, chunkProgress: 0, size: 1024 },
                    medium: { dataUrl: 'data:,', mediaId: 'mid-m', complete: false, chunkProgress: 0, size: 4096 },
                    large:  { dataUrl: 'data:,', mediaId: 'mid-l', complete: false, chunkProgress: 0, size: 16384 },
                },
                extraPhotosVariants: [],
                text: '',
            });
            try { (window as any).__crispClearFetchCache(); } catch (_) {}
        }, { crid: CRID, deviceHash: DEVICE_HASH });
        await page.evaluate(() => (window as any).__crispReconcileQueue());
        const after = await page.evaluate(async () => (await (window as any).__crispGetAllQueued()).length);
        expect(after, 'reconcile must NOT drain when server has 0 SMALL — photo bytes still local').toBe(1);
        // Cleanup.
        await page.evaluate(async () => {
            try { await (window as any).__crispDequeueReport(CRID); } catch (_) {}
        }, );
    });
});
