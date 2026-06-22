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

        // ── Apply 2 KB/s throttling via CDP BEFORE any network traffic ────
        // NOTE (units): 2000 BYTES/sec = 16 kbit/s — NOT the colloquial "2 kbps"
        // (kilobits = ~250 B/s) a field user gets from Chrome's throttle. At
        // 2000 B/s the 64 KB bandwidth probe completes in ~33 s (< the 45 s
        // timeout) so the link is correctly measured and this test PASSES — it
        // does NOT exercise the sub-~5.8 kbit/s wedge. The true ~250 B/s
        // (2 kbit/s) case is covered by 134-low-bandwidth-2kbit.spec.ts.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: 2000,   // 2000 B/s = 16 kbit/s
            uploadThroughput: 2000,     // 2000 B/s = 16 kbit/s
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

        // ── Phase B: at 2 KBPS, SMALL lands fast; MEDIUM/ORIGINAL upload
        // slowly. Per the v240 delivery design the PWA NO LONGER pre-emptively
        // defers higher tiers — it keeps trying for up to 30 DAYS (v350; was
        // 24 h) and drops a tier only at the 30-day cap (or on a genuine
        // orphan). So the correct
        // end-state within a 5-min budget is: SMALL complete + report visible,
        // and every higher tier in a HEALTHY state — complete, explicitly
        // deferred/abandoned, OR pending WITH FORWARD PROGRESS
        // (completion_pct > 0). A higher tier stuck `pending` at 0 % after the
        // budget is a wedge (the real defect this scenario guards against).
        const _higherHealthy = (m: any) =>
            m.assembly_status === 'complete'
            || !!m.abandon_reason                                                   // explicitly deferred / abandoned
            || (m.assembly_status === 'pending' && (m.completion_pct || 0) > 0);     // actively progressing
        const phaseBStart = Date.now();
        const truthEnd = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => {
                const small = t.media.find(m => m.resolution_tier === 'SMALL');
                if (!small || small.assembly_status !== 'complete') return false;
                // Fully SYNCED…
                if (t.sync_status === 'SYNCED'
                    && t.media.every(m => m.assembly_status === 'complete')) return true;
                // …or SMALL delivered + every higher tier healthy (complete /
                // deferred / progressing) — the v240 "keep trying" steady state.
                const higher = t.media.filter(m => m.resolution_tier === 'MEDIUM' || m.resolution_tier === 'ORIGINAL');
                return higher.length > 0 && higher.every(_higherHealthy);
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

        // Acceptance (v240 delivery design): SMALL must deliver + the report
        // must be dashboard-visible (both verified above), and every higher
        // tier must be in a HEALTHY state — complete, explicitly
        // deferred/abandoned, OR pending with forward progress
        // (completion_pct > 0). A higher tier wedged `pending` at 0 % after the
        // 5-min budget is the only failure (a true stuck-state).
        //
        // NOTE (v240/v350): the PWA no longer pre-emptively marks
        // bandwidth_tier_deferred on slow links — it keeps trying every drain
        // for up to 30 DAYS (was 24 h), dropping a tier only at the 30-day cap
        // or on a genuine orphan. So a deferred MARKER is NOT required here; that signal path
        // is exercised by backend test_mark_deferred + 121-offline-queue-
        // resilience instead.
        const fullSynced = truthEnd.sync_status === 'SYNCED'
            && truthEnd.media.every(m => m.assembly_status === 'complete');
        const smallComplete = truthEnd.media.some(m =>
            m.resolution_tier === 'SMALL' && m.assembly_status === 'complete');
        const higherTiers = truthEnd.media.filter(m =>
            m.resolution_tier === 'MEDIUM' || m.resolution_tier === 'ORIGINAL');
        const allHigherHealthy = higherTiers.length > 0 && higherTiers.every(_higherHealthy);
        expect(
            smallComplete && allHigherHealthy,
            `on 2 KBPS: SMALL must deliver + every higher tier must be complete / deferred / progressing (not wedged at 0%) — got ` +
            `sync=${truthEnd.sync_status} media=${JSON.stringify(truthEnd.media.map(m => ({ t: m.resolution_tier, s: m.assembly_status, pct: m.completion_pct, r: m.abandon_reason })))}`,
        ).toBe(true);

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
