#!/usr/bin/env node
/**
 * Sprint C.1 (May 2026) — Prune orphan CSS rule blocks.
 *
 * The home-stage redesign waves over the past two months left behind
 * a graveyard of CSS selectors whose corresponding HTML / JS class
 * references have since been removed:
 *
 *   - Phase 6 hero-card redesign  → `.home-hero-card`-related glow rules,
 *                                   `.hero-icon`, `.hero-title`, `.hero-sub`
 *   - Phase 6 rewards tile drop   → `.home-action-tile--rewards`
 *   - Phase 5.1 channels rewrite  → `.home-channel*` (replaced by
 *                                   `.home-channels-strip`), `.home-strip-icon`
 *   - Phase 4 welcome overlay     → `.welcome-*` family
 *   - Phase 4 roadmap drop        → `.roadmap-*`, `.rs-*` step markers
 *   - Phase 4 "how it works"      → `.home-how-*`, `.home-howitworks`
 *   - Phase 3 value props block   → `.home-value-*`, `.home-values`
 *   - Phase 2 hr-* reward chips   → `.hr-*` family
 *
 * Each rule below has been cross-checked against:
 *   - mobile-app/src/index.html (no `class="...orphan..."` reference)
 *   - mobile-app/src/*.js (no `className=`, no string-literal class)
 *   - The class doesn't appear as part of any compound selector (e.g.
 *     `.parent .orphan` would be ambiguous; pruning the standalone
 *     `.orphan { ... }` block doesn't touch compounds).
 *
 * The script removes ONLY top-level single-class rule blocks. Compound
 * selectors (`.a, .b`), descendant selectors (`.parent .child`), and
 * pseudo-class selectors (`.foo:hover`) are LEFT IN PLACE — safer
 * fallback. Some orphan-named compounds will linger; that's OK because
 * they collapse to harmless dead-CSS rather than visible bugs.
 *
 * Re-running this script is idempotent: if no orphans remain in the
 * source file, it exits 0 with no diff.
 *
 *   node scripts/prune-orphan-css.mjs           # prune in place
 *   node scripts/prune-orphan-css.mjs --check   # CI gate
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CSS_PATH = join(ROOT, "mobile-app/src/styles.css");

const CHECK_ONLY = process.argv.includes("--check");
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/**
 * Conservative orphan denylist — every class here has been manually
 * verified absent from index.html + every PWA JS module. Compound
 * selectors are intentionally NOT in this list because their behaviour
 * depends on the parent / sibling context.
 */
const ORPHAN_CLASSES = [
    // Phase 6 hero-card chrome removal (May 2026)
    "hero-icon",
    "hero-title",
    "hero-sub",
    "home-hero-sub",
    "home-title",
    // Phase 6 rewards tile drop
    "home-action-tile--rewards",
    // Phase 5.1 channels rewrite — old single-channel naming
    "home-channel",
    "home-channels",
    "home-channels-six",
    "home-strip-icon",
    "home-top-icon-btn",
    "home-section-eyebrow",
    "home-brandchip",
    "home-brand-actions",
    // Phase 4 welcome overlay (replaced by inline consent gate)
    "welcome-overlay",
    "welcome-sheet",
    "welcome-brand",
    "welcome-title",
    "welcome-lede",
    "welcome-tip",
    "welcome-trust",
    "welcome-recommend",
    "welcome-actions",
    "welcome-cta-primary",
    "welcome-cta-secondary",
    // Phase 4 roadmap drop (replaced by direct CTA)
    "roadmap",
    "roadmap-arrow",
    "roadmap-step",
    "rs-icon",
    "rs-label",
    "rs-step-num",
    // Phase 4 "how it works" section drop
    "home-how-step",
    "home-how-steps",
    "home-howitworks",
    "hw-icon",
    "hw-num",
    "hw-text",
    // Phase 3 value-props block drop
    "home-value",
    "home-value-icon",
    "home-value-icon-blur",
    "home-value-icon-offline",
    "home-value-icon-private",
    "home-value-sub",
    "home-value-text",
    "home-value-title",
    "home-values",
    "home-values--phase17",
    // Phase 4 hints / offline-banner replacements
    "home-offline-hint",
    "home-safety-hint",
    "offline-banner",
    // Phase 2 hr-* reward chip family (replaced by .home-badge-chip)
    "hr-chip-ok",
    "hr-chip-pending",
    "hr-chip-rejected",
    "hr-chip-resolved",
    "hr-chip-responding",
    "hr-chip-warn",
    "hr-lives",
    "hr-meta-green",
    "hr-reject-note",
    // Phase 2 devid card → replaced by .home-devid-* family
    "devid-actions",
    "devid-card",
    "devid-explainer",
    "devid-num",
];

function fail(msg) { console.error(`${RED}✘${RESET} ${msg}`); }
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

/**
 * Find a `}` that closes a CSS block opened at `openBraceIdx`. CSS
 * doesn't nest blocks at the top level (no nested rules in vanilla CSS;
 * we don't use Sass), so a single-pass brace match is enough. Returns
 * the index of the closing `}` or -1 if not found.
 */
function findClosingBrace(src, openBraceIdx) {
    let depth = 1;
    for (let i = openBraceIdx + 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Remove every TOP-LEVEL rule block whose selector is exactly
 * `.<className>` (no compound, no descendant, no pseudo). Preserves
 * compound rules like `.foo .className` or `.className:hover` which
 * may still serve other purposes.
 */
function pruneOrphan(src, className) {
    const re = new RegExp(`^\\.${className.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}\\s*\\{`, "gm");
    let removed = 0;
    let result = src;
    let m;
    while ((m = re.exec(result)) !== null) {
        const openIdx = m.index;
        const braceIdx = openIdx + m[0].length - 1;
        const closeIdx = findClosingBrace(result, braceIdx);
        if (closeIdx === -1) break;
        // Also swallow the trailing newline so the file doesn't grow blank lines.
        const after = closeIdx + 1 < result.length && result[closeIdx + 1] === "\n" ? closeIdx + 2 : closeIdx + 1;
        result = result.slice(0, openIdx) + result.slice(after);
        removed++;
        re.lastIndex = openIdx;
    }
    return { src: result, removed };
}

async function main() {
    const cssSrc = await readFile(CSS_PATH, "utf8");
    const originalBytes = cssSrc.length;
    let working = cssSrc;
    const report = {};
    for (const cls of ORPHAN_CLASSES) {
        const { src, removed } = pruneOrphan(working, cls);
        if (removed > 0) report[cls] = removed;
        working = src;
    }
    const totalRemoved = Object.values(report).reduce((a, b) => a + b, 0);
    const savedBytes = originalBytes - working.length;

    if (totalRemoved === 0) {
        ok("no orphan rule blocks found (CSS already pruned)");
        process.exit(0);
    }

    if (CHECK_ONLY) {
        fail(`orphan-CSS drift: ${totalRemoved} rule blocks pendling prune; re-run \`node scripts/prune-orphan-css.mjs\``);
        process.exit(1);
    }

    await writeFile(CSS_PATH, working, "utf8");
    ok(`pruned ${totalRemoved} orphan rule block(s) — saved ${savedBytes} bytes`);
    for (const [cls, n] of Object.entries(report)) {
        console.log(`    .${cls}: ${n} block(s) removed`);
    }
}

main().catch((e) => {
    fail(e.message);
    process.exit(2);
});
