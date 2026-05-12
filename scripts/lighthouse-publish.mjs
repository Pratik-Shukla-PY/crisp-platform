#!/usr/bin/env node
// scripts/lighthouse-publish.mjs
//
// Reads `.lighthouseci/` output (post `lhci collect`) and:
//   1. Picks the median run per audited URL.
//   2. Builds a `summary.json` with current scores + metadata.
//   3. Pushes the median JSON + HTML reports to the `lighthouse-history`
//      orphan Git branch under `<short-sha>/<page-key>/median.{json,html}`.
//
// On first invocation (lighthouse-history doesn't exist yet) the script
// creates the orphan branch with a minimal README.
//
// Reads:
//   .lighthouseci/lhr-*.json (LHCI raw runs)
//   .lighthouseci/output/*.html (LHCI HTML reports)
//
// Writes (to lighthouse-history branch):
//   <sha>/summary.json
//   <sha>/<page-key>/median.json
//   <sha>/<page-key>/median.html
//
// Env vars:
//   GITHUB_SHA          — commit SHA (CI-injected). Falls back to git rev-parse HEAD.
//   GITHUB_REF          — branch ref (CI-injected, used in summary metadata).
//   GITHUB_ACTOR        — author (CI-injected, used in summary metadata).
//   LHCI_HISTORY_REMOTE — git remote name (default: 'origin').
//   LHCI_DRY_RUN        — set to '1' to skip git push (build summary.json only).
//
// Exit codes:
//   0 — published (or dry-run-completed) successfully
//   1 — fatal error (e.g. no .lighthouseci dir, git push failed)
//
// Used by: .github/workflows/lighthouse.yml — runs after `lhci collect`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LHCI_DIR = path.join(REPO_ROOT, '.lighthouseci');
const OUTPUT_DIR = path.join(LHCI_DIR, 'output');
const HISTORY_BRANCH = 'lighthouse-history';
const REMOTE = process.env.LHCI_HISTORY_REMOTE || 'origin';
const DRY_RUN = process.env.LHCI_DRY_RUN === '1';
const GITHUB_SHA_FULL = process.env.GITHUB_SHA ||
    execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
// Optional suffix (e.g. "-prod" on the post-deploy audit) so PROD
// audits don't collide with PR audits on the same SHA.
const SUFFIX = process.env.LHCI_PUBLISH_SUFFIX || '';
const SHORT_SHA = GITHUB_SHA_FULL.slice(0, 7) + SUFFIX;

