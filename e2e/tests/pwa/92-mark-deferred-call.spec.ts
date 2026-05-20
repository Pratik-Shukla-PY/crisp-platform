/**
 * PWA — K.3.a (Phase K, May 2026): soft-drain calls
 * `POST /reports/{id}/media/mark-deferred`.
 *
 * When `_reconcileBeforeDequeue` returns `ok=true, softDrain=true`
 * inside `trySendQueuedReport`, the PWA marks the missing tiers as
 * `deferred=true` locally AND now signals the backend explicitly so
 * `expected_media` decrements and the dashboard chip can render
 * "Original (slow network)" (K.5.a). Pre-K.3.a the PWA dequeued
 * without telling the backend, leaving expected_media at the optimistic
 * count and Action ④ as the only safety net.
 *
 * The spec exercises this branch via the existing
 * `window.__crispEnqueueReport` + new `window.__crispTrySendQueuedReport`
 * surfaces, route-intercepting every backend hit so the test doesn't
 * need a live backend. The mark-deferred call is captured to assert the
 * payload shape.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K3A-MARK-DEFERRED';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispTrySendQueuedReport === 'function'
            && typeof (window as any).__crispEnumerateDeferredByGroup === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.3.a — mark-deferred call on soft-drain', () => {
    test('soft-drain POSTs /media/mark-deferred with correct tiers_by_group shape', async ({ page }) => {
        const cid = 'k3a-cid-softdrain-1';
        const reportId = 'k3a-server-report-1';
        const photoGroupId = 'k3a-photo-group-1';
        const smallMediaId = 'k3a-small-mid';
        const mediumMediaId = 'k3a-medium-mid';
        const originalMediaId = 'k3a-original-mid';

        // Stub /tier-status so reconcile returns: SMALL complete on
        // server; MEDIUM + ORIGINAL missing → softDrain=true, missing=
        // [{medium, original}].
        // Phase L (May 2026): backend ResolutionEnum is SMALL/MEDIUM/ORIGINAL;
        // pre-L LOW/HIGH were dropped in alembic 0036.
        await page.route(/\/api\/v1\/reports\/[^/]+\/tier-status$/, (route) => {
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    media: [
                        { id: smallMediaId, resolution_tier: 'SMALL',
                          type: 'IMAGE', assembly_status: 'complete' },
                        // MEDIUM + ORIGINAL: nothing on server
                    ],
                }),
            });
        });

        // Capture the mark-deferred POST body.
        let capturedBody: any = null;
        await page.route(
            /\/api\/v1\/reports\/[^/]+\/media\/mark-deferred$/,
            async (route) => {
                capturedBody = JSON.parse(route.request().postData() || '{}');
                await route.fulfill({
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        report_id: reportId,
                        newly_stamped: 2,
                        expected_media: 1,
                        received_media: 1,
                        sync_status: 'SYNCED',
                    }),
                });
            },
        );

        await bootPwa(page);

        // Seed an IDB queue item that mirrors the post-upload state:
        // serverId set, all stages true (so trySendQueuedReport enters
        // the reconcile branch), photoVariants with MEDIUM+LARGE marked
        // complete locally but reconcile will discover they're missing.
        await page.evaluate(async ({ cid, reportId, photoGroupId, smallMediaId, mediumMediaId, originalMediaId }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: true, audio: true },
                photoGroupId,
                photoVariants: {
                    clientBlurApplied: true,
                    small:    { mediaId: smallMediaId,    complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 1024 },
                    medium:   { mediaId: mediumMediaId,   complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 4096 },
                    original: { mediaId: originalMediaId, complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 16384 },
                },
                extraPhotosVariants: [],
                meta: { expected_media: 3 },
            });
        }, { cid, reportId, photoGroupId, smallMediaId, mediumMediaId, originalMediaId });

        // Trigger trySendQueuedReport — it'll detect all stages done,
        // reconcile (which returns softDrain), then call mark-deferred
        // before dequeue.
        const items = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const item = items.find((q: any) => q.client_report_id === cid);
        expect(item).toBeDefined();

        await page.evaluate(async (it) => {
            await (window as any).__crispTrySendQueuedReport(it);
        }, item);

        // Wait briefly for any in-flight fetch to settle.
        await page.waitForTimeout(500);

        // Assertion: mark-deferred was called with the right shape.
        expect(capturedBody, 'POST /media/mark-deferred must fire on soft-drain').not.toBeNull();
        expect(capturedBody.tiers_by_group).toBeDefined();
        expect(capturedBody.tiers_by_group[photoGroupId]).toBeDefined();
        const tiersForGroup = capturedBody.tiers_by_group[photoGroupId].sort();
        // MEDIUM + ORIGINAL should both be in the list (SMALL landed, so it's not).
        // Phase L canonical wire vocab — backend 422s anything else.
        expect(tiersForGroup).toEqual(['MEDIUM', 'ORIGINAL']);
        expect(capturedBody.reason).toBe('bandwidth_tier_deferred');

        // Assertion: item was dequeued AFTER the signal was sent.
        const queuedAfter = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const stillThere = queuedAfter.find((q: any) => q.client_report_id === cid);
        expect(stillThere, 'item should be dequeued after mark-deferred completes').toBeUndefined();
    });

    test('_enumerateDeferredByGroup maps main + extras correctly', async ({ page }) => {
        await bootPwa(page);

        // Build a minimal item shape with main + one extra, then feed
        // a fake `missing` array as the reconciler would produce.
        // Phase L canonical vocab: variant keys + tier names are
        // small/medium/original; backend wire vocab is SMALL/MEDIUM/ORIGINAL.
        const result = await page.evaluate(() => {
            const item = {
                photoGroupId: 'main-grp',
                photoVariants: {
                    small:    { mediaId: 'main-small-mid' },
                    medium:   { mediaId: 'main-medium-mid' },
                    original: { mediaId: 'main-original-mid' },
                },
                extraPhotosVariants: [
                    {
                        groupId: 'extra0-grp',
                        small:    { mediaId: 'extra0-small-mid' },
                        medium:   { mediaId: 'extra0-medium-mid' },
                        original: { mediaId: 'extra0-original-mid' },
                    },
                ],
            };
            const missing = [
                // Main MEDIUM + ORIGINAL deferred
                { mediaId: 'main-medium-mid',   tier: 'medium',   label: 'main/medium',   variant: item.photoVariants.medium },
                { mediaId: 'main-original-mid', tier: 'original', label: 'main/original', variant: item.photoVariants.original },
                // Extra ORIGINAL deferred
                { mediaId: 'extra0-original-mid', tier: 'original', label: 'extra[0]/original', variant: item.extraPhotosVariants[0].original },
            ];
            return (window as any).__crispEnumerateDeferredByGroup(item, missing);
        });

        expect(result).toBeDefined();
        expect(Object.keys(result).sort()).toEqual(['extra0-grp', 'main-grp']);
        expect(result['main-grp'].sort()).toEqual(['MEDIUM', 'ORIGINAL']);
        expect(result['extra0-grp'].sort()).toEqual(['ORIGINAL']);
    });

    test('_enumerateDeferredByGroup returns {} when missing is empty', async ({ page }) => {
        await bootPwa(page);
        const result = await page.evaluate(() => {
            return (window as any).__crispEnumerateDeferredByGroup(
                {
                    photoGroupId: 'main-grp',
                    photoVariants: { small: { mediaId: 'x' } },
                    extraPhotosVariants: [],
                },
                [],
            );
        });
        expect(result).toEqual({});
    });

    test('mark-deferred 5xx does not block dequeue (fail-open)', async ({ page }) => {
        const cid = 'k3a-cid-failopen-1';
        const reportId = 'k3a-server-failopen-1';
        const photoGroupId = 'k3a-failopen-group';
        const smallMediaId = 'k3a-failopen-small';
        const mediumMediaId = 'k3a-failopen-medium';
        const largeMediaId = 'k3a-failopen-large';

        await page.route(/\/api\/v1\/reports\/[^/]+\/tier-status$/, (route) => {
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    media: [{ id: smallMediaId, resolution_tier: 'LOW',
                              type: 'IMAGE', assembly_status: 'complete' }],
                }),
            });
        });

        // Backend mark-deferred returns 500 — PWA must still dequeue.
        await page.route(
            /\/api\/v1\/reports\/[^/]+\/media\/mark-deferred$/,
            (route) => route.fulfill({
                status: 500,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ detail: 'simulated server error' }),
            }),
        );

        await bootPwa(page);

        await page.evaluate(async ({ cid, reportId, photoGroupId, smallMediaId, mediumMediaId, largeMediaId }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: true, audio: true },
                photoGroupId,
                photoVariants: {
                    clientBlurApplied: true,
                    small:  { mediaId: smallMediaId,  complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 1024 },
                    medium: { mediaId: mediumMediaId, complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 4096 },
                    large:  { mediaId: largeMediaId,  complete: true, deferred: false, dataUrl: '', chunkProgress: 0, size: 16384 },
                },
                extraPhotosVariants: [],
                meta: { expected_media: 3 },
            });
        }, { cid, reportId, photoGroupId, smallMediaId, mediumMediaId, largeMediaId });

        const items = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const item = items.find((q: any) => q.client_report_id === cid);
        await page.evaluate(async (it) => {
            await (window as any).__crispTrySendQueuedReport(it);
        }, item);

        await page.waitForTimeout(500);

        // mark-deferred 500 → PWA logs warning + continues to dequeue.
        const queuedAfter = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const stillThere = queuedAfter.find((q: any) => q.client_report_id === cid);
        expect(stillThere, 'PWA must dequeue even when mark-deferred 5xx (backend sweep catches it)').toBeUndefined();
    });
});
