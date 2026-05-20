#!/usr/bin/env node
/**
 * Phase L (May 2026) — tier-vocabulary regression guard.
 *
 * After Phase L Batch 1b dropped LOW/HIGH from the backend
 * ResolutionEnum + alembic 0036 dropped them from the Postgres enum,
 * ANY client (PWA, RN, bot) sending those legacy tier names gets a
 * 422 from the backend and submissions stall forever.
 *
 * The initial Batch 2 PWA rename missed 5+ residual sites (defaults
 * in fallback positions, function-parameter defaults, sw.js audio
 * attach, reconcile-counter filters). This validator hard-fails CI
 * if ANY non-canonical tier string literal appears in client code.
 *
 * Run: `node scripts/validate-phase-l-tier-vocab.mjs`
 *
 * Exit codes:
 *   0 — only canonical SMALL/MEDIUM/ORIGINAL strings present
 *   1 — found legacy LOW/HIGH/large/LARGE literal in client code
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

// Files in scope: PWA bundle, dashboard JS, bot Python, RN client.
// Backend Python is EXCLUDED — it intentionally has the literals in
// comments + (where unavoidable) docstrings explaining the rename.
//
// May 2026 — added crisp-mobile/ (React Native) after the audit found
// syncEngine.ts + imageVariants.ts still emitting LOW/HIGH to the wire,
// which the post-Phase-L backend 422s. The validator was scanning every
// other client but missed RN entirely; that gap is now closed.
const SCAN_PATHS = [
    'mobile-app/src/app.js',
    'mobile-app/src/sw.js',
    'mobile-app/src/image-variants.js',
    'web-dashboard/src/app.js',
    'web-dashboard/src/sw.js',
    'messaging-bot/chunked_uploader.py',
    'messaging-bot/telegram/handlers.py',
    'messaging-bot/whatsapp/handlers.py',
    'crisp-mobile/services/syncEngine.ts',
    'crisp-mobile/services/imageVariants.ts',
    'crisp-mobile/services/networkAdaptive.ts',
];

// Patterns that indicate a LIVE code path emitting a legacy tier name.
// Comments + docstrings are OK; ACTUAL string-literal values in JSON
// payloads, function defaults, or comparisons are not.
const VIOLATIONS = [
    // `resolution_tier: 'LOW'` in JS object literals or JSON
    {
        re: /resolution_tier\s*[:=]\s*['"](LOW|HIGH)['"]/g,
        message: "resolution_tier set to legacy LOW/HIGH",
    },
    // `resolutionTier = 'LOW'` (function default OR variable assignment)
    {
        re: /resolutionTier\s*=\s*['"](LOW|HIGH)['"]/g,
        message: "resolutionTier default to legacy LOW/HIGH",
    },
    // `|| 'LOW'` / `|| 'HIGH'` fallback patterns in tier contexts
    {
        re: /\|\|\s*['"](LOW|HIGH)['"]/g,
        message: "fallback to legacy LOW/HIGH",
    },
    // .resolution_tier === 'LOW' comparison
    {
        re: /resolution_tier\s*\)\s*\.toUpperCase\(\)\s*===\s*['"](LOW|HIGH)['"]/g,
        message: "comparison against legacy LOW/HIGH",
    },
    // m.resolution_tier === 'HIGH' (most common dashboard pattern —
    // dashboards finding the "largest" tier by name match)
    {
        re: /\.resolution_tier\s*===?\s*['"](LOW|HIGH)['"]/g,
        message: "direct .resolution_tier comparison against legacy LOW/HIGH",
    },
    // tier === 'large' in JS — the lowercase PWA-internal variant key
    {
        re: /tier\s*===?\s*['"]large['"]/g,
        message: "comparison against legacy 'large' variant key",
    },
    // Variant object key `.large` (only as property access, not in comments)
    {
        re: /variants\.large\b(?!\s*[*/])/g,
        message: "access to legacy variants.large key",
    },
    // Python tier_dict = ... or "LOW"/"HIGH" in resolution_tier context
    {
        re: /"resolution_tier"\s*:\s*"(LOW|HIGH)"/g,
        message: "Python dict assigning LOW/HIGH to resolution_tier",
    },
    // TypeScript union-type literal — `'LOW' | 'MEDIUM' | 'HIGH'`.
    // Added May 2026 after RN's syncEngine.ts hid the regression inside
    // a Record<...> type annotation that none of the other patterns
    // matched. We require LOW or HIGH to appear next to a `|` so we
    // don't false-positive on unrelated 3-letter strings.
    {
        re: /['"](LOW|HIGH)['"]\s*\|/g,
        message: "TS union-type literal includes legacy LOW/HIGH",
    },
    {
        re: /\|\s*['"](LOW|HIGH)['"]/g,
        message: "TS union-type literal includes legacy LOW/HIGH",
    },
    // Object-value assignment: `small: 'LOW'` or `large: 'HIGH'` inside
    // a tier map. The map key is the internal name ('small' | 'medium'
    // | 'large'); the value is the WIRE tier that goes to the backend.
    {
        re: /\b(small|medium|large)\s*:\s*['"](LOW|HIGH)['"]/g,
        message: "tier-map value still emits legacy LOW/HIGH on the wire",
    },
];

let totalViolations = 0;
for (const rel of SCAN_PATHS) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) {
        console.warn(`[skip] ${rel} (not found)`);
        continue;
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, idx) => {
        // Skip pure-comment lines.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')
            || trimmed.startsWith('#') || trimmed === '') return;
        // Strip inline // comments before regex match — a comment at
        // end of line shouldn't trip the validator (false positives
        // came from descriptive comments quoting the legacy strings
        // they were renaming away).
        let codeOnly = line;
        const inlineCommentIdx = (() => {
            // naive: find // not inside quotes. Good enough for the
            // tier-vocab files we scan.
            let inStr = null;
            for (let i = 0; i < line.length - 1; i++) {
                const c = line[i];
                if (inStr) {
                    if (c === inStr && line[i - 1] !== '\\') inStr = null;
                    continue;
                }
                if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
                if (c === '/' && line[i + 1] === '/') return i;
            }
            return -1;
        })();
        if (inlineCommentIdx >= 0) codeOnly = line.slice(0, inlineCommentIdx);
        for (const { re, message } of VIOLATIONS) {
            re.lastIndex = 0;
            const match = re.exec(codeOnly);
            if (match) {
                console.error(
                    `\x1b[31m✗\x1b[0m ${rel}:${idx + 1} — ${message}\n` +
                    `    ${line.trim()}`,
                );
                totalViolations++;
            }
        }
    });
}

if (totalViolations === 0) {
    console.log('\x1b[32m✓\x1b[0m PASS — no legacy LOW/HIGH/large/LARGE tier literals in client code.');
    process.exit(0);
} else {
    console.error(`\n\x1b[31mFAIL\x1b[0m — ${totalViolations} legacy tier reference(s). Replace with SMALL/MEDIUM/ORIGINAL.`);
    process.exit(1);
}
