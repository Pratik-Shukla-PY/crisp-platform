/**
 * PWA — `_reconcileBeforeDequeue` MUST track variants whose chunk loop
 * threw mid-stream (mediaId set, chunkProgress > 0, complete=false).
 *
 * REGRESSION (May 2026, cellular smoke 3, operator-reported):
 *   "For Smoke-3 in my PWA I do not see any queued report and I am
 *    getting constant 5G why the ORIGINAL does not land?"
 *
 *   Captured 4 photos on real iPhone with constant 5G. The 2nd photo's
 *   ORIGINAL tier got stuck at received_chunks=21/24 on the backend.
 *   The PWA's queue was empty. Action ④ idle-promoted the report to
 *   SYNCED, dashboard showed it, but chunks 22-24 of that one ORIGINAL
 *   never made it.
 *
 *   Root cause: when the chunk-bin upload loop threw at chunk 22
 *   (transient cellular blip), the variant stayed `complete=false`
 *   with `chunkProgress=21`. `_reconcileBeforeDequeue`'s `collect()`
 *   pushed ONLY `complete=true` variants into the `expected[]` list.
 *   The mid-flight variant was INVISIBLE to reconcile.
 *
 *   Reconcile saw "every variant I tracked is on the server" → ok=true
 *   → dequeue. The queue item was deleted, the retry loop had nothing
 *   to resume, chunks 22-24 were orphaned forever.
 *
 *   Fix: include `chunkProgress > 0 && !complete` variants in
 *   `expected[]`. The downstream softAssembling/softMissing bucketing
 *   then drives the correct behaviour:
 *     - server has partial row → softAssembling → ok=false → keep queued
 *     - server has no row → softMissing → softDrain → mark deferred
 *
 *   Cache bump: sw.js v235 → v236.
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        // Isolation: drive the queue manually; suppress the background auto-drain
        // so it can't dequeue rows under assertion (read-after-enqueue flake fix).
        (window as any).__crispSuppressAutoDrain = true;
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
           && typeof (window as any).__crispReconcileBeforeDequeue === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — reconcile tracks in-flight chunked variants', () => {

    test.beforeEach(async ({ page }) => { await bootPwa(page); });

    test('in-flight ORIGINAL (chunkProgress>0, complete=false) keeps reconcile ok=false', async ({ page }) => {
        // The bug: the 4th ORIGINAL's chunk loop threw at chunk 22.
        // chunkProgress=21, complete=false. Server has the row in
        // pending state with received_chunks=21, chunk_count=24.
        // Pre-fix reconcile said ok=true (in-flight variant invisible).
        // Post-fix reconcile says ok=false (softAssembling tracks it).

        const REPORT_ID = 'inflight-test-report-aaaa';
        // Photo group 7fd0097a → matches the operator's case.
        const PENDING_MID = '7fd00aaa-bbbb-cccc-dddd-eeeeeeeeeeee';

        // Mock /tier-status to mirror the cellular-smoke-3 final state.
        await page.route(`**/api/v1/reports/${REPORT_ID}/tier-status`, (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    report_id: REPORT_ID,
                    media: [
                        // 4 photo groups, SMALL of every group complete.
                        { id: 'a1', photo_group_id: 'g1', resolution_tier: 'SMALL', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'b1', photo_group_id: 'g2', resolution_tier: 'SMALL', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'c1', photo_group_id: 'g3', resolution_tier: 'SMALL', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'd1', photo_group_id: 'g4', resolution_tier: 'SMALL', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        // MEDIUM of every group complete.
                        { id: 'a2', photo_group_id: 'g1', resolution_tier: 'MEDIUM', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'b2', photo_group_id: 'g2', resolution_tier: 'MEDIUM', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'c2', photo_group_id: 'g3', resolution_tier: 'MEDIUM', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        { id: 'd2', photo_group_id: 'g4', resolution_tier: 'MEDIUM', assembly_status: 'complete', received_chunks: 1, chunk_count: 1 },
                        // 3 of 4 ORIGINAL complete; the 4th stuck at 21/24.
                        { id: 'a3', photo_group_id: 'g1', resolution_tier: 'ORIGINAL', assembly_status: 'complete', received_chunks: 21, chunk_count: 21 },
                        { id: PENDING_MID, photo_group_id: 'g2', resolution_tier: 'ORIGINAL', assembly_status: 'pending', received_chunks: 21, chunk_count: 24 },
                        { id: 'c3', photo_group_id: 'g3', resolution_tier: 'ORIGINAL', assembly_status: 'complete', received_chunks: 15, chunk_count: 15 },
                        { id: 'd3', photo_group_id: 'g4', resolution_tier: 'ORIGINAL', assembly_status: 'complete', received_chunks: 24, chunk_count: 24 },
                    ],
                }),
            });
        });

        // Build the queue item shape that the PWA persists mid-stream.
        // The 4th group's ORIGINAL has chunkProgress=21, complete=false,
        // mediaId set — the exact state after `sendWithRetry` threw at
        // chunk 22 inside `_uploadVariantTier`'s bin loop.
        const reconciled = await page.evaluate(async ({ reportId, pendingMid }) => {
            const item = {
                client_report_id: 'inflight-test-crid',
                serverId: reportId,
                meta: {
                    client_report_id: 'inflight-test-crid',
                    device_hash: 'TEST-INFLIGHT',
                    source: 'APP',
                    expected_media: 13,
                },
                photoGroupId: 'g1',
                photoVariants: {
                    small:    { mediaId: 'a1', complete: true, chunkProgress: 1, dataUrl: null, size: 1024 },
                    medium:   { mediaId: 'a2', complete: true, chunkProgress: 1, dataUrl: null, size: 4096 },
                    original: { mediaId: 'a3', complete: true, chunkProgress: 21, dataUrl: null, size: 100000 },
                },
                extraPhotosVariants: [
                    // Group 2 — ORIGINAL is IN FLIGHT (the bug scenario).
                    {
                        groupId: 'g2',
                        small:    { mediaId: 'b1', complete: true, chunkProgress: 1, dataUrl: null, size: 1024 },
                        medium:   { mediaId: 'b2', complete: true, chunkProgress: 1, dataUrl: null, size: 4096 },
                        original: {
                            mediaId: pendingMid,
                            complete: false,        // ← chunk loop threw mid-stream
                            chunkProgress: 21,      // ← 21 of 24 chunks sent
                            dataUrl: 'data:image/jpeg;base64,/9j/...',  // dataUrl still in IDB
                            size: 110000,
                        },
                    },
                    {
                        groupId: 'g3',
                        small:    { mediaId: 'c1', complete: true, chunkProgress: 1, dataUrl: null, size: 1024 },
                        medium:   { mediaId: 'c2', complete: true, chunkProgress: 1, dataUrl: null, size: 4096 },
                        original: { mediaId: 'c3', complete: true, chunkProgress: 15, dataUrl: null, size: 80000 },
                    },
                    {
                        groupId: 'g4',
                        small:    { mediaId: 'd1', complete: true, chunkProgress: 1, dataUrl: null, size: 1024 },
                        medium:   { mediaId: 'd2', complete: true, chunkProgress: 1, dataUrl: null, size: 4096 },
                        original: { mediaId: 'd3', complete: true, chunkProgress: 24, dataUrl: null, size: 120000 },
                    },
                ],
                stages: { meta: true, text: true, photo: true, audio: true },
                text: 'cellular smoke 3',
            };
            return await (window as any).__crispReconcileBeforeDequeue(item, reportId);
        }, { reportId: REPORT_ID, pendingMid: PENDING_MID });

        // The fix's contract: reconcile must surface the in-flight
        // ORIGINAL as softAssembling (server has the row, not complete),
        // returning ok=false so the caller keeps the queue item alive.
        expect(reconciled.ok,
            'in-flight ORIGINAL chunk loop must keep reconcile ok=false ' +
            '(if ok=true, the queue item gets dequeued + chunks 22-24 orphan forever)'
        ).toBe(false);
        expect(reconciled.softDrain,
            'softDrain should be false — the mid-flight row is on the server, not missing'
        ).toBe(false);
        // The pending ORIGINAL must show up in softAssembling so the
        // retry loop's HARD-FAIL else branch (or a future wait branch)
        // re-attempts the chunks instead of dequeuing.
        expect(Array.isArray(reconciled.softAssembling),
            'softAssembling array must be returned'
        ).toBe(true);
        expect(reconciled.softAssembling.length,
            'softAssembling must include the 1 in-flight ORIGINAL'
        ).toBeGreaterThanOrEqual(1);
        const inflightEntry = reconciled.softAssembling.find(
            (m: any) => m.mediaId === PENDING_MID,
        );
        expect(inflightEntry,
            `softAssembling must reference the pending ORIGINAL mediaId ${PENDING_MID}`
        ).toBeTruthy();
        expect(inflightEntry.inflight,
            'the in-flight entry must carry the inflight=true marker so callers can log it differently'
        ).toBe(true);
    });

    test('all-complete report still reconciles ok=true (regression — fix must not affect happy path)', async ({ page }) => {
        // Negative case: when every variant is locally complete AND the
        // server has every row complete, reconcile must still return
        // ok=true → caller dequeues. Confirms the fix doesn't break
        // the happy path of a fully-drained report.
        const REPORT_ID = 'all-complete-report-bbbb';
        await page.route(`**/api/v1/reports/${REPORT_ID}/tier-status`, (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    report_id: REPORT_ID,
                    media: [
                        { id: 'mid-s', photo_group_id: 'g1', resolution_tier: 'SMALL',    assembly_status: 'complete', received_chunks: 1,  chunk_count: 1  },
                        { id: 'mid-m', photo_group_id: 'g1', resolution_tier: 'MEDIUM',   assembly_status: 'complete', received_chunks: 1,  chunk_count: 1  },
                        { id: 'mid-o', photo_group_id: 'g1', resolution_tier: 'ORIGINAL', assembly_status: 'complete', received_chunks: 24, chunk_count: 24 },
                    ],
                }),
            });
        });
        const reconciled = await page.evaluate(async ({ reportId }) => {
            const item = {
                client_report_id: 'all-complete-crid',
                serverId: reportId,
                meta: { client_report_id: 'all-complete-crid', device_hash: 'TEST-COMPLETE', source: 'APP', expected_media: 3 },
                photoGroupId: 'g1',
                photoVariants: {
                    small:    { mediaId: 'mid-s', complete: true, chunkProgress: 1,  dataUrl: null, size: 1024 },
                    medium:   { mediaId: 'mid-m', complete: true, chunkProgress: 1,  dataUrl: null, size: 4096 },
                    original: { mediaId: 'mid-o', complete: true, chunkProgress: 24, dataUrl: null, size: 100000 },
                },
                extraPhotosVariants: [],
                stages: { meta: true, text: true, photo: true, audio: true },
                text: 'happy path',
            };
            return await (window as any).__crispReconcileBeforeDequeue(item, reportId);
        }, { reportId: REPORT_ID });

        expect(reconciled.ok, 'all-complete report must reconcile ok=true').toBe(true);
        expect(reconciled.softDrain, 'no missing tiers → softDrain=false').toBe(false);
    });
});
