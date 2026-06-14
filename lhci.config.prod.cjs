/**
 * Lighthouse CI configuration - production audit variant.
 *
 * Used by the deploy workflow's post-deploy audit step. Audits the
 * live production URL instead of localhost; inherits thresholds from
 * the dev config so there's one source of truth for the floor values.
 *
 * A separate file is needed because LHCI doesn't cleanly merge
 * staticDistDir with external-URL audits via CLI overrides - an empty
 * staticDistDir still tries to spin up a server.
 */
const dev = require('./lhci.config.cjs');

module.exports = {
    ci: {
        collect: {
            // Same throttling + form factor as dev for apples-to-apples
            // regression comparison.
            settings: dev.ci.collect.settings,
            numberOfRuns: dev.ci.collect.numberOfRuns,
            // No staticDistDir - LHCI audits the live URL as-is.
            url: [
                'https://undp.crisplabs.tech/mobile-app/src/',
                'https://undp.crisplabs.tech/web-dashboard/src/',
            ],
        },
        // Reuse the threshold matrix verbatim. Drift between dev and
        // prod scores indicates a real env-specific regression (CDN,
        // nginx, headers, etc.).
        assert: dev.ci.assert,
        upload: dev.ci.upload,
    },
};
