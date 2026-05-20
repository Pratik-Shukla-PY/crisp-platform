/**
 * PWA — K.3.c (Phase K, May 2026): variant dataUrl re-encode fallback +
 * orphan-deferred marking.
 *
 * Pre-fix `_uploadVariantTier` at mobile-app/src/app.js:8687 warned
 * "missing dataUrl (skip)" + returned, permanently orphaning the
 * variant. The dashboard never saw it; the operator had no signal.
 *
 * New behaviour:
 *   1. If variant.dataUrl is missing AND a legacy data URL is on
 *      `item.photo` (main) or `item.extraPhotos[i]` (extras), the
 *      data URL is recovered + persisted on the variant + the upload
 *      proceeds normally.
 *   2. If no fallback source exists, the variant is marked
 *      `deferred=true, deferredReason='orphan_no_source', deferredAt=now`
 *      so the soft-drain path (K.3.a) signals the backend via
 *      `/media/mark-deferred` and the dashboard chip (K.5.a) renders
 *      "Original (slow network)" — never silent loss.
 *
 * The spec exercises both branches via the new
 * `window.__crispUploadVariantTier` test surface; the underlying
 * fetch to `/media/chunk-bin` is route-intercepted to a 200 so the
 * recovery path can run end-to-end.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K3C-REENCODE';
const TINY_PNG_DATAURL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

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
            && typeof (window as any).__crispUploadVariantTier === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.3.c — variant dataUrl re-encode fallback', () => {
    test('missing dataUrl on main is recovered from item.photo legacy field', async ({ page }) => {
        const cid = 'k3c-cid-recover-main';
        const reportId = 'k3c-server-report-recover';
        const photoGroupId = 'k3c-grp-recover-main';
        const mediumMediaId = 'k3c-med-recover';

        // Route the upload-probe so adaptTierViaProbe doesn't try to
        // reach a real backend.
        await page.route(/\/api\/v1\/reports\/upload-probe$/, (route) =>
            route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ ok: true }) }));

        // Stub chunk-bin so the upload "succeeds" without touching disk.
        let chunkBinHits = 0;
        await page.route(/\/api\/v1\/reports\/[^/]+\/media\/chunk-bin$/, (route) => {
            chunkBinHits++;
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    media_id: mediumMediaId,
                    seq_num: 0,
                    received: 1,
                    total: 1,
                    completion_pct: 100,
                    assembly_status: 'pending',
                }),
            });
        });

        await bootPwa(page);

        // Enqueue an item where:
        //   - item.photo carries a legacy data URL (recovery source)
        //   - photoVariants.medium.dataUrl is empty (forces fallback)
        await page.evaluate(async ({ cid, reportId, photoGroupId, mediumMediaId, legacyUrl }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId,
                photo: legacyUrl,    // legacy single-image source
                // Phase L (May 2026): canonical variant key is `original`.
                // IDB read-migration converts legacy `large` → `original`,
                // so tests must enqueue with the canonical key directly.
                photoVariants: {
                    clientBlurApplied: true,
                    small:    { mediaId: 'k3c-small-x',     complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 1024 },
                    medium:   { mediaId: mediumMediaId,     complete: false, deferred: false, dataUrl: '', chunkProgress: 0, size: 4096 },
                    original: { mediaId: 'k3c-original-x',  complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 16384 },
                },
                extraPhotosVariants: [],
                meta: { expected_media: 3 },
            });
        }, { cid, reportId, photoGroupId, mediumMediaId, legacyUrl: TINY_PNG_DATAURL });

        // Build the upload work unit (mirrors _buildVariantWork shape).
        const items = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const item = items.find((q: any) => q.client_report_id === cid);
        expect(item).toBeDefined();

        const variantBefore = item.photoVariants.medium;
        expect(variantBefore.dataUrl).toBe('');

        await page.evaluate(async ({ item, reportId }) => {
            const unit = {
                tier: 'medium',
                groupId: item.photoGroupId,
                variant: item.photoVariants.medium,
                label: 'main/medium',
                clientBlurApplied: item.photoVariants.clientBlurApplied,
            };
            await (window as any).__crispUploadVariantTier(item, reportId, unit);
        }, { item, reportId });

        // The variant should NOT have been left orphan-deferred.
        const itemsAfter = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const refreshed = itemsAfter.find((q: any) => q.client_report_id === cid);
        expect(refreshed).toBeDefined();
        const m = refreshed.photoVariants.medium;
        expect(m.deferred, 'recovery succeeded; variant should NOT be deferred').toBeFalsy();
        // After recovery, the dataUrl was persisted then the upload ran.
        expect(typeof m.dataUrl).toBe('string');
        // Cleanup.
        await page.evaluate((c) => (window as any).__crispDequeueReport(c), cid);
    });

    test('missing dataUrl with no legacy source marks orphan_no_source', async ({ page }) => {
        const cid = 'k3c-cid-orphan-no-source';
        const reportId = 'k3c-server-report-orphan';
        const photoGroupId = 'k3c-grp-orphan';
        const originalMediaId = 'k3c-orig-orphan';

        await page.route(/\/api\/v1\/reports\/upload-probe$/, (route) =>
            route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ ok: true }) }));

        await bootPwa(page);

        // No item.photo, no extraPhotos — there's NO legacy source at all.
        // Phase L (May 2026): canonical variant key is `original`.
        await page.evaluate(async ({ cid, reportId, photoGroupId, originalMediaId }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId,
                photo: null,
                photoVariants: {
                    clientBlurApplied: true,
                    small:    { mediaId: 'k3c-sm-orphan', complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 1024 },
                    medium:   { mediaId: 'k3c-md-orphan', complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 4096 },
                    original: { mediaId: originalMediaId, complete: false, deferred: false, dataUrl: '', chunkProgress: 0, size: 16384 },
                },
                extraPhotosVariants: [],
                meta: { expected_media: 3 },
            });
        }, { cid, reportId, photoGroupId, originalMediaId });

        const items = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const item = items.find((q: any) => q.client_report_id === cid);

        await page.evaluate(async ({ item, reportId }) => {
            const unit = {
                tier: 'original',
                groupId: item.photoGroupId,
                variant: item.photoVariants.original,
                label: 'main/original',
                clientBlurApplied: item.photoVariants.clientBlurApplied,
            };
            await (window as any).__crispUploadVariantTier(item, reportId, unit);
        }, { item, reportId });

        const itemsAfter = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const refreshed = itemsAfter.find((q: any) => q.client_report_id === cid);
        const orig = refreshed.photoVariants.original;
        expect(orig.deferred, 'no source means variant must be marked deferred').toBe(true);
        expect(orig.deferredReason).toBe('orphan_no_source');
        expect(typeof orig.deferredAt).toBe('number');

        // Cleanup.
        await page.evaluate((c) => (window as any).__crispDequeueReport(c), cid);
    });

    test('extras: missing dataUrl is recovered from item.extraPhotos[i]', async ({ page }) => {
        const cid = 'k3c-cid-extra-recover';
        const reportId = 'k3c-server-extra-recover';
        const extraGroupId = 'k3c-grp-extra';
        const mediumMediaId = 'k3c-med-extra';

        await page.route(/\/api\/v1\/reports\/upload-probe$/, (route) =>
            route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ ok: true }) }));
        await page.route(/\/api\/v1\/reports\/[^/]+\/media\/chunk-bin$/, (route) =>
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    media_id: mediumMediaId, seq_num: 0,
                    received: 1, total: 1, completion_pct: 100,
                    assembly_status: 'pending',
                }),
            }));

        await bootPwa(page);

        await page.evaluate(async ({ cid, reportId, extraGroupId, mediumMediaId, legacyUrl }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: 'main-not-used',
                photo: null,
                photoVariants: null,
                extraPhotos: [legacyUrl],
                extraPhotosVariants: [
                    {
                        groupId: extraGroupId,
                        clientBlurApplied: true,
                        // Phase L: variant key is `original`, was `large`.
                        small:    { mediaId: 'k3c-extra-sm',   complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 1024 },
                        medium:   { mediaId: mediumMediaId,    complete: false, deferred: false, dataUrl: '', chunkProgress: 0, size: 4096 },
                        original: { mediaId: 'k3c-extra-orig', complete: true,  deferred: false, dataUrl: '', chunkProgress: 0, size: 16384 },
                    },
                ],
                meta: { expected_media: 3 },
            });
        }, { cid, reportId, extraGroupId, mediumMediaId, legacyUrl: TINY_PNG_DATAURL });

        const items = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const item = items.find((q: any) => q.client_report_id === cid);

        await page.evaluate(async ({ item, reportId, extraGroupId }) => {
            const ev = item.extraPhotosVariants[0];
            const unit = {
                tier: 'medium',
                groupId: extraGroupId,
                variant: ev.medium,
                label: 'extra[0]/medium',
                clientBlurApplied: ev.clientBlurApplied,
            };
            await (window as any).__crispUploadVariantTier(item, reportId, unit);
        }, { item, reportId, extraGroupId });

        const itemsAfter = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const refreshed = itemsAfter.find((q: any) => q.client_report_id === cid);
        const m = refreshed.extraPhotosVariants[0].medium;
        expect(m.deferred, 'extra recovery succeeded; variant should NOT be deferred').toBeFalsy();
        expect(typeof m.dataUrl).toBe('string');
        await page.evaluate((c) => (window as any).__crispDequeueReport(c), cid);
    });
});
