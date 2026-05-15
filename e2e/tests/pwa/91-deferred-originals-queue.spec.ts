/**
 * PWA — deferred-Originals queue retention (May 2026, operator-audit fix).
 *
 * Production audit: 44 % of photo groups on PROD lacked a HIGH-tier
 * Original. Root cause was the PWA's reconciler dequeueing IDB rows
 * as soon as SMALL of every photo landed on the backend — without
 * checking whether the local item had deferred MEDIUM/LARGE variants
 * still waiting to upload. Once the IDB row was dequeued, the retry
 * loop had nothing to retry against.
 *
 * The fix:
 *   • `_hasDeferredVariantsPending(item)` returns true if any variant
 *     has `deferred=true && complete=false`.
 *   • Reconciler sets `item._submissionLanded=true` + persists when
 *     SMALL has landed but deferred variants remain — DOES NOT dequeue.
 *   • Sync-badge filters out items where `_submissionLanded=true` so
 *     the user doesn't see "1 queued" forever (the original UX
 *     complaint that prompted the over-aggressive dequeue).
 *   • Hard 14-day timeout — if `_deferredSince` is older, dequeue
 *     anyway (Original permanently lost on this device).
 *
 * This spec exercises the reconciler via the existing
 * `window.__crispReconcileQueue()` / `__crispEnqueueReport` /
 * `__crispGetAllQueued` test surfaces. The `/reports/device/<hash>/
 * status-since` fetch is stubbed via Playwright route-interception so
 * the test doesn't depend on a live backend.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-DEFERRED-ORIG';

/**
 * Stub the status-since endpoint that the reconciler reads. Returns
 * `serverShape` which mimics the API response — list of report rows
 * carrying `client_report_id` + `media[]` (each with `resolution_tier`).
 * MUST be called BEFORE goto so the in-flight cache (_singleFlightFetch
 * in app.js) doesn't lock in an empty/404 result from app boot.
 */
async function stubStatusSince(page, serverShape) {
    await page.route(/\/api\/v1\/reports\/device\/[^/]+\/status-since/, (route) => {
        route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(serverShape),
        });
    });
}

