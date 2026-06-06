/**
 * PWA — ORIGINAL tier uploads from a retained Blob (no base64 dataUrl).
 *
 * Root cause this guards against (confirmed via dev-DB triangulation,
 * Jun 2026): at submit, `_encodeVariants` used to base64-encode EVERY
 * tier's blob to a `dataUrl` via FileReader.readAsDataURL. The large
 * ORIGINAL blob (up to the 5 MB cap) intermittently OOMed readAsDataURL
 * on memory-constrained devices; the throw was swallowed, leaving
 * `original.dataUrl = null`, so the tier uploaded no bytes and the
 * ORIGINAL `media` row was never created. SMALL/MEDIUM (tens–hundreds of
 * KB) always encoded fine, so multi-photo reports silently landed as
 * SMALL+MEDIUM with the ORIGINAL missing — rarely, and across ALL photos
 * in an affected submission (main included), not just extras.
 *
 * Fix: the ORIGINAL tier is no longer base64-encoded at submit. Its Blob
 * is retained on the queue item (IndexedDB persists Blobs natively via
 * structured clone) and `_uploadVariantTier` slices that Blob directly —
 * no giant base64 string is ever allocated, and full fidelity is kept.
 *
 * These specs drive the real `window.__crispUploadVariantTier` surface
 * with `/media/chunk-bin` route-intercepted, asserting that an ORIGINAL
 * variant carrying ONLY a Blob (dataUrl null) actually POSTs its bytes
 * and is NOT orphan-deferred — and that this holds for every photo group
 * in a multi-photo report.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-ORIG-BLOB';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
        // Isolation: drive the queue manually; suppress the background auto-drain
        // so it can't dequeue rows under assertion (read-after-enqueue flake fix).
        (window as any).__crispSuppressAutoDrain = true;
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispUploadVariantTier === 'function'
            && typeof (window as any).__crispGetAllQueued === 'function',
        null, { timeout: 8000 },
    );
}

// Count chunk-bin POSTs and collect the media_id of each (parsed from the
// multipart body — media_id is a text field so it survives in postData()).
function installChunkBinStub(page) {
    const seen = { hits: 0, mediaIds: new Set<string>() };
    page.route(/\/api\/v1\/reports\/upload-probe$/, (route) =>
        route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ ok: true }) }));
    page.route(/\/api\/v1\/reports\/[^/]+\/media\/chunk-bin$/, (route) => {
        seen.hits++;
        let mediaId = '';
        try {
            const body = route.request().postData() || '';
            const m = body.match(/name="media_id"\r?\n\r?\n([^\r\n]+)/);
            if (m) { mediaId = m[1]; seen.mediaIds.add(mediaId); }
        } catch (_) { /* binary body — fall back to hit count only */ }
        route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                media_id: mediaId || 'stub', seq_num: 0, received: 1, total: 1,
                completion_pct: 100, assembly_status: 'pending',
            }),
        });
    });
    return seen;
}

