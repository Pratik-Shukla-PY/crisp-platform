/**
 * PWA — wedge-recovery must NOT false-fire while offline (reconnect double-upload fix).
 *
 * Bug (found on a real iPhone, airplane-mode test): the retry-loop's
 * wedge-recovery decided "loop is wedged" off `_lastChunkPostAt` (last
 * SUCCESSFUL chunk POST). An offline stretch >60s lands zero successful POSTs,
 * so on reconnect a trigger (online/heartbeat) fired the wedge, cleared the
 * concurrency guards (`_retryLoopRunning`, drain lock, `_inFlightReports`), and
 * a SECOND drain pass ran concurrently with the first — re-uploading in-progress
 * tiers from chunk 0 (idempotent on the backend → no data loss / no dupe rows,
 * but ~2x bandwidth on exactly the bad networks where it's scarcest).
 *
 * Fix: the wedge clock is now a LIVENESS signal (`_lastDrainTickAt`, stamped on
 * every loop iteration + per-item + successful POST), the loop offline-SKIPS
 * doomed work (staying alive + ticking), and the wedge requires `navigator.onLine`.
 * Offline ⇒ loop alive ⇒ not wedged. A genuinely frozen loop (iOS killed an
 * awaited fetch while ONLINE) still goes stale and is still recovered.
 *
 * Verifies (per the requirement): no duplicate chunk uploads, no duplicate media
 * rows, resume-from-offset preserved — across airplane-30s, offline-90s,
 * browser/device restart, and network reconnect.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { FIXTURES_DIR, pgReportTruth, pollUntil, cleanupReport, PG_DSN } from './_validation-harness';

// ───────────────────────────────────────────────────────────────────────────
// Block A — wedge DECISION (pure function, deterministic). Covers all 5
// scenarios at the decision layer: the exact thing the bug got wrong.
// ───────────────────────────────────────────────────────────────────────────
test.describe('wedge-recovery decision — offline never false-wedges', () => {
    async function boot(page) {
        await page.addInitScript(() => { (window as any).__crispSuppressAutoDrain = true; });
        await page.goto('index.html');
        await page.waitForFunction(() => typeof (window as any).__crispIsLoopWedged === 'function', null, { timeout: 8000 });
    }
    const decide = (page, a) => page.evaluate((args) => (window as any).__crispIsLoopWedged(args), a);
    const NOW = 1_000_000_000_000;
    const TH = 60_000;

    test('airplane mode 30s (offline, 30s stale) → NOT wedged', async ({ page }) => {
        await boot(page);
        expect(await decide(page, { running: true, lastTickAt: NOW - 30_000, now: NOW, online: false, hasPending: true, thresholdMs: TH })).toBe(false);
    });
    test('offline 90s (offline, 90s stale) → NOT wedged (the fix)', async ({ page }) => {
        await boot(page);
        expect(await decide(page, { running: true, lastTickAt: NOW - 90_000, now: NOW, online: false, hasPending: true, thresholdMs: TH })).toBe(false);
    });
    test('GENUINE wedge (online, frozen 90s, pending) → IS recovered (preserved)', async ({ page }) => {
        await boot(page);
        expect(await decide(page, { running: true, lastTickAt: NOW - 90_000, now: NOW, online: true, hasPending: true, thresholdMs: TH })).toBe(true);
    });
    test('network reconnect (online, loop ticked 2s ago) → NOT wedged (loop alive)', async ({ page }) => {
        await boot(page);
        expect(await decide(page, { running: true, lastTickAt: NOW - 2_000, now: NOW, online: true, hasPending: true, thresholdMs: TH })).toBe(false);
    });
    test('browser/device restart (loop not running) → NOT wedged (fresh start path)', async ({ page }) => {
        await boot(page);
        // Even with an ancient clock, a not-running loop is never "wedged" — a
        // fresh process (restart) has _retryLoopRunning=false and starts normally.
        expect(await decide(page, { running: false, lastTickAt: 0, now: NOW, online: true, hasPending: true, thresholdMs: TH })).toBe(false);
    });
    test('online + stale but empty queue → NOT wedged (nothing to recover)', async ({ page }) => {
        await boot(page);
        expect(await decide(page, { running: true, lastTickAt: NOW - 90_000, now: NOW, online: true, hasPending: false, thresholdMs: TH })).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Block B — resume-from-offset + no duplicate chunk uploads (deterministic).
// A tier interrupted mid-upload (offline) resumes from its persisted
// chunkProgress and never re-sends already-delivered chunks.
// ───────────────────────────────────────────────────────────────────────────
test.describe('resume-from-offset — no re-send of delivered chunks', () => {
    test('ORIGINAL resumes from chunkProgress, never re-POSTs earlier seqs', async ({ page }) => {
        const cid = 'wedge-resume-cid';
        const reportId = 'wedge-resume-report';
        const mediaId = 'wedge-resume-orig';
        const RESUME_FROM = 2;

        const posts: Array<{ seq: number }> = [];
        await page.route(/\/api\/v1\/reports\/upload-probe$/, (r) =>
            r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
        await page.route(/\/api\/v1\/reports\/[^/]+\/media\/chunk-bin$/, async (route) => {
            let seq = -1;
            try { seq = parseInt((route.request().postData()?.match(/name="seq_num"\r?\n\r?\n([0-9]+)/) || [])[1] ?? '-1', 10); } catch (_) {}
            posts.push({ seq });
            await route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ media_id: mediaId, seq_num: seq, received: seq + 1, total: 99, completion_pct: 100, assembly_status: 'pending' }) });
        });

        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            (window as any).__crispSuppressAutoDrain = true;   // drive the tier explicitly
        });
        await page.goto('index.html');
        await page.waitForFunction(() => typeof (window as any).__crispUploadVariantTier === 'function', null, { timeout: 8000 });

        const out = await page.evaluate(async ({ cid, reportId, mediaId, RESUME_FROM }) => {
            // ~2 MB original ⇒ several chunks at any probe tier. chunkProgress preset
            // to RESUME_FROM simulates "2 chunks already delivered before going offline".
            const bytes = new Uint8Array(2 * 1024 * 1024);
            for (let i = 0; i < bytes.length; i += 977) bytes[i] = i & 0xff;
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            await (window as any).__crispEnqueueReport({
                client_report_id: cid, serverId: reportId,
                stages: { meta: true, text: true, photo: false, audio: true },
                photoGroupId: 'wedge-resume-grp', photo: null,
                photoVariants: {
                    clientBlurApplied: true,
                    small:  { mediaId: 'wr-s', complete: true, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 1024 },
                    medium: { mediaId: 'wr-m', complete: true, deferred: false, dataUrl: 'data:image/jpeg;base64,/9j/', chunkProgress: 0, size: 4096 },
                    original: { mediaId, complete: false, deferred: false, dataUrl: null, blob, chunkProgress: RESUME_FROM, size: bytes.length },
                },
                extraPhotos: [], extraPhotosVariants: [], meta: { expected_media: 3 },
            });
            const item = (await (window as any).__crispGetAllQueued()).find((q: any) => q.client_report_id === cid);
            const unit = { tier: 'original', groupId: item.photoGroupId, variant: item.photoVariants.original, label: 'main/original', clientBlurApplied: true };
            await (window as any).__crispUploadVariantTier(item, reportId, unit);
            const after = (await (window as any).__crispGetAllQueued()).find((q: any) => q.client_report_id === cid);
            await (window as any).__crispDequeueReport(cid);
            return { complete: !!after.photoVariants.original.complete, chunkProgress: after.photoVariants.original.chunkProgress };
        }, { cid, reportId, mediaId, RESUME_FROM });

        const seqs = posts.map(p => p.seq);
        // RESUME-FROM-OFFSET: nothing below the resume offset was re-sent.
        expect(Math.min(...seqs), 'no chunk below the resume offset was re-POSTed').toBeGreaterThanOrEqual(RESUME_FROM);
        // NO DUPLICATE CHUNK UPLOADS: each seq POSTed exactly once.
        expect(new Set(seqs).size, 'every chunk POSTed exactly once').toBe(seqs.length);
        expect(out.complete, 'tier completed after resume').toBe(true);
        expect(seqs.length, 'resume actually uploaded the remaining chunks').toBeGreaterThan(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Block C — end-to-end: offline >60s → reconnect, against the REAL backend.
// Proves no duplicate chunk uploads + no duplicate media rows on a genuine
// >wedge-threshold offline gap (the exact on-device scenario).
// ───────────────────────────────────────────────────────────────────────────
test.describe('offline >60s → reconnect (real backend) — no double upload', () => {
    const FIXTURE = { name: 'IMG_5832', file: 'IMG_5832.jpg', lat: 25.16453, lng: 82.50972 };
    const DEVICE_HASH = 'PWA-wedge-offline-reconnect';

    test(`${FIXTURE.name}: 75s offline → reconnect → SYNCED, each chunk once, no dupe rows`, async ({ page }) => {
        test.setTimeout(240_000);

        // Count chunk-bin POSTs per (media_id, seq) but FORWARD to the real backend.
        const seen = new Map<string, number>();
        await page.route(/\/api\/v1\/reports\/[^/]+\/media\/chunk-bin$/, async (route) => {
            try {
                const b = route.request().postData() || '';
                const mid = (b.match(/name="media_id"\r?\n\r?\n([^\r\n]+)/) || [])[1];
                const seq = (b.match(/name="seq_num"\r?\n\r?\n([0-9]+)/) || [])[1];
                if (mid && seq != null) { const k = `${mid}:${seq}`; seen.set(k, (seen.get(k) || 0) + 1); }
            } catch (_) {}
            await route.continue();
        });

        await page.addInitScript((h) => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_device_id_v2', h);
        }, DEVICE_HASH);
        await page.goto('index.html');
        await page.waitForFunction(
            () => typeof (window as any).__crispIngestFile === 'function'
                && typeof (window as any).__crispSubmitReport === 'function'
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 15_000 });

        // Capture + classify + submit while ONLINE-ingested, then go offline before drain.
        const fixtureBytes = fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE.file));
        await page.evaluate(async ({ bytes, name }) => {
            const file = new File([new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })], name, { type: 'image/jpeg' });
            await (window as any).__crispIngestFile(file);
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const s = (window as any).state;
                if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) return;
                await new Promise(r => setTimeout(r, 250));
            }
        }, { bytes: Array.from(fixtureBytes), name: FIXTURE.file });
        await page.evaluate(({ lat, lng }) => {
            const s = (window as any).state;
            s.crisis_type = 'FLOOD'; s.infrastructure_type = 'RESIDENTIAL'; s.damage_classification = 'PARTIAL'; s.severity = 'MODERATE';
            s.description = 'Wedge offline-reconnect regression'; s.location = { lat, lng, acc: 5 }; s.locationName = 'Wedge test';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        // Go offline, submit (queues locally), and keep a drain pass alive so the
        // offline window is what the wedge would (wrongly) react to on reconnect.
        await page.context().setOffline(true);
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
        await page.evaluate(() => { try { (window as any).__crispStartRetryLoop(); } catch (_) {} });
        const cid = await page.evaluate(async (h) => {
            const all = await (window as any).__crispGetAllQueued();
            return all.find((q: any) => q.meta?.device_hash === h)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid, 'report queued offline').toBeTruthy();

        // Stay offline > the 60s wedge threshold (the bug trigger).
        await page.waitForTimeout(75_000);

        // Reconnect — fire the same triggers a real device would.
        await page.context().setOffline(false);
        await page.evaluate(() => { window.dispatchEvent(new Event('online')); });

        const truth = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null && t.media_count >= 3
                && t.media.every(m => m.assembly_status === 'complete') && t.sync_status === 'SYNCED',
            { timeoutMs: 150_000, intervalMs: 2000 });

        // SYNCED with every tier complete.
        expect(truth.sync_status).toBe('SYNCED');
        expect(truth.media_count).toBeGreaterThanOrEqual(3);
        expect(truth.media.every(m => m.assembly_status === 'complete')).toBe(true);

        // NO DUPLICATE CHUNK UPLOADS — every (media,seq) POSTed exactly once.
        const dupChunks = [...seen.entries()].filter(([, n]) => n > 1);
        expect(dupChunks, `chunks POSTed more than once (double-pass): ${JSON.stringify(dupChunks)}`).toEqual([]);

        // NO DUPLICATE MEDIA ROWS.
        const dupRows = execSync(
            `psql "${PG_DSN}" -A -t -F'|' -c "SELECT resolution_tier, COALESCE(photo_group_id,''), COUNT(*) ` +
            `FROM media WHERE report_id='${truth.report_id}' GROUP BY resolution_tier, photo_group_id HAVING COUNT(*)>1"`,
            { encoding: 'utf8' }).trim();
        expect(dupRows, `duplicate media rows: ${dupRows}`).toBe('');

        cleanupReport(cid!);
    });
});