async function bootPwa(page, serverShape = []) {
    // Route stub MUST be set before goto so app.js's initial reconcile
    // call doesn't cache an empty/404 status-since response that would
    // shadow our stub for the rest of the test.
    await stubStatusSince(page, serverShape);
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispReconcileQueue === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — deferred-Originals queue retention', () => {
    test('reconciler KEEPS item when SMALL landed but deferred variant remains', async ({ page }) => {
        const cid = 'cid-deferred-1';
        // PROD scenario: client queued 3 variants (S+M+L = expected_media:3)
        // but only SMALL landed on the backend (LARGE was deferred locally
        // due to slow link). Reconciler enters the staged-reconcile branch
        // because `haveAll(1) < expected(3)`, then falls to the new
        // _hasDeferredVariantsPending check.
        await bootPwa(page, [{
            client_report_id: cid,
            id: 'srv-report-1',
            media: [{ id: 'm1', resolution_tier: 'LOW', type: 'IMAGE' }],
        }]);

        await page.evaluate(async (clientId) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: clientId,
                meta: { expected_media: 3 },   // 1 photo × 3 variants
                photoVariants: {
                    small:  { complete: true,  deferred: false, dataUrl: '' },
                    medium: { complete: true,  deferred: false, dataUrl: '' },
                    large:  { complete: false, deferred: true,  dataUrl: 'data:image/jpeg;base64,AAAA' },
                    clientBlurApplied: true,
                },
                stages: { meta: true, text: true, photo: true, audio: true },
            });
        }, cid);

        await page.evaluate(() => (window as any).__crispReconcileQueue());

        // Item is still in the queue (not dequeued).
        const queued = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const ours = queued.find((q) => q.client_report_id === cid);
        expect(ours, 'item should still be queued; large variant is deferred-pending').toBeDefined();
        expect(ours._submissionLanded).toBe(true);
        expect(typeof ours._deferredSince).toBe('number');
        // Cleanup so the test is rerunnable.
        await page.evaluate((c) => (window as any).__crispDequeueReport(c), cid);
    });

    test('reconciler DEQUEUES item when all variants are complete', async ({ page }) => {
        const cid = 'cid-all-complete-1';
        await bootPwa(page, [{
            client_report_id: cid,
            id: 'srv-report-2',
            media: [
                { id: 'm1', resolution_tier: 'LOW',    type: 'IMAGE' },
                { id: 'm2', resolution_tier: 'MEDIUM', type: 'IMAGE' },
                { id: 'm3', resolution_tier: 'HIGH',   type: 'IMAGE' },
            ],
        }]);

        await page.evaluate(async (clientId) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: clientId,
                meta: { expected_media: 3 },   // 1 photo × 3 variants
                photoVariants: {
                    small:  { complete: true, deferred: false, dataUrl: '' },
                    medium: { complete: true, deferred: false, dataUrl: '' },
                    large:  { complete: true, deferred: false, dataUrl: '' },
                    clientBlurApplied: true,
                },
                stages: { meta: true, text: true, photo: true, audio: true },
            });
        }, cid);

        await page.evaluate(() => (window as any).__crispReconcileQueue());

        const queued = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const ours = queued.find((q) => q.client_report_id === cid);
        expect(ours, 'item should be dequeued — all variants complete').toBeUndefined();
    });

    test('reconciler DEQUEUES item when 14-day deferral timeout expires', async ({ page }) => {
        const cid = 'cid-timeout-expired-1';
        await bootPwa(page, [{
            client_report_id: cid,
            id: 'srv-report-3',
            media: [{ id: 'm1', resolution_tier: 'LOW', type: 'IMAGE' }],
        }]);

        // Enqueue with _deferredSince already 15 days in the past.
        await page.evaluate(async (clientId) => {
            const FIFTEEN_DAYS_AGO = Date.now() - 15 * 24 * 60 * 60 * 1000;
            await (window as any).__crispEnqueueReport({
                client_report_id: clientId,
                meta: { expected_media: 3 },   // 1 photo × 3 variants
                photoVariants: {
                    small:  { complete: true,  deferred: false, dataUrl: '' },
                    medium: { complete: true,  deferred: false, dataUrl: '' },
                    large:  { complete: false, deferred: true,  dataUrl: '' },
                    clientBlurApplied: true,
                },
                stages: { meta: true, text: true, photo: true, audio: true },
                _submissionLanded: true,
                _deferredSince: FIFTEEN_DAYS_AGO,
            });
        }, cid);

        await page.evaluate(() => (window as any).__crispReconcileQueue());

        const queued = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const ours = queued.find((q) => q.client_report_id === cid);
        expect(
            ours,
            'item should be dequeued — deferred-since > 14 days, Original lost',
        ).toBeUndefined();
    });

    test('sync-badge filters out _submissionLanded items (no "1 queued" forever)', async ({ page }) => {
        const cid = 'cid-syncbadge-1';
        await bootPwa(page, [{
            client_report_id: cid,
            id: 'srv-report-4',
            media: [{ id: 'm1', resolution_tier: 'LOW', type: 'IMAGE' }],
        }]);

        // Enqueue an item already marked _submissionLanded.
        await page.evaluate(async (clientId) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: clientId,
                meta: { expected_media: 3 },   // 1 photo × 3 variants
                photoVariants: {
                    small:  { complete: true,  deferred: false, dataUrl: '' },
                    large:  { complete: false, deferred: true,  dataUrl: '' },
                    clientBlurApplied: true,
                },
                stages: { meta: true, text: true, photo: true, audio: true },
                _submissionLanded: true,
                _deferredSince: Date.now(),
            });
        }, cid);

        // The badge updates inside the reconciler at the end of every
        // sweep. Trigger an explicit sync-badge update so the test isn't
        // racing the periodic loop.
        await page.evaluate(async () => {
            if (typeof (window as any).updateSyncBadge === 'function') {
                await (window as any).updateSyncBadge();
            }
        });

        // Badge must be hidden (display:none) because the only queued
        // item is _submissionLanded=true and therefore filtered out.
        const badge = page.locator('#sync-badge');
        await expect(badge).toBeHidden();

        // Cleanup.
        await page.evaluate((c) => (window as any).__crispDequeueReport(c), cid);
    });
});
