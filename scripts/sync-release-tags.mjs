#!/usr/bin/env node
/**
 * Sync Sentry `crisp-release` meta tags to the SW cache name.
 *
 * Phase 3.2 (May 2026) — Sentry release tagging keeps errors
 * bisectable: every event has a release ID that matches the deployed
 * build. The PWA's service worker already carries the canonical
 * build name (`CACHE_NAME = 'crisp-v198'`); the Sentry init reads
 * the release from a `<meta name="crisp-release">` tag in
 * index.html. Drift between SW and meta means Sentry events tag
 * incorrectly.
 *
 * This script reads both versions and keeps the meta tag in sync.
 * Idempotent — re-running with no changes exits 0 and emits no
 * diff.
 *
 *   node scripts/sync-release-tags.mjs           # update in place
 *   node scripts/sync-release-tags.mjs --check   # CI-friendly: exit
 *                                                # non-zero on drift
 *
 * Wired into CI so a PR that bumps SW but not the release tag fails.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CHECK_ONLY = process.argv.includes("--check");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let problems = 0;
let updates = 0;
function fail(msg) { console.error(`${RED}✘${RESET} ${msg}`); problems++; }
function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

async function readSwVersion(swPath, regex) {
    const text = await readFile(join(ROOT, swPath), "utf8");
    const m = text.match(regex);
    if (!m) {
        fail(`could not parse SW version from ${swPath} (regex ${regex})`);
        return null;
    }
    return m[1];
}

async function syncMetaTag(htmlPath, expectedTag) {
    const full = join(ROOT, htmlPath);
    let content;
    try {
        content = await readFile(full, "utf8");
    } catch (e) {
        fail(`could not read ${htmlPath}: ${e.message}`);
        return;
    }
    const tagRe = /<meta name="crisp-release" content="([^"]*)">/;
    const m = content.match(tagRe);
    if (!m) {
        warn(`${htmlPath}: no <meta name="crisp-release"> tag (skipping)`);
        return;
    }
    const current = m[1];
    if (current === expectedTag) {
        ok(`${htmlPath} already in sync (${expectedTag})`);
        return;
    }
    if (CHECK_ONLY) {
        fail(`${htmlPath}: release tag is "${current}", expected "${expectedTag}"`);
        return;
    }
    const updated = content.replace(tagRe, `<meta name="crisp-release" content="${expectedTag}">`);
    await writeFile(full, updated);
    updates++;
    ok(`${htmlPath}: ${current} → ${expectedTag}`);
}

// PWA: CACHE_NAME = 'crisp-vNNN' → release "crisp-pwa@vNNN"
const pwaVersion = await readSwVersion(
    "mobile-app/src/sw.js",
    /const CACHE_NAME\s*=\s*'(crisp-v\d+)'/,
);
if (pwaVersion) {
    const m = pwaVersion.match(/v\d+/);
    const tag = `crisp-pwa@${m[0]}`;
    await syncMetaTag("mobile-app/src/index.html", tag);
}

// Dashboard: APP_CACHE = 'crisp-app-vNN' → release "crisp-dashboard@vNN"
const dashVersion = await readSwVersion(
    "web-dashboard/src/sw.js",
    /const APP_CACHE\s*=\s*'(crisp-app-v\d+)'/,
);
if (dashVersion) {
    const m = dashVersion.match(/v\d+/);
    const tag = `crisp-dashboard@${m[0]}`;
    for (const html of [
        "web-dashboard/src/index.html",
        "web-dashboard/src/login.html",
        "web-dashboard/src/evidence.html",
    ]) {
        await syncMetaTag(html, tag);
    }
}

console.log("");
if (problems) {
    if (CHECK_ONLY) {
        console.error(
            `${RED}FAIL${RESET} — ${problems} release-tag(s) out of sync. ` +
            `Run without --check to fix.`,
        );
    } else {
        console.error(`${RED}FAIL${RESET} — ${problems} problem(s).`);
    }
    process.exit(1);
}
if (CHECK_ONLY) {
    console.log(`${GREEN}PASS${RESET} — all release tags in sync.`);
} else if (updates > 0) {
    console.log(`${GREEN}DONE${RESET} — updated ${updates} file(s).`);
} else {
    console.log(`${GREEN}PASS${RESET} — already in sync, nothing to do.`);
}
