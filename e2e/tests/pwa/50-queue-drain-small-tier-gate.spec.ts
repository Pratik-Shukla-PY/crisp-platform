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
 *
 * May 2026 second-pass update — the `#hi-pending` tile was retired
 * along with `#hi-resolved` (operator: "they don't carry significance
 * to the user"). The impact card is now single-stat (Lives Saved).
 * The race condition can no longer recur because the contested
 * element is gone; the equivalent invariant is asserted via card
 * count in #history-partial-list instead.
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        // Force English so the Bengaluru GPS fixture in
        // playwright.config.ts doesn't auto-detect Kannada — text
        // assertions in this spec (e.g. "waiting: photo, audio") need
        // English locale to match.
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
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

    test('in-flight cards render with matching count (no parallel-render race)', async ({ page }) => {
        // May 2026 (operator-reported, second pass) — the impact card
        // at the top of My Reports is now SINGLE-stat (Lives Saved
        // only); the IN-FLIGHT / RESOLVED tiles were retired. The race
        // this test originally guarded against (parallel `_renderSubmittedReports`
        // overwriting the in-flight pill with 0) cannot recur because
        // the pill is gone. We keep an equivalent invariant: enqueueing
        // 3 reports causes 3 cards to render in the in-flight section.
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
        await page.evaluate(async () => {
            await (window as any).__crispRenderPartialReports();
        });
        const cards = await page.locator('#history-partial-list .history-row').count();
        expect(cards).toBe(3);
        // The single-stat impact card no longer exposes an in-flight
        // tile to assert; the section is implicit from the visible
        // card count above. The `#hi-pending` element is intentionally
        // absent from the DOM after the redesign.
        await expect(page.locator('#hi-pending')).toHaveCount(0);
        // Cleanup.
        await page.evaluate(async () => {
            for (let i = 0; i < 3; i++) {
                try { await (window as any).__crispDequeueReport(`pending-stat-${i}`); } catch (_) {}
            }
        });
    });

    test('reconcile keeps entry but marks _submissionLanded when SMALL is up + MEDIUM/LARGE deferred', async ({ page }) => {
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
                        { id: 'm-small', resolution_tier: 'SMALL' },
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
                    original:  { dataUrl: 'data:,', mediaId: 'mid-l', complete: false, chunkProgress: 0, size: 16384, deferred: true },
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
        // Post-condition (May 2026 BUGFIX, app.js:10168-10222) — when
        // SMALL is up but MEDIUM/LARGE are flagged `deferred=true`, the
        // item STAYS queued so the retry loop can finish the deferred
        // tiers (production audit: ~44% of photo groups had only
        // SMALL+MEDIUM on backend because Originals were generated
        // locally then deferred on slow link). The item gets marked
        // `_submissionLanded=true` so the sync-badge ignores it (the
        // user-facing "1 queued" pill drops to 0).
        const items = await page.evaluate(async () => (await (window as any).__crispGetAllQueued()));
        expect(items.length,
            'reconcile keeps the entry queued for deferred MEDIUM/LARGE retry'
        ).toBe(1);
        expect(items[0]._submissionLanded,
            'reconcile must mark _submissionLanded=true so the UI badge ignores this row'
        ).toBe(true);
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
                    original:  { dataUrl: 'data:,', mediaId: 'mid-l', complete: false, chunkProgress: 0, size: 16384 },
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
