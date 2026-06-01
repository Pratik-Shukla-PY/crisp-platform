/**
 * Validation Scenario 14 — Report-TYPE delivery matrix (Postgres-truth).
 *
 * Closes the certification's Report-Matrix coverage gap: scenarios 01–13 are
 * all single-photo. This spec proves end-to-end DELIVERY (report lands +
 * SYNCED + correct media composition, every image tier servable) for the
 * report compositions the matrix demands:
 *
 *   • text-only          → 0 media, report SYNCED
 *   • audio-only         → 1 AUDIO media, SYNCED
 *   • images ×2 (multi)  → 6 IMAGE media (2 groups × SMALL/MEDIUM/ORIGINAL), SYNCED
 *   • images + audio     → 3 IMAGE + 1 AUDIO media, SYNCED
 *
 * Each runs against the LIVE stack (backend :8000, static :8080) and verifies
 * the Postgres truth via the shared harness — not "API 200".
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES_DIR, pgReportTruth, pollUntil } from './_validation-harness';

const FIXTURE_JPEG = path.join(FIXTURES_DIR, 'IMG_5718.jpg');
const LAT = 12.93488, LNG = 77.61173;

async function bootPwa(page: Page, deviceHash: string) {
    await page.addInitScript((dh) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', dh);   // the key the PWA actually reads
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    }, deviceHash);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispIngestFile === 'function'
            && typeof (window as any).__crispSubmitReport === 'function'
            && typeof (window as any).__crispGetAllQueued === 'function',
        null, { timeout: 15_000 },
    );
}

// Ingest one JPEG through the real variant pipeline; asExtra appends to extras.
async function ingestImage(page: Page, asExtra: boolean) {
    const bytes = Array.from(fs.readFileSync(FIXTURE_JPEG));
    const ok = await page.evaluate(async ({ b, asExtra }) => {
        const file = new File([new Blob([new Uint8Array(b)], { type: 'image/jpeg' })], 'IMG_5718.jpg', { type: 'image/jpeg' });
        await (window as any).__crispIngestFile(file, { asExtra });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const s = (window as any).state;
            if (!asExtra) {
                if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) return true;
            } else {
                // Extras store their generated variants on state.extraPhotos[i].variants
                // (submit maps them to extraPhotosVariants). Wait for that.
                const ep = s.extraPhotos || [];
                const last = ep[ep.length - 1];
                if (ep.length > 0 && last?.variants?.small && last?.variants?.original) return true;
            }
            await new Promise(r => setTimeout(r, 250));
        }
        return false;
    }, { b: bytes, asExtra });
    expect(ok, `variant pipeline never populated (asExtra=${asExtra})`).toBe(true);
}

// Inject classifier + location (+ optional synthetic audio) then submit.
async function injectAndSubmit(page: Page, opts: { withAudio?: boolean; description: string }) {
    await page.evaluate(({ lat, lng, withAudio, description }) => {
        const s = (window as any).state;
        s.crisis_type = 'EARTHQUAKE';
        s.infrastructure_type = 'COMMERCIAL';
        s.damage_classification = 'PARTIAL';
        s.severity = 'MODERATE';
        s.description = description;
        s.location = { lat, lng, acc: 5 };
        s.locationName = 'Report-type test point';
        if (withAudio) {
            // Synthetic audio payload — the chunk/assembly path is
            // format-agnostic (it concatenates + stores bytes), so a dummy
            // blob is sufficient to prove an AUDIO media row lands.
            const buf = new Uint8Array(4096); for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
            s.audioBlob = new Blob([buf], { type: 'audio/webm' });
        }
    }, { lat: LAT, lng: LNG, withAudio: !!opts.withAudio, description: opts.description });

    await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });

    const cid = await page.evaluate(async () => {
        const all = await (window as any).__crispGetAllQueued();
        if (!all || all.length === 0) return null;
        // Fresh per-test IDB context → the just-submitted report is the newest
        // (and typically only) queued item.
        const sorted = all.slice().sort((a: any, b: any) =>
            String(b.meta?.client_created_at || b.timestamp || '').localeCompare(
                String(a.meta?.client_created_at || a.timestamp || '')));
        return sorted[0]?.client_report_id || null;
    });
    expect(cid, 'PWA never enqueued a queue item').toBeTruthy();
    return cid!;
}

// Poll Postgres until the report lands SYNCED with the expected media counts.
async function awaitSynced(cid: string, expImage: number, expAudio: number) {
    const expTotal = expImage + expAudio;
    const truth = await pollUntil(
        () => pgReportTruth(cid),
        (t) => t.report_id !== null
            && t.media_count >= expTotal
            && t.media.filter(m => m.type === 'IMAGE').length >= expImage
            && t.media.filter(m => m.type === 'AUDIO').length >= expAudio
            && t.media.every(m => m.assembly_status === 'complete')
            && t.sync_status === 'SYNCED',
        { timeoutMs: 90_000, intervalMs: 1500 },
    );
    expect(truth.report_id, 'report never reached Postgres').toBeTruthy();
    expect(truth.sync_status, 'sync_status not SYNCED').toBe('SYNCED');
    expect(truth.media.filter(m => m.type === 'IMAGE').length, 'IMAGE media count').toBe(expImage);
    expect(truth.media.filter(m => m.type === 'AUDIO').length, 'AUDIO media count').toBe(expAudio);
    for (const m of truth.media) {
        expect(m.assembly_status, `${m.resolution_tier}/${m.type} not complete`).toBe('complete');
        expect(m.url, `${m.resolution_tier}/${m.type} url empty`).toBeTruthy();
    }
    return truth;
}

// Prove every IMAGE tier's bytes are servable (425 blur-gate is transient).
async function assertTiersServable(page: Page, truth: any) {
    for (const m of truth.media.filter((x: any) => x.type === 'IMAGE')) {
        const url = `http://localhost:8000/api/v1/reports/media/${m.id}/file`;
        const t0 = Date.now();
        let res = await page.request.get(url, { maxRedirects: 5 });
        while (res.status() === 425 && Date.now() - t0 < 60_000) {
            await page.waitForTimeout(1000);
            res = await page.request.get(url, { maxRedirects: 5 });
        }
        const body = await res.body();
        expect(res.status(), `${m.resolution_tier} servable`).toBeLessThan(400);
        expect(body.length, `${m.resolution_tier} bytes`).toBeGreaterThan(100);
    }
}

test.describe('VALIDATION 14 — report-type delivery matrix', () => {

    test('text-only → report lands SYNCED with zero media', async ({ page }) => {
        await bootPwa(page, 'PWA-rtype-textonly-14');
        const cid = await injectAndSubmit(page, { description: 'Text-only report — road blocked near the market, no photo available.' });
        await awaitSynced(cid, 0, 0);
    });

    test('audio-only → 1 AUDIO media lands SYNCED', async ({ page }) => {
        await bootPwa(page, 'PWA-rtype-audioonly-14');
        const cid = await injectAndSubmit(page, { withAudio: true, description: 'Audio-only report.' });
        await awaitSynced(cid, 0, 1);
    });

    test('images ×2 (multi-image) → 6 IMAGE media land SYNCED + all tiers servable', async ({ page }) => {
        await bootPwa(page, 'PWA-rtype-multi2-14');
        await ingestImage(page, false);  // primary
        await ingestImage(page, true);   // extra
        const cid = await injectAndSubmit(page, { description: 'Two-photo report.' });
        const truth = await awaitSynced(cid, 6, 0);
        await assertTiersServable(page, truth);
    });

    test('images + audio → 3 IMAGE + 1 AUDIO land SYNCED + tiers servable', async ({ page }) => {
        await bootPwa(page, 'PWA-rtype-imgaudio-14');
        await ingestImage(page, false);
        const cid = await injectAndSubmit(page, { withAudio: true, description: 'Photo + voice note report.' });
        const truth = await awaitSynced(cid, 3, 1);
        await assertTiersServable(page, truth);
    });
});
