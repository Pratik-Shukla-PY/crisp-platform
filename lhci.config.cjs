/**
 * Lighthouse CI configuration.
 *
 * Audits two URLs under a Slow-4G mobile profile: the PWA home and the
 * dashboard. Thresholds below are floors (regression guards), not
 * targets — see docs/LIGHTHOUSE_QA.md for the ratcheting policy and
 * the `lighthouse-approved` PR-label override.
 *
 * Reports are archived to the `lighthouse-history` orphan Git branch
 * by `scripts/lighthouse-publish.mjs` after every main-branch run, so
 * historical baselines stay available via `git fetch origin
 * lighthouse-history`.
 */
module.exports = {
    ci: {
        collect: {
            // LHCI auto-spins up a static-server rooted at staticDistDir
            // and audits the URLs relative to it. Saves spinning up a
            // separate `npx serve` + avoids port collisions in CI.
            staticDistDir: '.',
            // 3 runs per URL; we assert + publish the median. Lighthouse
            // is naturally noisy (3-5 points run-to-run); medians keep
            // the comparison stable.
            numberOfRuns: 3,
            // Slow 4G + 4× CPU slowdown. Matches a realistic CRISP user
            // (low-end Android in a disaster zone).
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
                // uses-rel-preconnect relies on real DNS+TCP timing and
                // is misleading under throttle simulation; is-crawlable
                // doesn't apply to a private crisis-reporter PWA.
                skipAudits: ['uses-rel-preconnect', 'is-crawlable'],
                onlyCategories: [
                    'performance',
                    'accessibility',
                    'best-practices',
                    'pwa',
                    'seo',
                ],
            },
            // Audited URLs (relative to staticDistDir). `?ui=v4` is the
            // default capture flow now, so it's covered by the bare PWA
            // home URL — no separate audit needed.
            url: [
                '/mobile-app/src/',
                '/web-dashboard/src/',
            ],
        },
        assert: {
            // Per-URL assertion matrix. LHCI requires either
            // `assertions` OR `assertMatrix`, not both, so PWA pages
            // carry the default set and the dashboard block overrides
            // what differs (no PWA category, relaxed perf gate).
            assertMatrix: [
                {
                    // PWA pages — current floor thresholds. Ratchet up
                    // as fixes lift the scores to a new stable level.
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
            // itself. The filesystem target here just keeps `.lighthouseci/`
            // populated for the publish + PR-comment scripts to read.
            target: 'filesystem',
            outputDir: './.lighthouseci/output',
            reportFilenamePattern: '%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%',
        },
    },
};
