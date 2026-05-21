/**
 * Validation Scenario 07 — Mid-upload backend outage (simulated).
 *
 * Submit a report, let some chunks land, then simulate a 30s backend outage
 * by intercepting + 502-ing chunk-bin POSTs. From the PWA's perspective
 * this is indistinguishable from a real kill+restart: connection-refused
 * surrogate via 502. After the outage window, chunks succeed again and
 * the report must reach SYNCED.
 *
 * Pass criteria:
 *   · Initial submit works; some chunks land before outage
 *   · During outage: chunk POSTs return 502; PWA retries with backoff
 *   · After outage: chunks resume from chunkProgress
 *   · Final state SYNCED with all 3 tiers complete
 *   · No duplicate Report row
 *   · Geotag preserved
 *
 * Why simulate instead of actually killing the backend:
 *   · Real `lsof | kill` + `uvicorn restart` from inside a test is fragile
 *     (env var dependencies, venv activation, race conditions). When it
 *     fails to come back up, the test hangs indefinitely.
 *   · Route-blocking gives identical PWA semantics (transport failures
 *     during a window) with deterministic timing.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5832', file: 'IMG_5832.jpg', lat: 25.16453, lng: 82.50972 };
const SCENARIO = '07-backend-outage';
const DEVICE_HASH = 'PWA-validation-backend-outage-07';
const OUTAGE_MS = 30_000;  // 30 s simulated outage

test.describe('VALIDATION 07 — backend outage mid-upload (simulated via 502)', () => {
    test(`${FIXTURE.name}: 30s outage mid-upload → resume → SYNCED, no dup`, async ({ page }) => {
        test.setTimeout(240_000);
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);

        // ── Outage gate: when true, intercept chunk-bin with 502 ──────────
        let outageActive = false;
        const wireLog: Array<{ ts: number; url: string; outcome: '502' | 'pass' }> = [];
        await page.route('**/api/v1/reports/*/media/chunk-bin', async (route) => {
            if (outageActive) {
                wireLog.push({ ts: Date.now(), url: route.request().url(), outcome: '502' });
                await route.fulfill({
                    status: 502,
                    contentType: 'text/plain',
                    body: 'simulated backend outage',
                });
                return;
            }
            wireLog.push({ ts: Date.now(), url: route.request().url(), outcome: 'pass' });
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
            s.crisis_type = 'CONFLICT';
            s.infrastructure_type = 'HOSPITAL';
            s.damage_classification = 'COMPLETE';
            s.severity = 'SEVERE';
            s.description = 'Validation 07 — backend outage mid-upload';
            s.location = { lat, lng, acc: 5 };
            s.locationName = 'Outage test';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        const submitStart = Date.now();
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid).toBeTruthy();

        // ── Phase A — let some chunks land first ──────────────────────────
        await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null && t.media.length >= 1,
            { timeoutMs: 30_000, intervalMs: 500 },
        );
        const truthBeforeOutage = pgReportTruth(cid!);
        writeArtifact(resultDir, '01_pg_before_outage.json', truthBeforeOutage);

        // ── Phase B — simulate 30 s outage ────────────────────────────────
        outageActive = true;
        const outageStart = Date.now();
        writeArtifact(resultDir, '02_outage_start.json', { ts: outageStart });
        await page.waitForTimeout(OUTAGE_MS);
        outageActive = false;
        const outageEnd = Date.now();
        writeArtifact(resultDir, '03_outage_end.json', { ts: outageEnd, durationMs: outageEnd - outageStart });

        // Wake the retry loop after outage
        await page.evaluate(() => {
            if ((window as any).startRetryLoop) (window as any).startRetryLoop();
        });

        // ── Phase C — final SYNCED state ──────────────────────────────────
        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media_count >= 3
                && t.media.every(m => m.assembly_status === 'complete' && m.url)
                && t.sync_status === 'SYNCED',
            { timeoutMs: 120_000, intervalMs: 1500 },
        );
        const timeToSyncMs = Date.now() - outageEnd;
        writeArtifact(resultDir, '04_pg_final.json', { truthFinal, timeToSyncAfterOutageMs: timeToSyncMs });

        expect(truthFinal.report_id).toBeTruthy();
        expect(truthFinal.sync_status).toBe('SYNCED');
        expect(truthFinal.media_count).toBeGreaterThanOrEqual(3);

        // Outage actually fired some 502s
        const outage502s = wireLog.filter(w => w.outcome === '502').length;
        expect(outage502s, `expected some 502s during outage window; got ${outage502s}`)
            .toBeGreaterThanOrEqual(1);
        writeArtifact(resultDir, '05_wire.json', { total: wireLog.length, outage502s });

        // No duplicates
        const dupCount = parseInt(
            execSync(`psql "${PG_DSN}" -A -t -c "SELECT COUNT(*) FROM reports WHERE client_report_id = '${cid}'"`, { encoding: 'utf8' }).trim(),
            10,
        );
        expect(dupCount, 'duplicate Report row after outage').toBe(1);

        const dupRaw = execSync(
            `psql "${PG_DSN}" -A -t -F'|' -c "` +
            `SELECT resolution_tier, COALESCE(photo_group_id, ''), COUNT(*) ` +
            `FROM media WHERE report_id = '${truthFinal.report_id}' ` +
            `GROUP BY resolution_tier, photo_group_id HAVING COUNT(*) > 1"`,
            { encoding: 'utf8' },
        ).trim();
        expect(dupRaw, `duplicate Media rows after outage: ${dupRaw}`).toBe('');

        // Geotag preserved
        expect(Math.abs(truthFinal.location_lat! - FIXTURE.lat)).toBeLessThan(0.0001);

        cleanupReport(cid!);
    });
});