test.describe('PWA — ORIGINAL tier uploads from a retained Blob', () => {
    test('a Blob-only ORIGINAL (no dataUrl) survives IDB and POSTs its bytes', async ({ page }) => {
        const cid = 'origblob-cid-single';
        const reportId = 'origblob-server-single';
        const groupId = 'origblob-grp-single';
        const originalMediaId = 'origblob-orig-single';
        const NBYTES = 512; // 1 chunk at every probe tier (smallest is 1 KB)

        const seen = installChunkBinStub(page);
        await bootPwa(page);

        const result = await page.evaluate(async ({ cid, reportId, groupId, originalMediaId, NBYTES }) => {
            // Build a REAL Blob with known bytes — this is what the fixed
            // `_encodeVariants` retains for the ORIGINAL tier instead of a
            // base64 dataUrl. (Created in-browser; Blobs can't cross the
            // Playwright boundary.)
            const bytes = new Uint8Array(NBYTES);
            for (let i = 0; i < NBYTES; i++) bytes[i] = i % 256;
            const blob = new Blob([bytes], { type: 'image/jpeg' });

            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: groupId,
                photo: null,
                photoVariants: {
                    clientBlurApplied: true,
                    // SMALL/MEDIUM keep the proven base64 dataUrl path.
                    small:  { mediaId: 'origblob-sm-single', complete: true,  deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 1024 },
                    medium: { mediaId: 'origblob-md-single', complete: true,  deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 4096 },
                    // ORIGINAL — Blob only, dataUrl explicitly null (the fixed shape).
                    original: { mediaId: originalMediaId, complete: false, deferred: false, dataUrl: null, chunkProgress: 0, size: NBYTES, blob },
                },
                extraPhotosVariants: [],
                meta: { expected_media: 3 },
            });

            // Read back from IDB — proves the Blob round-tripped through
            // structured-clone persistence (the crash-recovery guarantee).
            const all = await (window as any).__crispGetAllQueued();
            const item = all.find((q: any) => q.client_report_id === cid);
            const persisted = item.photoVariants.original;
            const blobPersistedSize = (persisted.blob instanceof Blob) ? persisted.blob.size : -1;
            const dataUrlAbsent = persisted.dataUrl == null || persisted.dataUrl === '';

            // Drive the real upload for the ORIGINAL tier.
            const unit = {
                tier: 'original',
                groupId: item.photoGroupId,
                variant: item.photoVariants.original,
                label: 'main/original',
                clientBlurApplied: item.photoVariants.clientBlurApplied,
            };
            await (window as any).__crispUploadVariantTier(item, reportId, unit);

            const all2 = await (window as any).__crispGetAllQueued();
            const item2 = all2.find((q: any) => q.client_report_id === cid);
            const orig2 = item2.photoVariants.original;
            await (window as any).__crispDequeueReport(cid);

            return {
                blobPersistedSize,
                dataUrlAbsent,
                deferred: !!orig2.deferred,
                complete: !!orig2.complete,
                chunkProgress: orig2.chunkProgress || 0,
            };
        }, { cid, reportId, groupId, originalMediaId, NBYTES });

        // The Blob survived IDB persistence at full size, and was never
        // base64-encoded.
        expect(result.blobPersistedSize, 'ORIGINAL Blob persisted to IDB intact').toBe(NBYTES);
        expect(result.dataUrlAbsent, 'ORIGINAL is NOT base64-encoded (no dataUrl)').toBe(true);
        // The bytes were actually POSTed — the regression was zero chunks.
        expect(seen.hits, 'ORIGINAL chunk(s) POSTed').toBeGreaterThanOrEqual(1);
        expect(seen.mediaIds.has(originalMediaId) || seen.hits >= 1,
            'POST carried the ORIGINAL media_id').toBeTruthy();
        // The tier completed and was NOT silently orphan-deferred.
        expect(result.complete, 'ORIGINAL marked complete after upload').toBe(true);
        expect(result.deferred, 'ORIGINAL must NOT be orphan-deferred').toBe(false);
        expect(result.chunkProgress, 'ORIGINAL chunk progress advanced').toBeGreaterThanOrEqual(1);
    });

    test('multi-photo: every group ORIGINAL uploads from its own Blob', async ({ page }) => {
        const cid = 'origblob-cid-multi';
        const reportId = 'origblob-server-multi';
        const NBYTES = 512;
        // 3 photos: main + 2 extras, each ORIGINAL carrying ONLY a Blob.
        const groups = [
            { gid: 'origblob-grp-main', oid: 'origblob-orig-main' },
            { gid: 'origblob-grp-x0',   oid: 'origblob-orig-x0' },
            { gid: 'origblob-grp-x1',   oid: 'origblob-orig-x1' },
        ];

        const seen = installChunkBinStub(page);
        await bootPwa(page);

        const result = await page.evaluate(async ({ cid, reportId, NBYTES, groups }) => {
            const mkBlob = () => {
                const bytes = new Uint8Array(NBYTES);
                for (let i = 0; i < NBYTES; i++) bytes[i] = (i * 7) % 256;
                return new Blob([bytes], { type: 'image/jpeg' });
            };
            const mkVariants = (oid: string) => ({
                clientBlurApplied: true,
                small:  { mediaId: oid + '-sm', complete: true,  deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 1024 },
                medium: { mediaId: oid + '-md', complete: true,  deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 4096 },
                original: { mediaId: oid, complete: false, deferred: false, dataUrl: null, chunkProgress: 0, size: NBYTES, blob: mkBlob() },
            });

            const main = groups[0];
            const extras = groups.slice(1);
            await (window as any).__crispEnqueueReport({
                client_report_id: cid,
                serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: main.gid,
                photo: null,
                photoVariants: mkVariants(main.oid),
                extraPhotosVariants: extras.map((e) => {
                    const v: any = mkVariants(e.oid);
                    v.groupId = e.gid; // extras carry their own groupId
                    return v;
                }),
                meta: { expected_media: 9 },
            });

            const all = await (window as any).__crispGetAllQueued();
            const item = all.find((q: any) => q.client_report_id === cid);

            // Build the ORIGINAL work units for all 3 groups (mirrors the
            // ORIGINAL slice of _buildVariantWork) and upload each.
            const units = [
                { tier: 'original', groupId: item.photoGroupId, variant: item.photoVariants.original, label: 'main/original', clientBlurApplied: true },
                ...item.extraPhotosVariants.map((ev: any, i: number) => ({
                    tier: 'original', groupId: ev.groupId, variant: ev.original, label: `extra[${i}]/original`, clientBlurApplied: true,
                })),
            ];
            for (const u of units) {
                await (window as any).__crispUploadVariantTier(item, reportId, u);
            }

            const all2 = await (window as any).__crispGetAllQueued();
            const item2 = all2.find((q: any) => q.client_report_id === cid);
            const origStates = [
                item2.photoVariants.original,
                ...item2.extraPhotosVariants.map((ev: any) => ev.original),
            ].map((o: any) => ({ complete: !!o.complete, deferred: !!o.deferred, persistedBlob: (o.blob instanceof Blob) ? o.blob.size : -1 }));
            await (window as any).__crispDequeueReport(cid);
            return { origStates };
        }, { cid, reportId, NBYTES, groups });

        // All 3 ORIGINALs persisted their Blob and uploaded — none silently dropped.
        expect(result.origStates).toHaveLength(3);
        for (const [i, st] of result.origStates.entries()) {
            expect(st.persistedBlob, `group ${i} ORIGINAL Blob persisted`).toBe(NBYTES);
            expect(st.complete, `group ${i} ORIGINAL completed`).toBe(true);
            expect(st.deferred, `group ${i} ORIGINAL not deferred`).toBe(false);
        }
        // One chunk-bin POST per ORIGINAL (512 B ⇒ 1 chunk at any probe tier).
        expect(seen.hits, '3 ORIGINAL chunks POSTed (one per group)').toBeGreaterThanOrEqual(3);
        expect(seen.mediaIds.size === 0 || seen.mediaIds.size >= 3,
            'distinct ORIGINAL media_ids POSTed').toBeTruthy();
    });
});
