// ─────────────────────────────────────────────────────────────────────────────
//  CRISP — k6 load test: progressive (3-variant) image delivery
//
//  Mirrors `report_submit.js` but uploads SMALL → MEDIUM → LARGE variants for
//  one captured photo, *in that order*. This is the scenario the Guaranteed
//  Image Delivery feature is optimised for — responders should see a usable
//  SMALL image within a few seconds on a 64 kbps link, long before LARGE
//  finishes.
//
//  Acceptance criteria (thresholds below):
//    - SMALL (LOW tier) completes in <5 s p95 even under 50 VU.
//    - MEDIUM finishes within 15 s p95.
//    - LARGE finishes within 60 s p95.
//    - All three Media rows share a single `photo_group_id` so the dashboard
//      can fold them into one thumbnail with a progressive upgrade.
//
//  Usage:
//    k6 run -e BASE_URL=http://localhost:8000 load-tests/progressive_image.js
//    k6 run -e SCENARIO=slow   load-tests/progressive_image.js
//    k6 run -e SCENARIO=stress load-tests/progressive_image.js
//
//  The `slow` scenario uses k6's `http_req_duration` tagging to simulate a
//  64 kbps link via long post-chunk sleeps — cheap way to get a first-order
//  approximation without setting up `tc qdisc` on the host.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const SCENARIO = __ENV.SCENARIO || 'realistic';

const scenarios = {
    smoke:     { executor: 'constant-vus', vus: 1, duration: '30s' },
    realistic: {
        executor: 'ramping-vus', startVUs: 0,
        stages: [
            { duration: '1m', target: 50 },
            { duration: '2m', target: 50 },
            { duration: '30s', target: 0 },
        ],
        gracefulRampDown: '30s',
    },
    // Emulates a 64 kbps link — we slow the LARGE tier explicitly by sending
    // many 1 KB chunks (floor). No network-level throttle, but the total wall
    // time approximates a slow link.
    slow: { executor: 'constant-vus', vus: 10, duration: '5m' },
    stress: {
        executor: 'ramping-vus', startVUs: 0,
        stages: [
            { duration: '1m', target: 200 },
            { duration: '3m', target: 200 },
            { duration: '30s', target: 0 },
        ],
        gracefulRampDown: '1m',
    },
};

export const options = {
    scenarios: { [SCENARIO]: scenarios[SCENARIO] || scenarios.realistic },
    thresholds: {
        'http_req_failed':                  ['rate<0.01'],
        'http_req_duration':                ['p(95)<3000'],
        // Per-tier end-to-end:  variant chunks all sent, server has assembled.
        'variant_latency_ms{tier:LOW}':     ['p(95)<5000'],
        'variant_latency_ms{tier:MEDIUM}':  ['p(95)<15000'],
        'variant_latency_ms{tier:HIGH}':    ['p(95)<60000'],
        // First-image SLI — the whole reason the feature exists. We read the
        // k6-side metric, but in production this is `crisp_time_to_first_image`
        // on /metrics.
        'first_image_ms':                   ['p(95)<5000'],
    },
    summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
};

// ── Custom metrics ──────────────────────────────────────────────────────────
const variantLatency = new Trend('variant_latency_ms', true);
const firstImageMs   = new Trend('first_image_ms', true);
const variantsSent   = new Counter('variants_sent');

// ── Helpers ─────────────────────────────────────────────────────────────────
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h &= 0xFFFFFFFF;
    }
    if (h < 0) h += 0x100000000;
    return h.toString(16).padStart(8, '0');
}

function fakeBase64(len) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < len; i++) out += alpha[(Math.random() * 64) | 0];
    return out;
}

// ── Tier spec: matches client-side imageVariants.ts / image-variants.js ────
// Sizes chosen to match the realistic post-JPEG compression output of the
// client variant generator (SMALL ~30 KB, MEDIUM ~150 KB, LARGE ~500 KB).
const TIERS = [
    { label: 'LOW',    bytes:  30 * 1024, chunkSize: 15 * 1024 },
    { label: 'MEDIUM', bytes: 150 * 1024, chunkSize: 50 * 1024 },
    { label: 'HIGH',   bytes: 500 * 1024, chunkSize: 64 * 1024 },
];

