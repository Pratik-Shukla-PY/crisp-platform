#!/usr/bin/env node
// scripts/lighthouse-flow.mjs
//
// Multi-step Lighthouse user-flow audit. Runs Lighthouse's step API
// across the v4 capture flow (Home → Capture → Classify → Review) so
// stage-transition perf is measurable — something `lhci collect` can't
// do because it audits ONE URL at a time.
//
// Usage:
//   bash start.sh        # boot static server + backend
//   node scripts/lighthouse-flow.mjs
//
// Outputs:
//   .lighthouseci/flow-report.html   (interactive timeline)
//   .lighthouseci/flow-report.json   (machine-readable)
//
// Phase 4 — runnable on demand. CI integration deferred until the flow
// stabilises (depends on what flake the multi-step audit shows on real
// stages with TF.js / Mapbox cold-starts).
//
// Env:
//   LH_FLOW_URL  — base URL (default: http://localhost:8080/mobile-app/src/)
//   LH_FLOW_OUT  — output dir (default: .lighthouseci/)
//   LH_HEADLESS  — '1' to run headless (default), '0' to open browser
//
// Open Claude Code and ask "analyze the latest user-flow audit" to get
// AI prioritization of stage-transition perf issues.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const BASE_URL  = process.env.LH_FLOW_URL || 'http://localhost:8080/mobile-app/src/';
const OUT_DIR   = process.env.LH_FLOW_OUT || path.join(REPO_ROOT, '.lighthouseci');
const HEADLESS  = process.env.LH_HEADLESS !== '0';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Dynamic imports — `lighthouse` and `puppeteer-core` aren't direct
// devDependencies of the repo (they're pulled in transitively by
// @lhci/cli). The script lazy-loads them so we get a clear error
// message if they're missing instead of an opaque ESM crash.
let lighthouse, puppeteer;
try {
    lighthouse = (await import('lighthouse'));
} catch {
    console.error(
        '\n❌ This script needs the `lighthouse` package. Install with:\n' +
            '   npm install -g @lhci/cli@0.13.x   # bundles lighthouse + puppeteer-core\n' +
            'OR\n' +
            '   cd e2e && npm install --save-dev lighthouse puppeteer\n',
    );
    process.exit(1);
}
try {
    puppeteer = (await import('puppeteer')).default;
} catch {
    try {
        // Fallback to puppeteer-core if `puppeteer` itself isn't installed
        // (lhci pulls in puppeteer-core only).
        puppeteer = (await import('puppeteer-core')).default;
    } catch {
        console.error(
            '\n❌ This script needs `puppeteer` or `puppeteer-core`. Install with:\n' +
                '   cd e2e && npm install --save-dev puppeteer\n',
        );
        process.exit(1);
    }
}

const { startFlow } = lighthouse;

// ── Mobile throttling profile (Slow 4G + 4× CPU) ───────────────────────────
const FLOW_CONFIG = {
    extends: 'lighthouse:default',
    settings: {
        formFactor: 'mobile',
        throttling: {
            rttMs: 150,
            throughputKbps: 1638.4,
            requestLatencyMs: 562.5,
            downloadThroughputKbps: 1474.56,
            uploadThroughputKbps: 675,
            cpuSlowdownMultiplier: 4,
        },
        screenEmulation: {
            mobile: true,
            width: 412,
            height: 823,
            deviceScaleFactor: 1.75,
            disabled: false,
        },
        emulatedUserAgent:
            'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/96.0.4664.45 Mobile Safari/537.36 ' +
            'Chrome-Lighthouse',
    },
};

async function main() {
    console.log(`[flow] Launching ${HEADLESS ? 'headless' : 'headed'} Chrome…`);
    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
        ],
    });
    const page = await browser.newPage();

    // Pre-set localStorage so we don't get blocked by the consent gate
    // during the flow. This mirrors what real returning users have.
    await page.evaluateOnNewDocument(() => {
        try {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_ui_v4', 'on');
        } catch {}
    });

    const flow = await startFlow(page, {
        name: 'CRISP — v4 capture flow',
        config: FLOW_CONFIG,
    });

    // ── Step 1: cold load home ──────────────────────────────────────────
    console.log('[flow] Step 1/4: cold-load home…');
    await flow.navigate(`${BASE_URL}?ui=v4`, { stepName: 'Home (cold)' });

    // ── Step 2: tap Start → enter capture stage ─────────────────────────
    console.log('[flow] Step 2/4: home → capture…');
    await flow.startTimespan({ stepName: 'Home → Capture' });
    await page.click('#btn-start');
    await page.waitForFunction(
        () => document.querySelector('#stage-v4-capture.active'),
        { timeout: 5000 },
    );
    await page.waitForTimeout(300);  // allow GPS resolve to settle
    await flow.endTimespan();

    // ── Step 3: capture → classify (skip photo via voice-only) ──────────
    console.log('[flow] Step 3/4: capture → classify…');
    await flow.startTimespan({ stepName: 'Capture → Classify' });
    await page.click('#btn-v4-skip-photo');
    await page.waitForFunction(
        () => document.querySelector('#stage-v4-classify.active'),
        { timeout: 5000 },
    );
    await page.waitForTimeout(300);
    await flow.endTimespan();

    // ── Step 4: classify → review ───────────────────────────────────────
    console.log('[flow] Step 4/4: classify → review…');
    await flow.startTimespan({ stepName: 'Classify → Review' });
    await page.click('#btn-v4-classify-next');
    await page.waitForFunction(
        () => document.querySelector('#stage-v4-review.active'),
        { timeout: 5000 },
    );
    await page.waitForTimeout(500);  // BuildingSelect ensureMap + GPS paint
    await flow.endTimespan();

    // ── Final snapshot of the review page ───────────────────────────────
    console.log('[flow] Snapshot: review page steady-state…');
    await flow.snapshot({ stepName: 'Review (steady)' });

    // ── Generate reports ────────────────────────────────────────────────
    console.log('[flow] Generating reports…');
    const html = await flow.generateReport();
    const json = await flow.createFlowResult();
    fs.writeFileSync(path.join(OUT_DIR, 'flow-report.html'), html);
    fs.writeFileSync(
        path.join(OUT_DIR, 'flow-report.json'),
        JSON.stringify(json, null, 2),
    );
    console.log(`[flow] ✅ ${path.join(OUT_DIR, 'flow-report.html')}`);
    console.log(`[flow] ✅ ${path.join(OUT_DIR, 'flow-report.json')}`);

    // Print step-level summary
    console.log('\n[flow] Step summary:');
    for (const step of json.steps || []) {
        const lhr = step.lhr || {};
        const perf = lhr.categories?.performance?.score;
        console.log(
            `  ${step.name?.padEnd(28)}  perf=${perf != null ? Math.round(perf * 100) : 'n/a'}`,
        );
    }

    await browser.close();
}

try {
    await main();
} catch (e) {
    console.error('[flow] FATAL:', e.message);
    if (process.env.LH_VERBOSE) console.error(e.stack);
    process.exit(1);
}
