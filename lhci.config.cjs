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
            //
            // Phase 3.4 (May 2026) — ratchet a11y floors up to ≥ 0.90.
            // Phase 2.4 cleared every axe-core WCAG 2.1 A/AA violation
            // on every critical PWA stage (zero criticals + zero
            // seriouses; the e2e/40-axe-a11y spec hard-asserts toBe(0)).
            // Lighthouse's a11y audit is a strict subset of axe-core,
            // so the post-Phase-2.4 score lands ≥ 0.95 in practice.
            // The 0.90 floor leaves a 5-point cushion for transient
            // run-to-run noise while still failing CI on a real
            // regression. UNDP rubric weights a11y heavily;
            // hard-error on the floor (no .warn) so any drop blocks
            // the merge.
            assertMatrix: [
                {
                    // PWA pages — current floor thresholds. Ratchet up
                    // as fixes lift the scores to a new stable level.
                    matchingUrlPattern: '.*/mobile-app/src/.*',
                    assertions: {
                        'categories:performance':    ['error', { minScore: 0.45 }],
                        // Phase 3.4 ratchet: 0.70 → 0.90 (post Phase 2.4).
                        'categories:accessibility':  ['error', { minScore: 0.90 }],
                        'categories:best-practices': ['error', { minScore: 0.85 }],
                        'categories:pwa':            ['error', { minScore: 0.80 }],
                        'categories:seo':            ['warn',  { minScore: 0.80 }],
                        'cumulative-layout-shift':   ['error', { maxNumericValue: 0.25 }],
                        'largest-contentful-paint':  ['warn',  { maxNumericValue: 12000 }],
                        'total-blocking-time':       ['warn',  { maxNumericValue: 1500 }],
                        // HC89 (Sprint 1B) — bundle-size guard for TF.js
                        // + BlazeFace lazy-load invariant. The vendored
                        // libs (~1.4 MB tf.min.js + 12 KB blazeface.min.js)
                        // are precached by the SW but MUST NOT load
                        // during home-stage navigation — they only fire
                        // when the user enters capture stage.
                        //
                        // Baseline measured 2026-05-27 via Playwright
                        // network probe: home stage = 1495 KB of scripts
                        // across 20 files. We allow ~100 KB headroom for
                        // natural drift (locale subset growth, future
                        // home-stage additions) and warn (not error) if
                        // exceeded. If TF.js leaks into first-paint
                        // (e.g. an eager import in app.js boot), the
                        // total would jump to ~2.9 MB → warn fires.
                        //
                        //   1.60 MB = 1,638,400 bytes
                        //   total page weight cap 2.5 MB = 2,621,440 bytes
                        'resource-summary:script:size':
                                                      ['warn',  { maxNumericValue: 1638400 }],
                        'total-byte-weight':         ['warn',  { maxNumericValue: 2621440 }],
                    },
                },
                {
                    // Dashboard — desktop-first, audited under mobile
                    // throttle (consistency with PWA). Relaxed perf gate.
                    matchingUrlPattern: '.*/web-dashboard/src/.*',
                    assertions: {
                        'categories:performance':    ['error', { minScore: 0.55 }],
                        // Phase 3.4 ratchet: 0.85 → 0.90.
                        'categories:accessibility':  ['error', { minScore: 0.90 }],
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
