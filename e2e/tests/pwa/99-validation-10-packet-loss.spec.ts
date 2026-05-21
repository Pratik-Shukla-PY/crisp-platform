/**
 * Validation Scenario 10 — Packet-loss simulation.
 *
 * Intercept network at the Playwright layer and randomly fail ~30% of
 * `chunk-bin` POST requests with 502. The PWA's `sendBinaryChunkWithRetry`
 * must retry through the failures + eventually succeed. No duplicate
 * Media rows from the retries.
 *
 * Pass criteria:
 *   · Report reaches SYNCED despite 30% packet loss
 *   · No duplicate Media rows from chunk retries
 *   · Total chunk-bin retries observable in the wire log
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5718', file: 'IMG_5718.jpg', lat: 12.93488, lng: 77.61173 };
const SCENARIO = '10-packet-loss';
const DEVICE_HASH = 'PWA-validation-packet-loss-10';
const DROP_RATE = 0.30;  // 30% of chunk-bin POSTs

test.describe('VALIDATION 10 — 30% packet loss on chunk-bin', () => {
    test(`${FIXTURE.name}: 30% chunk drops → retries succeed → SYNCED, no duplicates`, async ({ page }) => {
        test.setTimeout(300_000);
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);

        const wireLog: Array<{ ts: number; url: string; outcome: 'ok' | 'dropped' | 'real-fail' }> = [];
        const dropDecisions: number[] = [];

        // Intercept chunk-bin: 30% probability of failing with 502.
        await page.route('**/api/v1/reports/*/media/chunk-bin', async (route) => {
            const url = route.request().url();
            if (Math.random() < DROP_RATE) {
                wireLog.push({ ts: Date.now(), url, outcome: 'dropped' });
                dropDecisions.push(Date.now());
                await route.fulfill({
                    status: 502,
                    contentType: 'text/plain',
                    body: 'simulated packet loss',
                });
                return;
            }
            wireLog.push({ ts: Date.now(), url, outcome: 'ok' });
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
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 15_000 },
        );

        const fixtureBytes = fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE.file));
        await page.evaluate(async ({ bytes, name }) => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            const file = new File([blob], name, { type: 'image/jpeg' });
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
            s.crisis_type = 'EXPLOSION';
            s.infrastructure_type = 'COMMERCIAL';
            s.damage_classification = 'PARTIAL';
            s.severity = 'MODERATE';
            s.description = 'Validation 10 — 30% packet loss';
            s.location = { lat, lng, acc: 5 };
            s.locationName = 'Packet-loss test';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        const submitStart = Date.now();
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid).toBeTruthy();

        // Poll for full SYNCED
        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media_count >= 3
                && t.media.every(m => m.assembly_status === 'complete' && m.url)
                && t.sync_status === 'SYNCED',
            { timeoutMs: 240_000, intervalMs: 2000 },
        );
        const timeToSync = Date.now() - submitStart;

        const totalChunks = wireLog.length;
        const drops = wireLog.filter(w => w.outcome === 'dropped').length;
        const actualDropRate = totalChunks > 0 ? drops / totalChunks : 0;
        writeArtifact(resultDir, '01_wire.json', {
            totalChunkAttempts: totalChunks,
            droppedCount: drops,
            actualDropRate,
            targetDropRate: DROP_RATE,
            timeToSyncMs: timeToSync,
        });
        writeArtifact(resultDir, '02_pg_final.json', truthFinal);

        expect(truthFinal.sync_status).toBe('SYNCED');
        expect(truthFinal.media_count).toBeGreaterThanOrEqual(3);
        expect(truthFinal.media.every(m => m.assembly_status === 'complete')).toBe(true);

        // Drop rate should be roughly DROP_RATE ± 15% (sample variance)
        expect(actualDropRate, `actual drop rate ${actualDropRate.toFixed(2)} far from target ${DROP_RATE}`)
            .toBeGreaterThan(DROP_RATE - 0.15);

        // No duplicate Media rows from chunk retries
        const dupRaw = execSync(
            `psql "${PG_DSN}" -A -t -F'|' -c "` +
            `SELECT resolution_tier, COALESCE(photo_group_id, ''), COUNT(*) ` +
            `FROM media WHERE report_id = '${truthFinal.report_id}' ` +
            `GROUP BY resolution_tier, photo_group_id HAVING COUNT(*) > 1"`,
            { encoding: 'utf8' },
        ).trim();
        expect(dupRaw, `duplicate Media rows from packet-loss retries: ${dupRaw}`).toBe('');

        cleanupReport(cid!);
    });
});
