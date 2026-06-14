#!/usr/bin/env node
/**
 * Patch the `<meta name="crisp-sentry-dsn">` tag's content attribute
 * across every HTML entrypoint in the repo. Idempotent - re-running
 * with the same DSN is a no-op; re-running with empty string un-wires
 * Sentry. Intended to be called from the deploy pipeline AFTER the
 * tarball is unpacked into the docker-compose build context but BEFORE
 * `docker compose up`.
 *
 * Usage:
 *   SENTRY_DSN='https://abc123@o123.ingest.sentry.io/456' \
 *       node scripts/patch-sentry-dsn.mjs
 *   SENTRY_DSN='' node scripts/patch-sentry-dsn.mjs   # un-wire
 *   node scripts/patch-sentry-dsn.mjs --check          # gate: exits 1 if any
 *                                                       HTML's meta is still
 *                                                       empty (use in CI).
 *
 * Why a separate script (vs hand-editing 4 HTML files):
 *   · The four HTML files (PWA index + 3 dashboard pages) MUST stay
 *     in lockstep - partial wiring = inconsistent error capture.
 *   · sentry-init.js stays inert when content="" so we ship the
 *     source with empty values + patch at deploy. No DSN ever lands
 *     in git history that way.
 *   · Verification in CI: `--check` mode for the PROD smoke step to
 *     fail-fast if the patch didn't run.
 *
 * Privacy: Sentry DSN is a public-safe identifier (write-only ingest
 * key). Safe to ship to the browser; documented in docs/SECURITY.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const HTML_FILES = [
    "mobile-app/src/index.html",
    "web-dashboard/src/index.html",
    "web-dashboard/src/login.html",
    "web-dashboard/src/evidence.html",
];

const META_RE = /<meta\s+name=["']crisp-sentry-dsn["']\s+content=["'][^"']*["']\s*\/?>/;
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function fail(msg) { console.error(`${RED}✘${RESET} ${msg}`); }
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

const CHECK_ONLY = process.argv.includes("--check");
const dsn = (process.env.SENTRY_DSN || "").trim();

if (!CHECK_ONLY && !process.env.SENTRY_DSN) {
    // Allow explicit empty `SENTRY_DSN=''` to UN-WIRE; only fail if
    // the var isn't set at all (signals the operator forgot the env).
    fail("SENTRY_DSN env var is unset. Pass `SENTRY_DSN=''` to explicitly disable.");
    process.exit(2);
}

// Light DSN-format check - catches obvious typos. Real validation
// happens at Sentry's ingest endpoint.
if (dsn && !/^https:\/\/[a-f0-9]+@[a-z0-9.]+\.ingest(?:\.[a-z]+)?\.sentry\.io\/\d+$/.test(dsn)) {
    if (!CHECK_ONLY) {
        warn(`DSN format looks unusual: ${dsn.slice(0, 30)}...`);
        warn("Proceeding anyway - Sentry's ingest will reject if it's truly invalid.");
    }
}

let touched = 0;
let drifted = 0;
for (const relpath of HTML_FILES) {
    const fullpath = join(ROOT, relpath);
    const src = await readFile(fullpath, "utf8");
    const match = src.match(META_RE);
    if (!match) {
        fail(`${relpath}: no <meta name="crisp-sentry-dsn"> tag found`);
        process.exit(2);
    }
    const replacement = `<meta name="crisp-sentry-dsn" content="${dsn}">`;
    if (match[0] === replacement) continue;   // already in sync

    if (CHECK_ONLY) {
        // In --check we report drift; we don't write.
        const cur = match[0].match(/content=["']([^"']*)["']/)?.[1] ?? "";
        warn(`${relpath}: DSN drift (current="${cur || '(empty)'}", expected="${dsn || '(empty)'}")`);
        drifted++;
        continue;
    }
    const nextSrc = src.replace(META_RE, replacement);
    await writeFile(fullpath, nextSrc, "utf8");
    touched++;
}

if (CHECK_ONLY) {
    if (drifted > 0) {
        fail(`${drifted} HTML file(s) have a DSN that doesn't match $SENTRY_DSN`);
        process.exit(1);
    }
    ok(`all ${HTML_FILES.length} HTML files have crisp-sentry-dsn = "${dsn || '(empty, Sentry inert)'}"`);
    process.exit(0);
}

if (touched > 0) {
    ok(`patched ${touched} HTML file(s) with DSN = "${dsn || '(empty, Sentry inert)'}"`);
} else {
    ok(`all ${HTML_FILES.length} HTML files already in sync (no write needed)`);
}
