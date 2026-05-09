/**
 * Lighthouse CI configuration — PROD audit variant.
 *
 * Used by `.github/workflows/deploy.yml::prod-lighthouse-audit` after
 * the EC2 deploy completes. Audits the live production URL instead
 * of localhost. Inherits all thresholds from the dev config to keep
 * one source of truth for the floor values.
 *
 * Why a separate file: LHCI doesn't cleanly merge `staticDistDir` ↔
 * external URL audits via CLI overrides — empty staticDistDir still
 * tries to spin up a server. A dedicated config is the simplest way
 * to skip the auto-server entirely.
 */
const dev = require('./lhci.config.cjs');

module.exports = {
    ci: {
        collect: {
            // Same throttling + form factor as dev — gives apples-to-
            // apples regression comparison.
            settings: dev.ci.collect.settings,
            numberOfRuns: dev.ci.collect.numberOfRuns,
            // No staticDistDir — LHCI audits external URLs as-is.
            url: [
                'https://undp.crisplabs.tech/mobile-app/src/',
                'https://undp.crisplabs.tech/mobile-app/src/?ui=v4',
                'https://undp.crisplabs.tech/web-dashboard/src/',
            ],
        },
        // Reuse the threshold matrix verbatim — PROD must pass the
        // same gate as dev. Drift between the two indicates a real
        // PROD regression (CDN, nginx, or env-specific config issue).
        assert: dev.ci.assert,
        upload: dev.ci.upload,
    },
};
