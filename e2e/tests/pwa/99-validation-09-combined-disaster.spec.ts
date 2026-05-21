/**
 * Validation Scenario 09 — Combined disaster: 2 KBPS + Wi-Fi flapping.
 *
 * The "real-world" disaster network: sustained 2 KBPS PLUS flaky connection
 * that drops out periodically. This is the hardest test — verifies the PWA
 * + backend pipeline survives the combined adversity.
 *
 * Pass criteria:
 *   · Report reaches the backend (Report row exists)
 *   · SMALL eventually completes
 *   · Either full SYNCED OR explicit bandwidth_tier_deferred markers
 *   · No duplicate Report rows
 *   · No silent loss
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5735_2', file: 'IMG_5735_2.jpg', lat: 12.84461, lng: 77.66421 };
const SCENARIO = '09-combined-disaster';
const DEVICE_HASH = 'PWA-validation-combined-disaster-09';

test.describe('VALIDATION 09 — combined 2 KBPS + Wi-Fi flap disaster network', () => {
    test(`${FIXTURE.name}: SMALL survives sustained 2 KBPS with flaps every 60s`, async ({ page }) => {
        test.setTimeout(600_000);
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);

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

        // Apply 2 KBPS sustained throttle
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: 2000,
            uploadThroughput: 2000,
            latency: 1500,
        });
        writeArtifact(resultDir, '00_network.json', { throughput: 2000, latency: 1500 });

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
            s.crisis_type = 'HURRICANE';
            s.infrastructure_type = 'HOUSE';
            s.damage_classification = 'COMPLETE';
            s.severity = 'SEVERE';
            s.description = 'Validation 09 — combined disaster';
            s.location = { lat, lng, acc: 5 };
            s.locationName = 'Combined disaster test';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        const submitStart = Date.now();
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid).toBeTruthy();

        // ── Flap pattern: every 60 s, drop offline for 10 s, then reconnect ──
        // Run 3 cycles over ~3.5 min
        const flapEvents: Array<{ ts: number; state: 'offline' | 'online' }> = [];
        for (let i = 0; i < 3; i++) {
            await page.waitForTimeout(60_000);
            await page.context().setOffline(true);
            flapEvents.push({ ts: Date.now(), state: 'offline' });
            await page.waitForTimeout(10_000);
            await page.context().setOffline(false);
            flapEvents.push({ ts: Date.now(), state: 'online' });
            await page.evaluate(() => {
                window.dispatchEvent(new Event('online'));
                if ((window as any).startRetryLoop) (window as any).startRetryLoop();
            });
        }
        writeArtifact(resultDir, '01_flaps.json', flapEvents);

        // Final: poll for terminal state (SYNCED full OR partial+deferred)
        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => {
                if (t.report_id === null) return false;
                const fullSynced = t.sync_status === 'SYNCED'
                    && t.media.every(m => m.assembly_status === 'complete');
                const smallOK = t.media.some(m => m.resolution_tier === 'SMALL'
                    && m.assembly_status === 'complete');
                const deferred = t.media.some(m => m.abandon_reason === 'bandwidth_tier_deferred');
                return fullSynced || (smallOK && deferred);
            },
            { timeoutMs: 180_000, intervalMs: 5000 },
        );
        const timeToTerminal = Date.now() - submitStart;
        writeArtifact(resultDir, '02_pg_final.json', { truthFinal, timeToTerminal });

        expect(truthFinal.report_id, 'report never reached server under combined disaster').toBeTruthy();
        const small = truthFinal.media.find(m => m.resolution_tier === 'SMALL');
        expect(small?.assembly_status, 'SMALL never completed under combined disaster').toBe('complete');

        // No duplicates
        const count = parseInt(
            execSync(`psql "${PG_DSN}" -A -t -c "SELECT COUNT(*) FROM reports WHERE client_report_id = '${cid}'"`, { encoding: 'utf8' }).trim(),
            10,
        );
        expect(count).toBe(1);

        // Geotag preserved
        expect(Math.abs(truthFinal.location_lat! - FIXTURE.lat)).toBeLessThan(0.0001);

        cleanupReport(cid!);
    });
});