// ── Page-key derivation ─────────────────────────────────────────────────────
// Maps a URL (LHCI's `requestedUrl`) to a stable folder name in the history
// branch. Add new entries here as more URLs get audited.
function urlToPageKey(url) {
    try {
        const u = new URL(url);
        const p = u.pathname + u.search;
        if (p.match(/\/mobile-app\/src\//))         return 'pwa-home';
        if (p.match(/\/web-dashboard\/src\//))      return 'dashboard';
        // Fallback — should never hit if URL list in lhci.config.cjs
        // matches this map.
        return 'other-' + p.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '');
    } catch {
        return 'unparseable';
    }
}

// ── Scan `.lighthouseci/` for raw LHR JSON files ────────────────────────────
// LHCI writes `lhr-<digits>.json` per run (and matching .html). The number
// of files = (URL count × numberOfRuns).
function scanLhrRuns() {
    if (!fs.existsSync(LHCI_DIR)) {
        throw new Error(
            `No .lighthouseci/ directory at ${LHCI_DIR}. Did 'lhci collect' run?`,
        );
    }
    const files = fs.readdirSync(LHCI_DIR);
    const lhrJsons = files.filter(
        (f) => /^lhr-\d+\.json$/.test(f) || /^lhr-[0-9a-f-]+\.json$/.test(f),
    );
    if (!lhrJsons.length) {
        throw new Error(
            `No lhr-*.json files in ${LHCI_DIR}. LHCI collect must have failed silently.`,
        );
    }
    const runs = [];
    for (const f of lhrJsons) {
        try {
            const lhr = JSON.parse(fs.readFileSync(path.join(LHCI_DIR, f), 'utf8'));
            runs.push({
                url: lhr.requestedUrl || lhr.finalUrl,
                jsonPath: f,
                htmlPath: f.replace('.json', '.html'),
                fetchTime: lhr.fetchTime,
                scores: {
                    performance:    lhr.categories?.performance?.score    ?? null,
                    accessibility:  lhr.categories?.accessibility?.score  ?? null,
                    'best-practices': lhr.categories?.['best-practices']?.score ?? null,
                    pwa:            lhr.categories?.pwa?.score            ?? null,
                    seo:            lhr.categories?.seo?.score            ?? null,
                },
                metrics: {
                    lcp: lhr.audits?.['largest-contentful-paint']?.numericValue ?? null,
                    cls: lhr.audits?.['cumulative-layout-shift']?.numericValue ?? null,
                    tbt: lhr.audits?.['total-blocking-time']?.numericValue ?? null,
                    fcp: lhr.audits?.['first-contentful-paint']?.numericValue ?? null,
                    si:  lhr.audits?.['speed-index']?.numericValue ?? null,
                },
            });
        } catch (e) {
            console.warn(`[publish] Skipping ${f}: ${e.message}`);
        }
    }
    return runs;
}

// ── Median picker ───────────────────────────────────────────────────────────
// LH's recommended convention: median by performance score.
function pickMedian(runs) {
    const sorted = runs
        .slice()
        .sort((a, b) => (a.scores.performance || 0) - (b.scores.performance || 0));
    return sorted[Math.floor(sorted.length / 2)];
}

// ── Group runs by URL, compute medians ─────────────────────────────────────
function buildSummary(runs) {
    const byUrl = new Map();
    for (const r of runs) {
        if (!byUrl.has(r.url)) byUrl.set(r.url, []);
        byUrl.get(r.url).push(r);
    }
    const pages = {};
    for (const [url, urlRuns] of byUrl) {
        const key = urlToPageKey(url);
        const median = pickMedian(urlRuns);
        // Round 0-1 LH scores to 0-100 ints (the conventional Lighthouse
        // display format). null stays null (categorical N/A — e.g. PWA
        // for the dashboard).
        const round = (v) => (v == null ? null : Math.round(v * 100));
        pages[key] = {
            url,
            scores: {
                performance:     round(median.scores.performance),
                accessibility:   round(median.scores.accessibility),
                'best-practices': round(median.scores['best-practices']),
                pwa:             round(median.scores.pwa),
                seo:             round(median.scores.seo),
            },
            metrics: median.metrics,
            run_count: urlRuns.length,
            median_file: median.jsonPath,
        };
    }
    return {
        sha: SHORT_SHA,
        sha_full: GITHUB_SHA_FULL,
        ts: new Date().toISOString(),
        ref: process.env.GITHUB_REF || '',
        actor: process.env.GITHUB_ACTOR || '',
        pages,
    };
}

// ── Locate the matching HTML file for a given JSON run ─────────────────────
// LHCI's `output/` dir uses different filename conventions per version:
//   - older: lhr-<ts>.html (mirror of json)
//   - newer: <pathname>-<datetime>-report.html (per reportFilenamePattern)
// We try the obvious mirror first, then scan output/ as a fallback.
function findHtmlReportFor(jsonPath, _url) {
    const mirror = path.join(LHCI_DIR, jsonPath.replace('.json', '.html'));
    if (fs.existsSync(mirror)) return mirror;
    if (!fs.existsSync(OUTPUT_DIR)) return null;
    const outputs = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.html'));
    if (!outputs.length) return null;
    // Last-resort: pick any HTML report (better than nothing — they're
    // all from this run anyway).
    return path.join(OUTPUT_DIR, outputs[0]);
}

// ── Git: ensure lighthouse-history branch exists, then add + push ──────────
function publishToHistoryBranch(summary) {
    if (DRY_RUN) {
        console.log('[publish] LHCI_DRY_RUN=1 — skipping git push.');
        return;
    }
    const worktreeDir = path.join(os.tmpdir(), `crisp-lh-history-${Date.now()}`);

    // Step 1: try to fetch the history branch (succeeds if it already exists
    // on the remote, fails silently otherwise).
    try {
        execSync(`git fetch --depth=20 ${REMOTE} ${HISTORY_BRANCH}`, {
            cwd: REPO_ROOT,
            stdio: 'pipe',
        });
    } catch {
        // Branch doesn't exist on remote yet. We'll create it below.
    }

    // Step 2: prepare a worktree pointing at the history branch.
    let createdNew = false;
    try {
        execSync(`git worktree add "${worktreeDir}" ${REMOTE}/${HISTORY_BRANCH}`, {
            cwd: REPO_ROOT,
            stdio: 'pipe',
        });
        // The above gives us a detached HEAD at the remote branch tip.
        // Move to a tracking branch so pushes work cleanly.
        execSync(`git checkout -B ${HISTORY_BRANCH}`, {
            cwd: worktreeDir,
            stdio: 'pipe',
        });
    } catch {
        // Remote branch doesn't exist — create the orphan locally.
        execSync(`git worktree add --detach "${worktreeDir}" HEAD`, {
            cwd: REPO_ROOT,
            stdio: 'pipe',
        });
        execSync(`git checkout --orphan ${HISTORY_BRANCH}`, {
            cwd: worktreeDir,
            stdio: 'pipe',
        });
        // Wipe the index so the orphan starts empty.
        execSync('git rm -rf . 2>/dev/null || true', {
            cwd: worktreeDir,
            stdio: 'pipe',
            shell: true,
        });
        // README so the branch isn't completely empty (Git doesn't track
        // empty trees; the first commit needs at least one file).
        fs.writeFileSync(
            path.join(worktreeDir, 'README.md'),
            '# CRISP — Lighthouse history\n\n' +
                'Auto-generated archive of Lighthouse CI runs, one folder per\n' +
                'commit SHA. **Do not edit by hand.**\n\n' +
                '- Each `<sha>/summary.json` has the at-a-glance scores per page.\n' +
                '- Each `<sha>/<page>/median.json` is the median LHR (raw audit).\n' +
                '- Each `<sha>/<page>/median.html` is the human-readable report.\n\n' +
                'Maintained by `scripts/lighthouse-publish.mjs`. See\n' +
                '`docs/LIGHTHOUSE_QA.md` for the operator runbook.\n',
        );
        createdNew = true;
    }

    try {
        // Step 3: write the new <sha>/ subtree.
        const targetDir = path.join(worktreeDir, SHORT_SHA);
        fs.mkdirSync(targetDir, { recursive: true });

        // Top-level summary
        fs.writeFileSync(
            path.join(targetDir, 'summary.json'),
            JSON.stringify(summary, null, 2),
        );

        // Per-page median artifacts
        for (const [pageKey, info] of Object.entries(summary.pages)) {
            const pageDir = path.join(targetDir, pageKey);
            fs.mkdirSync(pageDir, { recursive: true });
            const jsonSrc = path.join(LHCI_DIR, info.median_file);
            if (fs.existsSync(jsonSrc)) {
                fs.copyFileSync(jsonSrc, path.join(pageDir, 'median.json'));
            }
            const htmlSrc = findHtmlReportFor(info.median_file, info.url);
            if (htmlSrc && fs.existsSync(htmlSrc)) {
                fs.copyFileSync(htmlSrc, path.join(pageDir, 'median.html'));
            }
        }

        // Step 4: commit + push.
        execSync('git add .', { cwd: worktreeDir, stdio: 'pipe' });
        const commitMsg = createdNew
            ? `chore(lighthouse): init history + publish ${SHORT_SHA}`
            : `chore(lighthouse): publish ${SHORT_SHA}`;
        try {
            execSync(
                'git -c user.email=lighthouse-bot@crisplabs.tech ' +
                    '-c user.name="Lighthouse Bot" ' +
                    `commit -m ${JSON.stringify(commitMsg)}`,
                { cwd: worktreeDir, stdio: 'pipe' },
            );
        } catch (e) {
            const msg = String(e?.stdout || e?.stderr || e);
            if (/nothing to commit/i.test(msg)) {
                console.log('[publish] Nothing new to commit. (Same SHA already published?)');
                return;
            }
            throw e;
        }
        execSync(`git push ${REMOTE} HEAD:${HISTORY_BRANCH}`, {
            cwd: worktreeDir,
            stdio: 'inherit',
        });
        console.log(
            `[publish] ✅ Pushed ${SHORT_SHA} to ${REMOTE}/${HISTORY_BRANCH}.`,
        );
    } finally {
        // Always clean up the worktree (even on push failure) so subsequent
        // re-runs don't trip "worktree already exists" errors.
        try {
            execSync(`git worktree remove --force "${worktreeDir}"`, {
                cwd: REPO_ROOT,
                stdio: 'pipe',
            });
        } catch {
            // Worktree might already be removed; non-fatal.
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
    console.log(`[publish] Building summary for ${SHORT_SHA}…`);
    const runs = scanLhrRuns();
    const summary = buildSummary(runs);

    // Write summary.json into .lighthouseci/ so the PR-comment script can
    // read it without re-scanning.
    const localSummaryPath = path.join(LHCI_DIR, 'summary.json');
    fs.writeFileSync(localSummaryPath, JSON.stringify(summary, null, 2));
    console.log(`[publish] Wrote ${localSummaryPath}`);
    console.log('[publish] Page scores:');
    for (const [k, info] of Object.entries(summary.pages)) {
        const s = info.scores;
        console.log(
            `  ${k.padEnd(15)} perf=${s.performance ?? '-'} ` +
                `a11y=${s.accessibility ?? '-'} ` +
                `bp=${s['best-practices'] ?? '-'} ` +
                `pwa=${s.pwa ?? '-'} ` +
                `seo=${s.seo ?? '-'}`,
        );
    }

    publishToHistoryBranch(summary);
}

try {
    main();
} catch (e) {
    console.error('[publish] FATAL:', e.message);
    if (process.env.LHCI_VERBOSE) console.error(e.stack);
    // Soft-fail by default — the publish step is bookkeeping, not a
    // gate. The audit (lhci assert) is what gates the deploy. If the
    // history-branch push fails (lacks write permission, network
    // hiccup, etc.) we don't want that to block the deploy.
    // Set LHCI_PUBLISH_FAIL_ON_ERROR=1 to enforce strict failure.
    if (process.env.LHCI_PUBLISH_FAIL_ON_ERROR === '1') {
        process.exit(1);
    }
    console.error(
        '[publish] (Soft-fail — publish failure does not block the gate. ' +
            'Set LHCI_PUBLISH_FAIL_ON_ERROR=1 to enforce strict failure.)',
    );
    process.exit(0);
}
