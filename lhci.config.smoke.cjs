/**
 * lhci.config.smoke.cjs — Pull-Request smoke variant.
 *
 * May 2026 (Sprint 3 institutional safeguards). The full
 * `lhci.config.cjs` runs 2 URLs × 3 runs = 6 audits and takes
 * ~5-6 min wall-clock. That's the right cadence for `push to main`
 * (we want the median + the hard gate), but it's too slow + too
 * noisy for every PR push.
 *
 * Smoke variant:
 *   - 1 URL (PWA only — that's where the LCP-critical user lands)
 *   - 1 run per URL (no median — we accept noise on the smoke surface)
 *   - WARN-only thresholds (no hard fail; the main-branch run is
 *     the floor enforcement). PR authors get a heads-up via the
 *     PR comment; they don't get blocked on smoke noise.
 *
 * Why warn-only on smoke: Lighthouse single-run scores routinely
 * drift 5-8 points between identical runs. Hard-failing on a
 * single noisy sample would generate so many false positives that
 * the gate would lose its signal. The full audit on main owns the
 * floor enforcement (median of 3 runs).
 *
 * Selected at workflow time via:
 *   ${{ github.event_name == 'pull_request' &&
 *       './lhci.config.smoke.cjs' || './lhci.config.cjs' }}
 */
const base = require('./lhci.config.cjs');

module.exports = {
    ci: {
        ...base.ci,
        collect: {
            ...base.ci.collect,
            numberOfRuns: 1,
            // PWA only — the public-facing LCP-critical entry point.
            // The dashboard lives behind login and isn't on the
            // typical first-paint critical path.
            url: ['/mobile-app/src/'],
        },
        assert: {
            // Flat warn-only assertions (not an assertMatrix — we
            // only audit one URL, so there's nothing to discriminate
            // on). Pulls thresholds from the PWA block of the main
            // config so the floors stay in sync.
            assertions: {
                'categories:performance':    ['warn', { minScore: 0.45 }],
                'categories:accessibility':  ['warn', { minScore: 0.70 }],
                'categories:best-practices': ['warn', { minScore: 0.85 }],
                'categories:pwa':            ['warn', { minScore: 0.80 }],
                'categories:seo':            ['warn', { minScore: 0.80 }],
                'cumulative-layout-shift':   ['warn', { maxNumericValue: 0.25 }],
                'largest-contentful-paint':  ['warn', { maxNumericValue: 12000 }],
                'total-blocking-time':       ['warn', { maxNumericValue: 1500 }],
            },
        },
    },
};
