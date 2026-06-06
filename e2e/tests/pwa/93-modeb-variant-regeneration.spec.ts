/**
 * PWA — Mode B fix: drain-time tier regeneration from a retained source blob.
 *
 * Mode B = a photo enqueued with NULL variants because its async
 * ImageVariants.generate() didn't finish within the submit budget (500 ms
 * blur-wait + 1500 ms reattempt, shared + sequential across all photos). Such a
 * photo used to deliver only via the legacy untiered path — or, in a MIXED
 * multi-photo report, be DROPPED ENTIRELY (the drain dispatch is
 * `if (workUnits) … else if (item.photo)`, so the legacy branch is skipped when
 * any sibling photo has variants → the null-variant photo's bytes, held only in
 * item.extraPhotos[i], are uploaded by no path).
 *
 * Fix: the submit retains each null-variant photo's full-res source blob on the
 * queue row (item.photoSourceBlob / item.extraSourceBlobs[i]); the drain calls
 * _regenerateMissingVariants() BEFORE _buildVariantWork to regenerate full
 * SMALL/MEDIUM/ORIGINAL tiers from those blobs. After regeneration no
 * null-variant photo with a source blob remains, so the mixed-drop is closed and
 * the photo delivers full-tier (ORIGINAL kept as a Blob, per the OOM fix).
 *
 * These specs drive the real window.__crispRegenerateMissingVariants surface.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-MODEB-REGEN';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
        // Isolation: drive the queue manually; suppress the background auto-drain
        // so it can't dequeue rows under assertion (read-after-enqueue flake fix).
        (window as any).__crispSuppressAutoDrain = true;
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispRegenerateMissingVariants === 'function'
            && typeof (window as any).ImageVariants?.generate === 'function',
        null, { timeout: 10000 },
    );
}

// Build a real, decodable JPEG Blob in-browser (ImageVariants.generate needs to
// decode + blur + resize it). Returns the Blob via a window global.
const MAKE_JPEG = `(async () => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a6ea5'; ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = '#c0d6e4'; ctx.fillRect(20, 20, 56, 56);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
})()`;

test.describe('PWA Mode B — drain-time tier regeneration', () => {
    test('MIXED report: a null-variant extra is regenerated (not dropped)', async ({ page }) => {
        const cid = 'modeb-cid-mixed';
        const reportId = 'modeb-server-mixed';
        await bootPwa(page);

        const r = await page.evaluate(async ({ cid, reportId, MAKE_JPEG }) => {
            const srcBlob = await eval(MAKE_JPEG);   // real decodable JPEG
            // MIXED report: main photo HAS variants; extra[0] is Mode B
            // (null variants + a retained source blob). Pre-fix, the drain's
            // `else if (item.photo)` legacy branch is skipped because main has
            // variants → extra[0] would upload via NO path (silent drop).
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: 'modeb-grp-main',
                photo: 'data:image/jpeg;base64,/9j/main-preview',
                photoVariants: {
                    clientBlurApplied: true,
                    small:    { mediaId: 'modeb-main-s', complete: false, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/s', chunkProgress: 0, size: 1024 },
                    medium:   { mediaId: 'modeb-main-m', complete: false, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/m', chunkProgress: 0, size: 4096 },
                    original: { mediaId: 'modeb-main-o', complete: false, deferred: false, dataUrl: null, blob: srcBlob, chunkProgress: 0, size: srcBlob.size },
                },
                photoSourceBlob: null,                 // main already has variants
                extraPhotos: ['data:image/jpeg;base64,/9j/extra0-preview'],
                extraPhotosVariants: [null],           // <-- Mode B: extra[0] has NO variants
                extraSourceBlobs: [srcBlob],           // <-- but its source blob was retained
                meta: { expected_media: 4 },
            });

            // Drive the drain-time regeneration (what trySendQueuedReport runs
            // before _buildVariantWork).
            const all0 = await (window as any).__crispGetAllQueued();
            const item = all0.find((q: any) => q.client_report_id === cid);
            const changed = await (window as any).__crispRegenerateMissingVariants(item);

            // Re-read from IDB to prove the regenerated structure persisted.
            const all1 = await (window as any).__crispGetAllQueued();
            const it = all1.find((q: any) => q.client_report_id === cid);
            const ev = it.extraPhotosVariants[0];
            const out = {
                changed: !!changed,
                extraNowHasVariants: !!(ev && ev.small),
                smallIsDataUrl: !!(ev && typeof ev.small.dataUrl === 'string' && ev.small.dataUrl.length > 0),
                mediumIsDataUrl: !!(ev && typeof ev.medium.dataUrl === 'string' && ev.medium.dataUrl.length > 0),
                originalIsBlob: !!(ev && ev.original.blob instanceof Blob && ev.original.blob.size > 0),
                originalDataUrlNull: !!(ev && (ev.original.dataUrl == null)),
                hasGroupId: !!(ev && typeof ev.groupId === 'string'),
                distinctMediaIds: ev ? new Set([ev.small.mediaId, ev.medium.mediaId, ev.original.mediaId]).size : 0,
                sourceBlobCleared: it.extraSourceBlobs[0] == null,
            };
            await (window as any).__crispDequeueReport(cid);
            return out;
        }, { cid, reportId, MAKE_JPEG });

        expect(r.changed, 'regeneration reported a change').toBe(true);
        expect(r.extraNowHasVariants, 'extra[0] now has a full variant set (was null → no longer dropped)').toBe(true);
        expect(r.smallIsDataUrl, 'extra[0] SMALL is a base64 dataUrl').toBe(true);
        expect(r.mediumIsDataUrl, 'extra[0] MEDIUM is a base64 dataUrl').toBe(true);
        expect(r.originalIsBlob, 'extra[0] ORIGINAL retained as a Blob (OOM-safe)').toBe(true);
        expect(r.originalDataUrlNull, 'extra[0] ORIGINAL is NOT base64-encoded').toBe(true);
        expect(r.hasGroupId, 'extra[0] got a photo group id').toBe(true);
        expect(r.distinctMediaIds, 'extra[0] tiers have distinct media ids').toBe(3);
        expect(r.sourceBlobCleared, 'source blob reclaimed after regeneration').toBe(true);
    });

    test('ALL-NULL report: a null-variant MAIN photo is regenerated', async ({ page }) => {
        const cid = 'modeb-cid-main';
        const reportId = 'modeb-server-main';
        await bootPwa(page);

        const r = await page.evaluate(async ({ cid, reportId, MAKE_JPEG }) => {
            const srcBlob = await eval(MAKE_JPEG);
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: null,                    // not yet assigned (Mode B)
                photo: 'data:image/jpeg;base64,/9j/main-preview',
                photoVariants: null,                   // <-- Mode B main
                photoSourceBlob: srcBlob,              // <-- source retained
                extraPhotos: [],
                extraPhotosVariants: [],
                extraSourceBlobs: [],
                meta: { expected_media: 3 },
            });
            const all0 = await (window as any).__crispGetAllQueued();
            const item = all0.find((q: any) => q.client_report_id === cid);
            const changed = await (window as any).__crispRegenerateMissingVariants(item);
            const all1 = await (window as any).__crispGetAllQueued();
            const it = all1.find((q: any) => q.client_report_id === cid);
            const pv = it.photoVariants;
            const out = {
                changed: !!changed,
                mainHasVariants: !!(pv && pv.small),
                groupIdAssigned: typeof it.photoGroupId === 'string' && it.photoGroupId.length > 0,
                originalIsBlob: !!(pv && pv.original.blob instanceof Blob),
                sourceCleared: it.photoSourceBlob == null,
            };
            await (window as any).__crispDequeueReport(cid);
            return out;
        }, { cid, reportId, MAKE_JPEG });

        expect(r.changed).toBe(true);
        expect(r.mainHasVariants, 'main photo regenerated to a full variant set').toBe(true);
        expect(r.groupIdAssigned, 'main photo group id assigned').toBe(true);
        expect(r.originalIsBlob, 'main ORIGINAL retained as a Blob').toBe(true);
        expect(r.sourceCleared, 'main source blob reclaimed').toBe(true);
    });

    test('no-op when every photo already has variants (idempotent)', async ({ page }) => {
        const cid = 'modeb-cid-noop';
        await bootPwa(page);
        const r = await page.evaluate(async ({ cid }) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: 'modeb-server-noop',
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: 'modeb-grp-noop',
                photo: null,
                photoVariants: {
                    clientBlurApplied: true,
                    small:    { mediaId: 'noop-s', complete: false, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/s', chunkProgress: 0, size: 1024 },
                    medium:   { mediaId: 'noop-m', complete: false, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/m', chunkProgress: 0, size: 4096 },
                    original: { mediaId: 'noop-o', complete: false, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/o', chunkProgress: 0, size: 16384 },
                },
                photoSourceBlob: null,
                extraPhotos: [],
                extraPhotosVariants: [],
                extraSourceBlobs: [],
                meta: { expected_media: 3 },
            });
            const all0 = await (window as any).__crispGetAllQueued();
            const item = all0.find((q: any) => q.client_report_id === cid);
            const changed = await (window as any).__crispRegenerateMissingVariants(item);
            await (window as any).__crispDequeueReport(cid);
            return { changed: !!changed };
        }, { cid });
        expect(r.changed, 'no regeneration when all photos already have variants').toBe(false);
    });
});
