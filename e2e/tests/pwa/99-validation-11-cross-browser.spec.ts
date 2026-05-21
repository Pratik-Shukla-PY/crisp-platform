/**
 * Validation Scenario 11 — Cross-browser smoke for the PWA upload pipeline.
 *
 * Runs in Chromium (default `pwa` project), Firefox (`pwa-firefox`), and
 * WebKit (`pwa-webkit`). Each engine has different image-codec / canvas
 * behavior, so we explicitly verify the pipeline end-to-end on all three.
 *
 * Pass criteria (per browser):
 *   · ImageVariants.generate produces 3 tier blobs with correct ordering
 *   · Submit lands the report in IDB
 *   · Backend receives + assembles + SYNCED
 *   · Geotag preserved
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5832', file: 'IMG_5832.jpg', lat: 25.16453, lng: 82.50972 };
const SCENARIO = '11-cross-browser';

test.describe('VALIDATION 11 — PWA pipeline works on Chromium/Firefox/WebKit', () => {
    test(`${FIXTURE.name}: capture → variants → upload → SYNCED on this browser`, async ({ page, browserName }) => {
        test.setTimeout(120_000);
        const resultDir = ensureScenarioDir(SCENARIO, `${browserName}-${FIXTURE.name}`);
        const deviceHash = `PWA-validation-crossbrowser-${browserName}-11`;
        const fixturePath = path.join(FIXTURES_DIR, FIXTURE.file);
        expect(fs.existsSync(fixturePath)).toBe(true);

        await page.addInitScript((h) => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_device_id_v2', h);
            localStorage.setItem('crisp_lang', 'en');
        }, deviceHash);
        await page.goto('index.html');
        await page.waitForFunction(
            () => typeof (window as any).__crispIngestFile === 'function'
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 20_000 },  // Firefox is slower to bootstrap
        );

        const fixtureBytes = fs.readFileSync(fixturePath);
        const ingest = await page.evaluate(async ({ bytes, name }) => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            const file = new File([blob], name, { type: 'image/jpeg' });
            await (window as any).__crispIngestFile(file);
            const deadline = Date.now() + 60_000;  // Firefox/WebKit can be slower
            while (Date.now() < deadline) {
                const s = (window as any).state;
                if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) {
                    return {
                        small:    { bytes: s.photoVariants.small.bytes,    blurApplied: s.photoVariants.small.clientBlurApplied },
                        medium:   { bytes: s.photoVariants.medium.bytes,   blurApplied: s.photoVariants.medium.clientBlurApplied },
                        original: { bytes: s.photoVariants.original.bytes, blurApplied: s.photoVariants.original.clientBlurApplied },
                    };
                }
                await new Promise(r => setTimeout(r, 250));
            }
            return null;
        }, { bytes: Array.from(fixtureBytes), name: FIXTURE.file });

        expect(ingest, `variants never populated in ${browserName}`).toBeTruthy();
        writeArtifact(resultDir, '01_variants.json', { browser: browserName, ingest });

        // Variant size ordering invariant (engine-independent)
        expect(ingest!.small.bytes).toBeLessThanOrEqual(ingest!.medium.bytes);
        expect(ingest!.medium.bytes).toBeLessThanOrEqual(ingest!.original.bytes);

        await page.evaluate(({ lat, lng, browser }) => {
            const s = (window as any).state;
            s.crisis_type = 'EARTHQUAKE';
            s.infrastructure_type = 'COMMERCIAL';
            s.damage_classification = 'PARTIAL';
            s.severity = 'MODERATE';
            s.description = 'Validation 11 — cross-browser';
            s.location = { lat, lng, acc: 5 };
            s.locationName = `Cross-browser ${browser}`;
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng, browser: browserName });

        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, deviceHash);
        expect(cid, `${browserName}: PWA never enqueued`).toBeTruthy();

        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media_count >= 3
                && t.media.every(m => m.assembly_status === 'complete' && m.url)
                && t.sync_status === 'SYNCED',
            { timeoutMs: 90_000, intervalMs: 1500 },
        );
        writeArtifact(resultDir, '02_pg_final.json', truthFinal);

        expect(truthFinal.sync_status, `${browserName}: not SYNCED`).toBe('SYNCED');
        expect(truthFinal.media_count).toBeGreaterThanOrEqual(3);
        expect(Math.abs(truthFinal.location_lat! - FIXTURE.lat)).toBeLessThan(0.0001);

        cleanupReport(cid!);
    });
});