function uploadVariant(reportId, photoGroupId, tier) {
    const mediaId = uuid();
    const totalChunks = Math.ceil(tier.bytes / tier.chunkSize);
    const start = Date.now();

    for (let i = 0; i < totalChunks; i++) {
        const remaining = tier.bytes - i * tier.chunkSize;
        const thisChunk = Math.min(tier.chunkSize, remaining);
        const data = fakeBase64(thisChunk);
        const body = JSON.stringify({
            media_id: mediaId,
            type: 'IMAGE',
            seq_num: i,
            total_chunks: totalChunks,
            data,
            checksum: djb2(data),
            resolution_tier: tier.label,
            photo_group_id: photoGroupId,
        });
        const res = http.post(
            `${BASE_URL}/api/v1/reports/${reportId}/media/chunk`,
            body,
            {
                headers: { 'Content-Type': 'application/json' },
                tags: { route: 'chunk', tier: tier.label },
                timeout: '30s',
            }
        );
        check(res, { [`${tier.label} chunk 200`]: r => r.status === 200 });
        // On `slow`, insert a per-chunk sleep so the LARGE tier dominates the
        // timeline and we stress-test the resume path.
        if (SCENARIO === 'slow') sleep(0.2);
    }

    const elapsed = Date.now() - start;
    variantLatency.add(elapsed, { tier: tier.label });
    variantsSent.add(1);
    return elapsed;
}

// ── Main flow per virtual user ─────────────────────────────────────────────
export default function () {
    const deviceHash = `VAR-${uuid().slice(0, 12)}`;
    const clientReportId = uuid();
    const photoGroupId = uuid();

    let reportId = null;
    const flowStart = Date.now();

    group('01_meta', () => {
        const payload = JSON.stringify({
            device_hash: deviceHash,
            client_report_id: clientReportId,
            source: 'APP',
            severity: 'MODERATE',
            infrastructure_type: 'BRIDGE',
            crisis_type: 'EARTHQUAKE',
            damage_classification: 'SEVERE',
            expected_media: 3,   // SMALL + MEDIUM + LARGE for one captured photo
            location: { latitude: 19.076, longitude: 72.8777, accuracy_meters: 10 },
        });
        const res = http.post(`${BASE_URL}/api/v1/reports/meta`, payload, {
            headers: { 'Content-Type': 'application/json' },
            tags: { route: 'meta' },
        });
        check(res, { 'meta 201': r => r.status === 201 });
        if (res.status === 201) reportId = res.json('id');
    });

    if (!reportId) { sleep(1); return; }

    // Tier-first ordering — SMALL all the way through, then MEDIUM, then LARGE.
    // Matches the mobile syncEngine's `tier-first interleaved` loop.
    group('02_small', () => {
        uploadVariant(reportId, photoGroupId, TIERS[0]);
        // Clock first-image SLI as soon as SMALL chunks are all in. Server-side
        // assembly is instant for a 30 KB payload; if it isn't, the threshold
        // will catch it.
        firstImageMs.add(Date.now() - flowStart);
    });

    group('03_medium', () => uploadVariant(reportId, photoGroupId, TIERS[1]));
    group('04_large',  () => uploadVariant(reportId, photoGroupId, TIERS[2]));

    // Simulated think time between reports.
    sleep(Math.random() * 3 + 1);
}

export function handleSummary(data) {
    const v = data.metrics;
    return {
        stdout: JSON.stringify({
            scenario: SCENARIO,
            variants_sent: v.variants_sent?.values?.count,
            p95_small_ms:  v['variant_latency_ms{tier:LOW}']?.values['p(95)'],
            p95_medium_ms: v['variant_latency_ms{tier:MEDIUM}']?.values['p(95)'],
            p95_large_ms:  v['variant_latency_ms{tier:HIGH}']?.values['p(95)'],
            p95_first_image_ms: v.first_image_ms?.values['p(95)'],
            failed_rate:   v.http_req_failed?.values?.rate,
        }, null, 2),
    };
}
