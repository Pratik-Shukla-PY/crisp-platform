/**
 * CRISP — Lighthouse CI configuration.
 *
 * Audited URLs (Phase 1):
 *   1. PWA home               — http://localhost:8080/mobile-app/src/
 *   2. PWA home (?ui=v4 forced) — http://localhost:8080/mobile-app/src/?ui=v4
 *   3. Dashboard              — http://localhost:8080/web-dashboard/src/
 *
 * Form factor: mobile by default (Slow 4G + 4× CPU slowdown — matches a
 * realistic worst-case CRISP user). Dashboard relaxes mobile thresholds
 * via assertMatrix because it's a desktop-first ops surface.
 *
 * Threshold gate strategy: thresholds are the FLOOR (regression guard),
 * not the TARGET. They sit just below the current verified scores so
 * the bootstrap doesn't self-block. As fixes raise scores to a new
 * stable level, ratchet the thresholds up here. See the
 * "Ratcheting" section in docs/LIGHTHOUSE_QA.md for the policy.
 *
 * Current FLOOR thresholds (HARD — block PR merge if violated):
 *   • Performance     ≥ 0.45 mobile  / ≥ 0.55 dashboard (mobile-throttled)
 *   • Accessibility   ≥ 0.70 everywhere
 *   • Best Practices  ≥ 0.85 everywhere
 *   • PWA             ≥ 0.80 (PWA pages only)
 *   • CLS             ≤ 0.25 (block — confuses low-literacy users)
 *   • LCP             ≤ 12000 ms warn (TF.js/BlazeFace cold start)
 *   • TBT             ≤ 1500 ms warn (heavy main-thread blockers)
 *
 * Aspirational TARGET thresholds (raise the gate to these as fixes land):
 *   • Performance ≥ 0.60 mobile / ≥ 0.70 dashboard
 *   • Accessibility ≥ 0.90 (UNDP must-have)
 *   • LCP ≤ 4000 ms / TBT ≤ 600 ms
 *
 * Override path: apply the `lighthouse-approved` label to the PR. The
 * workflow's threshold-gate step skips when this label is present.
 * Operators bear responsibility for the override; it's logged in the
 * PR comment + workflow audit log.
 *
 * Reports are archived to the `lighthouse-history` orphan Git branch
 * by `scripts/lighthouse-publish.mjs` after every run on main, so
 * regression analysis (done in chat by Claude Code) can pull baselines
 * via `git fetch origin lighthouse-history`. See docs/LIGHTHOUSE_QA.md
 * for the full operator runbook.
 */
module.exports = {
    ci: {
        collect: {
            // LHCI auto-spins up a static-server rooted at staticDistDir
            // and audits the URLs (relative to that root). No need to run
            // `npx serve` separately — saves CI minutes + avoids port
            // collisions.
            staticDistDir: '.',
            // 3 runs per URL; the median is what we assert + publish.
            // Lighthouse is naturally noisy (3-5 points run-to-run);
            // medians stabilise the comparison.
            numberOfRuns: 3,
            // Mobile defaults — Slow 4G + 4× CPU slowdown. Matches the
            // realistic CRISP user (low-end Android in disaster zone).
            settings: {
                formFactor: 'mobile',
                throttling: {
                    rttMs: 150,
                    throughputKbps: 1638.4,        // Slow 4G total
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
                // Skip flaky / not-applicable audits:
                //   uses-rel-preconnect — relies on real DNS+TCP timing,
                //     misleading under throttle simulation.
                //   is-crawlable / canonical / etc. — SEO concerns
                //     not relevant to a private crisis-reporter PWA.
                skipAudits: ['uses-rel-preconnect', 'is-crawlable'],
                onlyCategories: [
                    'performance',
                    'accessibility',
                    'best-practices',
                    'pwa',
                    'seo',
                ],
            },
            // Audited URLs. Paths are relative to staticDistDir.
            // Phase 1 — 3 URLs. Phase 4 will add multi-step user-flow
            // audits for the v4 capture / classify / review stages
            // (those require Lighthouse's userFlow API, not lhci collect).
            url: [
                // May 2026 (Phase 25.10) — `/mobile-app/src/?ui=v4` removed.
                // v4 is default-on for everyone since Phase 25.3; both URLs
                // rendered the same capture flow and produced near-identical
                // scores (perf 47 vs 46). The `?ui=v4` param now only matters
                // as an escape hatch for users who flipped `crisp_ui_v4=off`
                // in localStorage — irrelevant to a fresh Lighthouse run.
                '/mobile-app/src/',
                '/web-dashboard/src/',
            ],
        },
        assert: {
            // Per-URL assertion matrix. LHCI requires either
            // `assertions` OR `assertMatrix`, not both — so the
            // PWA-page block contains the "default" set, and the
            // dashboard block overrides what's different (no PWA
            // category, relaxed perf gate).
            assertMatrix: [
                {
                    // PWA pages — current FLOOR thresholds. Ratchet up
                    // as fixes raise the scores to a new stable level.
                    matchingUrlPattern: '.*/mobile-app/src/.*',
                    assertions: {
                        'categories:performance':    ['error', { minScore: 0.45 }],
                        'categories:accessibility':  ['error', { minScore: 0.70 }],
                        'categories:best-practices': ['error', { minScore: 0.85 }],
                        'categories:pwa':            ['error', { minScore: 0.80 }],
                        'categories:seo':            ['warn',  { minScore: 0.80 }],
                        'cumulative-layout-shift':   ['error', { maxNumericValue: 0.25 }],
                        'largest-contentful-paint':  ['warn',  { maxNumericValue: 12000 }],
                        'total-blocking-time':       ['warn',  { maxNumericValue: 1500 }],
                    },
                },
                {
                    // Dashboard — desktop-first, audited under mobile
                    // throttle (consistency with PWA). Relaxed perf gate.
                    matchingUrlPattern: '.*/web-dashboard/src/.*',
                    assertions: {
                        'categories:performance':    ['error', { minScore: 0.55 }],
                        'categories:accessibility':  ['error', { minScore: 0.85 }],
                        'categories:best-practices': ['error', { minScore: 0.85 }],
                        'categories:seo':            ['warn',  { minScore: 0.65 }],
                        // Dashboard isn't a PWA — explicitly disable.
                        'categories:pwa':            'off',
                        'installable-manifest':      'off',
                        'service-worker':            'off',
                        'splash-screen':             'off',
                        'themed-omnibox':            'off',
                        'maskable-icon':             'off',
                        'apple-touch-icon':          'off',
                        'cumulative-layout-shift':   ['error', { maxNumericValue: 0.25 }],
                        'largest-contentful-paint':  ['warn',  { maxNumericValue: 8000 }],
                        'total-blocking-time':       ['warn',  { maxNumericValue: 1500 }],
                    },
                },
            ],
        },
        upload: {
            // We don't run an LHCI server — `scripts/lighthouse-publish.mjs`
            // archives reports to the `lighthouse-history` orphan branch
            // ourselves (free, durable, Git-native). filesystem upload
            // here just keeps `.lighthouseci/` populated for the
            // publish + comment scripts to read.
            target: 'filesystem',
            outputDir: './.lighthouseci/output',
            reportFilenamePattern: '%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%',
        },
    },
};
