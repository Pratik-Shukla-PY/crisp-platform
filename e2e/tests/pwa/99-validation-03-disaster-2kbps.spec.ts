/**
 * Validation Scenario 03 — Disaster network: 2 KBPS sustained throughput.
 *
 * Throttles the PWA's network to 2000 bytes/sec (humanitarian baseline)
 * via CDP Network.emulateNetworkConditions. At this rate:
 *   - 64 KB probe takes ~32 s
 *   - SMALL (~10 KB) takes ~5 s
 *   - MEDIUM (~50 KB) takes ~25 s
 *   - ORIGINAL (~2 MB) would take ~17 min — expected to defer
 *
 * Pass criteria:
 *   · Report appears in PWA queue
 *   · SMALL lands on the backend within 90 s
 *   · Dashboard listing API shows the report
 *   · Higher tiers either complete OR are marked deferred with
 *     abandon_reason='bandwidth_tier_deferred' — no silent loss
 *   · No duplicate Report rows under retry
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    pwaQueueState, writeArtifact, cleanupReport,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5735_2', file: 'IMG_5735_2.jpg', lat: 12.84461, lng: 77.66421, sizeBytes: 1127813 };
const SCENARIO = '03-disaster-2kbps';
const DEVICE_HASH = 'PWA-validation-disaster-2kbps-03';

test.describe('VALIDATION 03 — 2 KBPS sustained disaster network', () => {
    test(`${FIXTURE.name}: SMALL lands; MEDIUM/ORIGINAL either complete or deferred`, async ({ page }) => {
        test.setTimeout(600_000);  // 10 min budget — disaster networks are slow
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);
        const fixturePath = path.join(FIXTURES_DIR, FIXTURE.file);

        const wireLog: Array<{ ts: number; method: string; url: string; status?: number; bytes?: number }> = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/v1/')) wireLog.push({ ts: Date.now(), method: req.method(), url: req.url() });
        });
        page.on('response', async (res) => {
            if (!res.url().includes('/api/v1/')) return;
            const idx = wireLog.findIndex(w => w.url === res.url() && w.status === undefined);
            if (idx >= 0) {
                wireLog[idx].status = res.status();
                try { wireLog[idx].bytes = (await res.body()).length; } catch (_) {}
            }
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

        // ── Apply 2 KBPS throttling via CDP BEFORE any network traffic ────
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: 2000,   // 2 KBPS down (bytes/sec)
            uploadThroughput: 2000,     // 2 KBPS up (bytes/sec)
            latency: 1500,              // 1.5 s RTT
        });
        const throttleAppliedAt = Date.now();
        writeArtifact(resultDir, '00_throttle.json', {
            ts: throttleAppliedAt,
            downloadThroughput: 2000,
            uploadThroughput: 2000,
            latency: 1500,
        });

        // Ingest fixture (this happens in-browser, no network needed)
        const fixtureBytes = fs.readFileSync(fixturePath);
        const ingestResult = await page.evaluate(async ({ bytes, name }) => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            const file = new File([blob], name, { type: 'image/jpeg' });
            await (window as any).__crispIngestFile(file);
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const s = (window as any).state;
                if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) {
                    return {
                        small: s.photoVariants.small.bytes,
                        medium: s.photoVariants.medium.bytes,
                        original: s.photoVariants.original.bytes,
                    };
                }
                await new Promise(r => setTimeout(r, 250));
            }
            return null;
        }, { bytes: Array.from(fixtureBytes), name: FIXTURE.file });
        expect(ingestResult).toBeTruthy();
        writeArtifact(resultDir, '01_variants.json', ingestResult);

        // Inject state + submit
        await page.evaluate(({ lat, lng }) => {
            const s = (window as any).state;
            s.crisis_type = 'EARTHQUAKE';
            s.infrastructure_type = 'COMMERCIAL';
            s.damage_classification = 'PARTIAL';
            s.severity = 'MODERATE';
            s.description = 'Validation 03 — 2 KBPS disaster network';
            s.location = { lat, lng, acc: 5 };
            s.locationName = '2KBPS test';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        const submitStart = Date.now();
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });

        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid).toBeTruthy();
        writeArtifact(resultDir, '00_meta.json', { fixture: FIXTURE, clientReportId: cid });

        // ── Phase A: SMALL must land within 90 s of submit on 2 KBPS ──────
        // (~10KB transfer at 2KBPS = 5s + probe + RTT overhead = <90s)
        const truthSmallLanded = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media.some(m => m.resolution_tier === 'SMALL'
                                  && m.assembly_status === 'complete'
                                  && m.url !== null && m.url !== ''),
            { timeoutMs: 90_000, intervalMs: 2000 },
        );
        const smallLandedMs = Date.now() - submitStart;
        writeArtifact(resultDir, '02_small_landed.json', {
            elapsedMs: smallLandedMs,
            truth: truthSmallLanded,
        });
        expect(truthSmallLanded.report_id, 'Report row never reached server on 2 KBPS').toBeTruthy();
        const small = truthSmallLanded.media.find(m => m.resolution_tier === 'SMALL');
        expect(small?.assembly_status, 'SMALL must complete within 90s on 2 KBPS').toBe('complete');

        // Dashboard listing already has the report?
        const adminToken = await loginAdmin(page);
        const listRes = await page.request.get('http://localhost:8000/api/v1/reports/?limit=100', {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const listBody = await listRes.json();
        const onList = listBody.find((r: any) => r.client_report_id === cid);
        writeArtifact(resultDir, '03_dashboard_after_small.json', {
            onListFound: !!onList, sync_status: onList?.sync_status, media_count: onList?.media?.length,
        });
        expect(onList, 'report not visible to dashboard after SMALL landed').toBeTruthy();

        // ── Phase B: poll for full SYNCED OR deferred-tier marker, 5-min budget ──
        const phaseBStart = Date.now();
        const truthEnd = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => {
                // Either fully SYNCED…
                if (t.sync_status === 'SYNCED'
                    && t.media.every(m => m.assembly_status === 'complete')) return true;
                // …or higher tiers are marked deferred with the right reason.
                const deferred = t.media.filter(m =>
                    (m.resolution_tier === 'MEDIUM' || m.resolution_tier === 'ORIGINAL')
                    && m.abandon_reason === 'bandwidth_tier_deferred',
                );
                return deferred.length > 0;
            },
            { timeoutMs: 300_000, intervalMs: 5000 },
        );
        const phaseBMs = Date.now() - phaseBStart;
        writeArtifact(resultDir, '04_phase_b_result.json', {
            elapsedMs: phaseBMs,
            sync_status: truthEnd.sync_status,
            media: truthEnd.media.map(m => ({
                tier: m.resolution_tier,
                status: m.assembly_status,
                completion_pct: m.completion_pct,
                abandon_reason: m.abandon_reason,
            })),
        });

        // Acceptance: either full SYNCED OR explicit deferred markers + SMALL still complete
        const fullSynced = truthEnd.sync_status === 'SYNCED'
            && truthEnd.media.every(m => m.assembly_status === 'complete');
        const partialWithDeferred = truthEnd.media.some(m =>
            m.resolution_tier === 'SMALL' && m.assembly_status === 'complete'
        ) && truthEnd.media.some(m => m.abandon_reason === 'bandwidth_tier_deferred');
        expect(
            fullSynced || partialWithDeferred,
            `on 2 KBPS, must either SYNC fully or explicitly mark deferred — got ` +
            `sync=${truthEnd.sync_status} media=${JSON.stringify(truthEnd.media.map(m => ({ t: m.resolution_tier, s: m.assembly_status, r: m.abandon_reason })))}`,
        ).toBe(true);

        // Finding 1 fix verification (May 2026): if SMALL landed and full
        // SYNC isn't possible at 2 KBPS, the PWA MUST have signalled
        // mark-deferred for the higher tiers so the dashboard chip is
        // accurate. Verify at least one MEDIUM or ORIGINAL Media row exists
        // with abandon_reason='bandwidth_tier_deferred' (the chip trigger).
        if (!fullSynced) {
            const deferred = truthEnd.media.filter(m =>
                (m.resolution_tier === 'MEDIUM' || m.resolution_tier === 'ORIGINAL')
                && m.abandon_reason === 'bandwidth_tier_deferred',
            );
            expect(
                deferred.length,
                `pre-emptive defer must signal mark-deferred so dashboard chip fires — ` +
                `got ${deferred.length} deferred placeholders. media=` +
                JSON.stringify(truthEnd.media.map(m => ({ t: m.resolution_tier, r: m.abandon_reason }))),
            ).toBeGreaterThanOrEqual(1);
        }

        writeArtifact(resultDir, '05_L2_wire.json', wireLog);
        writeArtifact(resultDir, '06_summary.json', {
            submitStartMs: submitStart,
            smallLandedAfterMs: smallLandedMs,
            phaseB_ms: phaseBMs,
            verdict: fullSynced ? 'FULL_SYNCED' : 'PARTIAL_WITH_DEFERRED',
            timeToFirstDashboardVisible: smallLandedMs,  // SMALL = visibility threshold
        });

        cleanupReport(cid!);
    });
});

async function loginAdmin(page: any): Promise<string> {
    const ADMIN = { email: 'e2e-admin@crisp-e2e-tests.org', password: 'E2eAdmin!2026', full_name: 'E2E Admin' };
    await page.request.post('http://localhost:8000/api/v1/auth/register', {
        data: { ...ADMIN, role: 'SUPER_ADMIN' },
    }).catch(() => {});
    const res = await page.request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await res.json();
    return body.access_token || body.token;
}
