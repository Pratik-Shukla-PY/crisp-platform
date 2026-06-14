#!/usr/bin/env node
/**
 * Generate platform-native tier-config files from the canonical
 * `shared/tier-config.json`.
 *
 * Phase 2.1 (Badge Studio premium) - extract a single source of truth
 * for the V4 reward ladder so emoji / label / color / ring gradient
 * never drift between PWA, dashboard, RN, and backend share endpoint.
 *
 *   node scripts/sync-tier-config.mjs            # generate / overwrite
 *   node scripts/sync-tier-config.mjs --check    # CI: exit non-zero on drift
 *
 * Outputs:
 *   shared/tier-config.js   - IIFE that exports window.CRISP_TIERS +
 *                             window.CRISP_TIERS_BY_ID for vanilla
 *                             JS (PWA + dashboard). Loaded via
 *                             <script src="..."> BEFORE app.js.
 *   shared/tier-config.ts   - `export const TIERS` + `TIERS_BY_ID`
 *                             for RN / Expo (importable as a typed
 *                             constant).
 *
 * The Python backend reads the JSON directly (`json.load`) so no
 * generated .py file - see backend/app/services/tier_config.py.
 *
 * The generator is deterministic: same JSON → same output bytes, so
 * the `--check` mode is just a diff against the freshly-regenerated
 * content.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CHECK_ONLY = process.argv.includes("--check");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let problems = 0;
function fail(msg) { console.error(`${RED}✘${RESET} ${msg}`); problems++; }
function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }

const config = JSON.parse(
    await readFile(join(ROOT, "shared/tier-config.json"), "utf8"),
);

const tiers = config.tiers;

// ── Header (rendered in every generated file) ────────────────────────
const header = `// ╭──────────────────────────────────────────────────────────────────╮
// │ AUTO-GENERATED - DO NOT EDIT BY HAND                            │
// │ Source: shared/tier-config.json                                  │
// │ Regenerate with: node scripts/sync-tier-config.mjs               │
// │ CI verifies with: node scripts/sync-tier-config.mjs --check      │
// ╰──────────────────────────────────────────────────────────────────╯
`;

// ── JS output (PWA + dashboard) ──────────────────────────────────────
//
// IIFE that attaches CRISP_TIERS (array) + CRISP_TIERS_BY_ID (lookup)
// to window. Both PWA + dashboard use <script src> before app.js, so
// these globals are ready by the time the consumer runs.
function renderJS() {
    const tiersJSON = JSON.stringify(tiers, null, 4);
    const aliasesJSON = JSON.stringify(config.legacy_aliases, null, 4);
    return `${header}
(function () {
    'use strict';
    const TIERS = ${tiersJSON};
    const TIERS_BY_ID = TIERS.reduce((acc, t) => { acc[t.id] = t; return acc; }, {});
    const LEGACY_ALIASES = ${aliasesJSON};
    // Strip the $comment key so consumers don't see it.
    delete LEGACY_ALIASES.$comment;
    if (typeof window !== 'undefined') {
        window.CRISP_TIERS = TIERS;
        window.CRISP_TIERS_BY_ID = TIERS_BY_ID;
        window.CRISP_TIER_LEGACY_ALIASES = LEGACY_ALIASES;
    }
})();
`;
}

// ── TS output (RN / Expo) ────────────────────────────────────────────
//
// Plain typed module. Importable as
//   import { TIERS, TIERS_BY_ID, TierId } from './shared/tier-config';
function renderTS() {
    const ids = tiers.map((t) => `"${t.id}"`).join(" | ");
    const tiersJSON = JSON.stringify(tiers, null, 4);
    const aliasesEntries = Object.entries(config.legacy_aliases)
        .filter(([k]) => !k.startsWith("$"))
        .map(([k, v]) => `    ${k}: "${v}",`)
        .join("\n");
    return `${header}
export type TierId = ${ids};

export interface TierConfig {
    id: TierId;
    order: number;
    emoji: string;
    label: string;
    i18n_key: string;
    color: string;
    ring_gradient: { start: string; end: string };
    criterion: string;
}

export const TIERS: TierConfig[] = ${tiersJSON} as const;

export const TIERS_BY_ID: Record<TierId, TierConfig> = TIERS.reduce(
    (acc, t) => { acc[t.id] = t; return acc; },
    {} as Record<TierId, TierConfig>,
);

export const LEGACY_TIER_ALIASES: Record<string, TierId> = {
${aliasesEntries}
};
`;
}

// The PWA + dashboard each ship from their own static directory
// (mobile-app/src + web-dashboard/src). Writing the same JS bundle
// into all three keeps deploy-time copies in lockstep with the
// canonical `shared/`. CI's --check mode catches drift if any of
// the divergences from the source-of-truth JSON.
//
// The RN bundler (Metro) can't follow `../shared/` cleanly across
// the repo root in every project layout, so we also drop a copy of
// the TS module inside `crisp-mobile/shared/`.
const jsBody = renderJS();
const tsBody = renderTS();
const outputs = [
    { path: "shared/tier-config.js",                body: jsBody },
    { path: "mobile-app/src/tier-config.js",        body: jsBody },
    { path: "web-dashboard/src/tier-config.js",     body: jsBody },
    { path: "shared/tier-config.ts",                body: tsBody },
    { path: "crisp-mobile/shared/tier-config.ts",   body: tsBody },
];

for (const { path, body } of outputs) {
    const full = join(ROOT, path);
    let existing = "";
    try { existing = await readFile(full, "utf8"); } catch { /* missing → create */ }
    if (existing === body) {
        ok(`${path} already in sync`);
        continue;
    }
    if (CHECK_ONLY) {
        fail(`${path} is out of sync with shared/tier-config.json`);
        continue;
    }
    await writeFile(full, body);
    ok(`${path} regenerated (${body.length} bytes)`);
}

console.log("");
if (problems) {
    if (CHECK_ONLY) {
        console.error(
            `${RED}FAIL${RESET} - ${problems} tier-config output(s) out of sync. ` +
            `Run without --check to regenerate, then commit.`,
        );
    } else {
        console.error(`${RED}FAIL${RESET} - ${problems} problem(s).`);
    }
    process.exit(1);
}
console.log(`${GREEN}PASS${RESET} - tier-config outputs in sync with canonical JSON.`);
